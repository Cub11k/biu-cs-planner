import {
  CURRENT_CATALOG_SCHEMA_VERSION,
  parseStateFile,
  type Catalog,
  type Offering,
  type Semester,
  type State,
} from "@biu-cs-planner/core";
import { expect, it } from "vitest";
import type { EditHistory, StateEdit } from "./edit.ts";
import { DEFAULT_STATE_FILE, pickGroup, readTimetable, type TimetableRef } from "./picks.ts";
import { applyPlanDiffTo } from "./planDiffs.ts";
import { addCourseToTray } from "./tray.ts";
import { addVariant } from "./variants.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * Plan Diffs through the Workspace port (#295): carried by every Timetable answer for the Variant
 * shown, computed against the year's Catalog and the student's Requirements Files, and applied one
 * at a time through the one guarded writer — one save, one undo step, and the Plan's Attempts the
 * only thing it changes.
 *
 * Fixture data is invented. 89-110, 89-210 and 89-230 are real BIU course numbers, which Semester
 * each is given in is not, and no crawled data is committed to this repo (ADR-0006).
 */
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const REF = { kind: "state", name: DEFAULT_STATE_FILE } as const;

const offering = (courseNumber: string, ...semesters: Semester[]): Offering => ({
  courseNumber,
  nameHebrew: courseNumber,
  credits: { known: true, total: 5 },
  semesters,
  groups: [{ number: "01", lessonType: "הרצאה", lecturers: [], meetings: [] }],
  exams: { known: false, sittings: [] },
});

const CATALOG: Catalog = {
  schemaVersion: CURRENT_CATALOG_SCHEMA_VERSION,
  academicYear: 2027,
  sources: [],
  offerings: [offering("89-110", "fall"), offering("89-210", "fall"), offering("89-230", "spring")],
};

const planned = (id: string, courseNumber: string, semester: Semester = "fall") => ({
  id,
  courseNumber,
  academicYear: 2027,
  semester,
  status: "planned",
});

/** A Workspace with the Catalog and a State File holding these Attempts. */
function ready(attempts: unknown[], extra: Record<string, unknown> = {}): MemoryWorkspace {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "catalog", academicYear: 2027 }, CATALOG);
  workspace.seed(REF, { schemaVersion: 1, attempts, ...extra });
  return workspace;
}

async function stored(workspace: MemoryWorkspace): Promise<State> {
  return parseStateFile((await workspace.readStateFile(REF))?.data).state!;
}

const collecting = (): EditHistory & { edits: StateEdit[] } => {
  const edits: StateEdit[] = [];
  return { edits, push: (edit) => edits.push(edit), wrote: () => {} };
};

async function now(workspace: MemoryWorkspace, at: TimetableRef = FALL_2027) {
  const read = await readTimetable(workspace, at);
  return { basedOn: read.kind === "served" ? read.version : undefined };
}

const diffsOf = (result: { kind: string; view?: { planDiffs: unknown } }) =>
  result.kind === "served" ? result.view?.planDiffs : undefined;

it("carries the Plan Diffs of the Variant shown in the Timetable read", async () => {
  const workspace = ready([planned("a1", "89-110"), planned("a2", "89-230")]);
  await addCourseToTray(workspace, FALL_2027, "89-210", await now(workspace));

  expect(diffsOf(await readTimetable(workspace, FALL_2027))).toEqual([
    { kind: "drop", courseNumber: "89-110", academicYear: 2027, semester: "fall", attemptIds: ["a1"] },
    { kind: "move", courseNumber: "89-230", academicYear: 2027, semester: "fall", to: "spring", attemptIds: ["a2"] },
    { kind: "add", courseNumber: "89-210", academicYear: 2027, semester: "fall", semesters: ["fall"] },
  ]);
});

it("computes them against the Variant asked for, so each alternative has its own", async () => {
  const workspace = ready([planned("a1", "89-110")]);
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));
  await addVariant(workspace, FALL_2027, { name: "B" }, await now(workspace));

  expect(diffsOf(await readTimetable(workspace, { ...FALL_2027, variant: "A" }))).toEqual([]);
  expect(diffsOf(await readTimetable(workspace, { ...FALL_2027, variant: "B" }))).toEqual([
    { kind: "drop", courseNumber: "89-110", academicYear: 2027, semester: "fall", attemptIds: ["a1"] },
  ]);
});

