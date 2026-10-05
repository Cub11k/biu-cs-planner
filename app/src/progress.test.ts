import type { AttemptFacts as Attempt } from "@biu-cs-planner/core";
import { expect, it } from "vitest";
import type { EditHistory, StateEdit } from "./edit.ts";
import { choosePrograms } from "./programs.ts";
import {
  pinCourseTo,
  readProgress,
  tickManualRequirement,
  unpinCourseFrom,
  untickManualRequirement,
  type ProgramProgress,
  type ProgressResult,
} from "./progress.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * Progress through the use case (#288): one read that solves for every chosen Program together and
 * evaluates each, and the four edits — Pin, unpin, tick, untick — each one guarded save and one
 * undo step. The Programs, their Requirements and the Attempts are invented (ADR-0006).
 */
const ALICE = { stateFile: "alice" } as const;
const REF = { kind: "state", name: "alice" } as const;

const CS = {
  schemaVersion: 1,
  program: { id: "cs", name: { he: "מדעי המחשב", en: "Computer Science" } },
  courses: [
    { number: "89-110", credits: 5 },
    { number: "89-320", credits: 3 },
  ],
  pools: [{ id: "cs", kind: "prefix", prefix: "89-" }],
  requirements: [
    { id: "intro", kind: "course", course: "89-110" },
    { id: "electives", kind: "credits", min: 6, pool: "cs" },
    { id: "hebrew", kind: "manual", text: { he: "הבעה עברית", en: "Hebrew expression" } },
  ],
};
const MATH = {
  schemaVersion: 1,
  program: { id: "math", name: { he: "מתמטיקה" } },
  courses: [{ number: "89-110", credits: 5 }],
  requirements: [
    { id: "intro", kind: "course", course: "89-110" },
    { id: "hebrew", kind: "manual", text: { he: "הבעה עברית" } },
  ],
};

const attempt = (courseNumber: string, status: Attempt["status"] = "passed"): Attempt => ({
  courseNumber,
  academicYear: 2027,
  semester: "fall",
  status,
});

async function ready(
  programs: { requirementsFile: string; track?: string }[],
  attempts: Attempt[] = [attempt("89-110"), attempt("89-320", "planned")],
): Promise<MemoryWorkspace> {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "requirements", name: "cs-2027" }, CS);
  workspace.seed({ kind: "requirements", name: "math-2027" }, MATH);
  workspace.seed(REF, { schemaVersion: 1, attempts, programs });
  return workspace;
}

const versionOf = async (workspace: MemoryWorkspace) =>
  (await workspace.readStateFile(REF))?.version;

function served(result: ProgressResult) {
  if (result.kind !== "served") throw new Error(`Progress came back ${result.reason}`);
  return result.view;
}

function evaluated(program: ProgramProgress | undefined) {
  if (program?.status !== "evaluated") throw new Error(`the Program was ${program?.status}`);
  return program;
}

const node = (program: ProgramProgress | undefined, id: string) => {
  const pending = [...evaluated(program).progress.requirements];
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (next.id === id) return next;
    pending.push(...next.children);
  }
  throw new Error(`no Requirement ${id}`);
};

const collecting = (): EditHistory & { edits: StateEdit[] } => {
  const edits: StateEdit[] = [];
  return { edits, push: (edit) => edits.push(edit), wrote: () => {} };
};

it("serves no Programs when none is chosen, and reads nothing it does not need", async () => {
  const workspace = await ready([]);

  expect(served(await readProgress(workspace, ALICE))).toEqual({
    programs: [],
    stoppedEarly: false,
    solverWarnings: [],
    programWarnings: [],
    pinWarnings: [],
  });
});

