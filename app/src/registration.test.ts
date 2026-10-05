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
import { DEFAULT_STATE_FILE, readTimetable, type TimetableRef } from "./picks.ts";
import { markVariantRegistered, readRegistration, unmarkVariantRegistered } from "./registration.ts";
import { addCourseToTray } from "./tray.ts";
import { addVariant } from "./variants.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * Marking a Variant registered through the Workspace port (#297): the preview, the mark with and
 * without "apply all" — one guarded save and one undo step either way — and the unmark, which
 * leaves the Plan alone.
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

const planned = (id: string, courseNumber: string) => ({
  id,
  courseNumber,
  academicYear: 2027,
  semester: "fall",
  status: "planned",
});

async function now(workspace: MemoryWorkspace, at: TimetableRef = FALL_2027) {
  const read = await readTimetable(workspace, at);
  return { basedOn: read.kind === "served" ? read.version : undefined };
}

async function stored(workspace: MemoryWorkspace): Promise<State> {
  return parseStateFile((await workspace.readStateFile(REF))?.data).state!;
}

const collecting = (): EditHistory & { edits: StateEdit[] } => {
  const edits: StateEdit[] = [];
  return { edits, push: (edit) => edits.push(edit), wrote: () => {} };
};

/** A Fall Plan of 89-110 and 89-230, Variant A holding 89-110 and 89-210, and an empty Variant B. */
async function ready(): Promise<MemoryWorkspace> {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "catalog", academicYear: 2027 }, CATALOG);
  workspace.seed(REF, { schemaVersion: 1, attempts: [planned("a1", "89-110"), planned("a2", "89-230")] });
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));
  await addCourseToTray(workspace, FALL_2027, "89-210", await now(workspace));
  await addVariant(workspace, FALL_2027, { name: "B" }, await now(workspace));
  return workspace;
}

const A = { ...FALL_2027, variant: "A" } as const;
const B = { ...FALL_2027, variant: "B" } as const;

it("previews the Plan Diffs and the registered statuses, and writes nothing", async () => {
  const workspace = await ready();
  const written = workspace.written().length;

  const preview = await readRegistration(workspace, A);

  expect(preview).toMatchObject({
    kind: "served",
    variantName: "A",
    variantPosition: 0,
    registers: ["89-110", "89-210"],
    version: (await now(workspace)).basedOn,
  });
  expect(preview.kind === "served" && preview.planDiffs.map((d) => [d.kind, d.courseNumber])).toEqual([
    ["move", "89-230"],
    ["add", "89-210"],
  ]);
  expect(workspace.written()).toHaveLength(written);
});

it("marks only, leaving the Plan, when the student declines the offer", async () => {
  const workspace = await ready();
  const before = await stored(workspace);
  const history = collecting();

  const result = await markVariantRegistered(workspace, B, { applyDiffs: false }, { ...(await now(workspace)), history });

  expect(result.kind === "served" && result.view.variants).toEqual([
    { name: "A", primary: false },
    { name: "B", primary: true, registered: true },
  ]);
  expect((await stored(workspace)).attempts).toEqual(before.attempts);
  expect(history.edits.map((edit) => edit.label)).toEqual(["mark-variant-registered"]);
});

it("applies all and registers in one save and one undo step when the student accepts", async () => {
  const workspace = await ready();
  const before = await stored(workspace);
  const written = workspace.written().length;
  const history = collecting();

  const result = await markVariantRegistered(
    workspace,
    A,
    { applyDiffs: true },
    { ...(await now(workspace)), history, newId: () => "new-1" },
  );

  expect(result.kind).toBe("served");
  expect((await stored(workspace)).attempts.map((a) => [a.id, a.courseNumber, a.semester, a.status])).toEqual([
    ["a1", "89-110", "fall", "registered"],
    ["a2", "89-230", "spring", "planned"],
    ["new-1", "89-210", "fall", "registered"],
  ]);
  expect(workspace.written()).toHaveLength(written + 1);
  expect(history.edits).toHaveLength(1);
  // the one step undo would take puts back the whole Plan and the Variants as they were
  expect(history.edits[0]?.previous.attempts).toEqual(before.attempts);
  expect(history.edits[0]?.previous.timetables).toEqual(before.timetables);
});

it("refuses the whole mark on a stale revision, and writes none of it", async () => {
  const workspace = await ready();
  const { basedOn } = await now(workspace);
  await addVariant(workspace, FALL_2027, { name: "C" }, { basedOn });
  const written = workspace.written().length;

  const result = await markVariantRegistered(workspace, A, { applyDiffs: true }, { basedOn });

  expect(result).toMatchObject({ kind: "refused", reason: "state-file-changed" });
  expect(workspace.written()).toHaveLength(written);
});

it("unmarks the Variant and leaves what the mark did to the Plan", async () => {
  const workspace = await ready();
  await markVariantRegistered(workspace, A, { applyDiffs: true }, await now(workspace));
  const marked = await stored(workspace);

  const result = await unmarkVariantRegistered(workspace, A, await now(workspace));

  expect(result.kind === "served" && result.view.variants).toEqual([
    { name: "A", primary: true },
    { name: "B", primary: false },
  ]);
  expect((await stored(workspace)).attempts).toEqual(marked.attempts);
});