it("serves no Plan Diffs to a student with no Plan, and reads no Catalog for them", async () => {
  const workspace = ready([{ ...planned("a1", "89-110"), status: "passed" }]);
  await addCourseToTray(workspace, FALL_2027, "89-210", await now(workspace));
  const reading = workspace.read.bind(workspace);
  let catalogReads = 0;
  workspace.read = (ref) => {
    if (ref.kind === "catalog") catalogReads += 1;
    return reading(ref);
  };

  const read = await readTimetable(workspace, FALL_2027);

  expect(diffsOf(read)).toEqual([]);
  // the Tray's own chips read the Catalog once; nothing more is read for Plan Diffs
  expect(catalogReads).toBe(1);
});

it("reports adds and drops but no move without a Catalog for the year", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed(REF, { schemaVersion: 1, attempts: [planned("a1", "89-230")] });

  expect(diffsOf(await readTimetable(workspace, FALL_2027))).toEqual([
    { kind: "drop", courseNumber: "89-230", academicYear: 2027, semester: "fall", attemptIds: ["a1"] },
  ]);
});

it("applies the Equivalences of the student's Requirements Files", async () => {
  const workspace = ready([planned("a1", "89-100")], { programs: [{ requirementsFile: "cs-2027" }] });
  workspace.seed(
    { kind: "requirements", name: "cs-2027" },
    {
      schemaVersion: 1,
      program: { id: "cs", name: { he: "מדעי המחשב" } },
      equivalences: [{ from: "89-100", to: "89-110" }],
    },
  );
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));

  expect(diffsOf(await readTimetable(workspace, FALL_2027))).toEqual([]);
});

it("applies an add as a planned Attempt, one save and one undo step, and leaves the Timetable", async () => {
  const workspace = ready([planned("a1", "89-110")]);
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));
  await addCourseToTray(workspace, FALL_2027, "89-210", await now(workspace));
  const before = await stored(workspace);
  const history = collecting();

  const result = await applyPlanDiffTo(
    workspace,
    FALL_2027,
    { kind: "add", courseNumber: "89-210" },
    { ...(await now(workspace)), history, newId: () => "new-1" },
  );

  expect(result.kind).toBe("served");
  expect(diffsOf(result as never)).toEqual([]);
  const after = await stored(workspace);
  expect(after.attempts).toEqual([...before.attempts, { ...planned("new-1", "89-210") }]);
  expect(after.timetables).toEqual(before.timetables);
  expect(history.edits.map((edit) => edit.label)).toEqual(["apply-plan-diff-add"]);
  // and what undo would put back is the Plan before the apply
  expect(history.edits[0]?.previous.attempts).toEqual(before.attempts);
});

it("applies a drop and a move to the Attempts they name", async () => {
  const workspace = ready([planned("a1", "89-110"), planned("a2", "89-230")]);
  await addVariant(workspace, FALL_2027, { name: "A" }, await now(workspace));

  const dropped = await applyPlanDiffTo(workspace, FALL_2027, { kind: "drop", courseNumber: "89-110" }, await now(workspace));
  expect(dropped.kind).toBe("served");
  const moved = await applyPlanDiffTo(workspace, FALL_2027, { kind: "move", courseNumber: "89-230" }, await now(workspace));
  expect(moved.kind).toBe("served");

  expect((await stored(workspace)).attempts).toEqual([planned("a2", "89-230", "spring")]);
  expect(diffsOf(moved as never)).toEqual([]);
});

it("refuses a Plan Diff that is no longer there as stale, and writes nothing", async () => {
  const workspace = ready([planned("a1", "89-110")]);
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));
  const { basedOn } = await now(workspace);
  const written = workspace.written().length;
  const history = collecting();

  const result = await applyPlanDiffTo(workspace, FALL_2027, { kind: "drop", courseNumber: "89-110" }, { basedOn, history });

  expect(result).toEqual({ kind: "plan-diff-stale", version: basedOn, warnings: [] });
  expect(workspace.written()).toHaveLength(written);
  expect(history.edits).toEqual([]);
});

it("refuses an apply based on a revision the file no longer holds, and writes nothing", async () => {
  const workspace = ready([planned("a1", "89-110")]);
  const { basedOn } = await now(workspace);
  await addVariant(workspace, FALL_2027, { name: "A" }, { basedOn });
  const written = workspace.written().length;

  const result = await applyPlanDiffTo(workspace, FALL_2027, { kind: "drop", courseNumber: "89-110" }, { basedOn });

  expect(result).toMatchObject({ kind: "refused", reason: "state-file-changed" });
  expect(workspace.written()).toHaveLength(written);
});

it("follows a Pick with the Plan Diffs it settles, in the Pick's own answer", async () => {
  const workspace = ready([planned("a1", "89-110")]);

  const picked = await pickGroup(
    workspace,
    FALL_2027,
    { courseNumber: "89-110", lessonType: "הרצאה", groupNumber: "01", meetings: [] },
    await now(workspace),
  );

  expect(diffsOf(picked)).toEqual([]);
});