it("evaluates a single major in both lenses, with the Courses counting toward each node", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }]);

  const view = served(await readProgress(workspace, ALICE));

  const cs = evaluated(view.programs[0]);
  expect(cs.program).toEqual({ id: "cs", name: { he: "מדעי המחשב", en: "Computer Science" } });
  expect(node(cs, "intro").completed).toMatchObject({ status: "satisfied", courses: ["89-110"] });
  expect(node(cs, "electives").completed).toMatchObject({ status: "missing" });
  // with the planned Course, both together meet the electives — the solver's best for this lens
  expect(node(cs, "electives").projected).toMatchObject({
    status: "satisfied",
    courses: ["89-110", "89-320"],
    credits: { counted: 8, needed: 6 },
  });
  expect(node(cs, "hebrew")).toMatchObject({ kind: "manual", ticked: false });
  expect(cs.candidates).toEqual([
    { courseNumber: "89-110", requirementIds: ["intro", "electives"] },
    { courseNumber: "89-320", requirementIds: ["electives"] },
  ]);
});

it("evaluates both Programs of a double major, each against its own file", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }, { requirementsFile: "math-2027" }]);

  const view = served(await readProgress(workspace, ALICE));

  expect(view.programs.map((program) => program.status)).toEqual(["evaluated", "evaluated"]);
  // one Course, counted in one Program only by default: the solver chose where
  const counted = [node(view.programs[0], "intro"), node(view.programs[1], "intro")].filter(
    (requirement) => requirement.completed.status === "satisfied",
  );
  expect(counted).toHaveLength(1);
});

it("lists a chosen Program whose file is missing, unevaluated, with the Warning", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }, { requirementsFile: "physics" }]);

  const view = served(await readProgress(workspace, ALICE));

  expect(view.programs[1]).toEqual({ requirementsFile: "physics", status: "missing" });
  expect(view.programWarnings).toEqual([
    { kind: "program-file-missing", index: 1, requirementsFile: "physics" },
  ]);
});

it("pins a Course in one Program only, though the other uses the same Requirement id", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }, { requirementsFile: "math-2027" }]);
  const history = collecting();

  const view = served(
    await pinCourseTo(
      workspace,
      { courseNumber: "89-110", requirementsFile: "math-2027", requirementId: "intro" },
      { ...ALICE, basedOn: await versionOf(workspace), history },
    ),
  );

  expect(node(view.programs[1], "intro").completed.courses).toEqual(["89-110"]);
  expect(node(view.programs[0], "intro").completed.courses).toEqual([]);
  expect(evaluated(view.programs[1]).pins).toEqual([{ courseNumber: "89-110", requirementId: "intro" }]);
  expect(evaluated(view.programs[0]).pins).toEqual([]);
  expect(view.solverWarnings).toEqual([]);
  expect(history.edits.map((edit) => edit.label)).toEqual(["pin-course"]);
});

it("overrides the solver with a Pin, and lets it decide again once unpinned", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }], [attempt("89-110")]);

  const before = served(await readProgress(workspace, ALICE));
  expect(node(before.programs[0], "intro").completed.courses).toEqual(["89-110"]);

  const pinned = served(
    await pinCourseTo(
      workspace,
      { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "electives" },
      { ...ALICE, basedOn: await versionOf(workspace) },
    ),
  );
  expect(node(pinned.programs[0], "electives").completed.courses).toEqual(["89-110"]);
  expect(node(pinned.programs[0], "intro").completed.courses).toEqual([]);

  const unpinned = served(
    await unpinCourseFrom(
      workspace,
      { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "electives" },
      { ...ALICE, basedOn: await versionOf(workspace) },
    ),
  );
  expect(node(unpinned.programs[0], "intro").completed.courses).toEqual(["89-110"]);
  expect(evaluated(unpinned.programs[0]).pins).toEqual([]);
});

it("keeps a Pin the engine cannot honour, and says why", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }]);

  const view = served(
    await pinCourseTo(
      workspace,
      { courseNumber: "89-320", requirementsFile: "cs-2027", requirementId: "intro" },
      { ...ALICE, basedOn: await versionOf(workspace) },
    ),
  );

  expect(view.solverWarnings).toEqual([
    { kind: "pin-not-accepted", courseNumber: "89-320", requirementId: "intro" },
  ]);
  expect(evaluated(view.programs[0]).pins).toEqual([{ courseNumber: "89-320", requirementId: "intro" }]);
});

it("reads an older Pin with no file as the first Program's", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "requirements", name: "cs-2027" }, CS);
  workspace.seed({ kind: "requirements", name: "math-2027" }, MATH);
  workspace.seed(REF, {
    schemaVersion: 1,
    attempts: [attempt("89-110")],
    programs: [{ requirementsFile: "math-2027" }, { requirementsFile: "cs-2027" }],
    pins: [{ courseNumber: "89-110", requirementId: "intro" }],
  });

  const view = served(await readProgress(workspace, ALICE));

  expect(evaluated(view.programs[0]).pins).toEqual([{ courseNumber: "89-110", requirementId: "intro" }]);
  expect(evaluated(view.programs[1]).pins).toEqual([]);
  expect(node(view.programs[0], "intro").completed.courses).toEqual(["89-110"]);
});

it("warns about a Pin naming a file that is none of the student's Programs", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }]);
  await pinCourseTo(
    workspace,
    { courseNumber: "89-110", requirementsFile: "math-2027", requirementId: "intro" },
    { ...ALICE, basedOn: await versionOf(workspace) },
  );

  expect(served(await readProgress(workspace, ALICE)).pinWarnings).toEqual([
    {
      kind: "pin-file-not-chosen",
      courseNumber: "89-110",
      requirementId: "intro",
      requirementsFile: "math-2027",
    },
  ]);
});

it("ticks a Manual Requirement in one Program, and unticks it, one undo step each", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }, { requirementsFile: "math-2027" }]);
  const history = collecting();

  const ticked = served(
    await tickManualRequirement(
      workspace,
      { requirementsFile: "cs-2027", requirementId: "hebrew" },
      { ...ALICE, basedOn: await versionOf(workspace), history },
    ),
  );
  expect(node(ticked.programs[0], "hebrew")).toMatchObject({
    ticked: true,
    completed: { status: "satisfied" },
  });
  expect(node(ticked.programs[1], "hebrew")).toMatchObject({ ticked: false });

  const unticked = served(
    await untickManualRequirement(
      workspace,
      { requirementsFile: "cs-2027", requirementId: "hebrew" },
      { ...ALICE, basedOn: await versionOf(workspace), history },
    ),
  );
  expect(node(unticked.programs[0], "hebrew")).toMatchObject({ ticked: false });
  expect(history.edits.map((edit) => edit.label)).toEqual(["tick-manual", "untick-manual"]);
});

it("refuses a Pin based on a revision the file no longer holds", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }]);

  expect(
    await pinCourseTo(
      workspace,
      { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "intro" },
      { ...ALICE, basedOn: undefined },
    ),
  ).toMatchObject({ kind: "refused", reason: "state-file-changed" });
});

/**
 * #300's amendment: the solver's 250 ms cap applies only when it is handed a clock, and the use
 * case hands it one. A clock that has run past the cap by its second reading makes the search stop
 * at once, which is how a test can see that the clock reached the solver at all.
 */
it("hands the solver a clock, so its time cap applies to every read", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }], [attempt("89-110"), attempt("89-320")]);
  let reading = 0;
  const now = (): number => (reading++ === 0 ? 0 : 1_000_000);

  const view = served(await readProgress(workspace, { ...ALICE, now }));

  expect(reading).toBeGreaterThan(1);
  expect(view.stoppedEarly).toBe(true);
});

it("stops on nothing when the clock stands still", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }], [attempt("89-110"), attempt("89-320")]);

  expect(served(await readProgress(workspace, { ...ALICE, now: () => 0 })).stoppedEarly).toBe(false);
});

it("warns about a tick naming a file that is none of the student's Programs", async () => {
  const workspace = await ready([{ requirementsFile: "cs-2027" }]);
  await tickManualRequirement(
    workspace,
    { requirementsFile: "math-2027", requirementId: "hebrew" },
    { ...ALICE, basedOn: await versionOf(workspace) },
  );

  expect(served(await readProgress(workspace, ALICE)).pinWarnings).toEqual([
    { kind: "tick-file-not-chosen", requirementId: "hebrew", requirementsFile: "math-2027" },
  ]);
});
