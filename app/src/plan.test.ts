import { describe, expect, it } from "vitest";
import type { EditHistory, StateEdit } from "./edit.ts";
import { addAttemptTo, moveAttemptTo, readPlan, removeAttemptFrom, updateAttemptOf } from "./plan.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * The Plan through the guarded writer (#290): the Attempts read in one domain read, and add,
 * update, move and remove, each one guarded save and one undo step, refused only when the file
 * moved underneath. Course numbers are invented (ADR-0006).
 */
const ALICE = { stateFile: "alice" } as const;
const REF = { kind: "state", name: "alice" } as const;

const versionOf = async (workspace: MemoryWorkspace) => (await workspace.readStateFile(REF))?.version;

/** A history that only collects, so a test can say what an undo would restore. */
const collecting = (): EditHistory & { edits: StateEdit[] } => {
  const edits: StateEdit[] = [];
  return { edits, push: (edit) => edits.push(edit), wrote: () => {} };
};

function counting(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

const planned = { courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "planned" } as const;

describe("readPlan", () => {
  it("serves no Attempts and writes nothing when there is no State File", async () => {
    const workspace = memoryWorkspace({ created: true });

    expect(await readPlan(workspace, ALICE)).toEqual({
      kind: "served",
      view: { attempts: [], attemptWarnings: [], planWarnings: [] },
      version: undefined,
      warnings: [],
    });
    expect(workspace.written()).toEqual([]);
  });

  it("serves a file's Attempts with ids, even one written before Attempts had them", async () => {
    const workspace = memoryWorkspace({ created: true });
    workspace.seed(REF, { schemaVersion: 1, attempts: [planned, { ...planned, semester: "spring" }] });

    const read = await readPlan(workspace, ALICE);

    expect(read).toMatchObject({
      kind: "served",
      view: {
        attempts: [
          { id: "attempt-1", ...planned },
          { id: "attempt-2", ...planned, semester: "spring" },
        ],
      },
      version: await versionOf(workspace),
    });
  });

  it("refuses a State File it cannot read, rather than serving an empty Plan over it", async () => {
    const workspace = memoryWorkspace({ created: true });
    workspace.seed(REF, { notAStateFile: true });

    expect(await readPlan(workspace, ALICE)).toMatchObject({ kind: "refused", reason: "state-file-unreadable" });
  });
});

it("adds an Attempt with an injected id, names it in the answer, saves it and is one undo step", async () => {
  const workspace = memoryWorkspace({ created: true });
  const history = collecting();

  const added = await addAttemptTo(workspace, planned, {
    ...ALICE,
    basedOn: undefined,
    history,
    newId: counting(),
  });

  expect(added).toMatchObject({
    kind: "served",
    added: "id-1",
    view: { attempts: [{ id: "id-1", ...planned }], attemptWarnings: [] },
    version: await versionOf(workspace),
  });
  expect((await workspace.readStateFile(REF))?.data).toMatchObject({ attempts: [{ id: "id-1", ...planned }] });
  expect(history.edits.map((edit) => edit.label)).toEqual(["add-attempt"]);
  expect(history.edits[0]?.previous.attempts).toEqual([]);
});

it("gives a new Attempt a UUID when no id source is injected", async () => {
  const workspace = memoryWorkspace({ created: true });

  const added = await addAttemptTo(workspace, planned, { ...ALICE, basedOn: undefined });

  expect(added.kind === "served" && added.added).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

it("updates, moves and removes the Attempt its id names, each its own undo step", async () => {
  const workspace = memoryWorkspace({ created: true });
  const history = collecting();
  const newId = counting();
  let result = await addAttemptTo(workspace, planned, { ...ALICE, basedOn: undefined, history, newId });
  result = await addAttemptTo(workspace, { ...planned, courseNumber: "89-111" }, {
    ...ALICE,
    basedOn: await versionOf(workspace),
    history,
    newId,
  });

  result = await updateAttemptOf(workspace, "id-1", { status: "passed", grade: { kind: "numeric", value: 92 } }, {
    ...ALICE,
    basedOn: await versionOf(workspace),
    history,
  });
  result = await moveAttemptTo(workspace, "id-2", { academicYear: 2028, semester: "spring" }, {
    ...ALICE,
    basedOn: await versionOf(workspace),
    history,
  });
  expect(result).toMatchObject({
    view: {
      attempts: [
        { id: "id-1", status: "passed", grade: { kind: "numeric", value: 92 } },
        { id: "id-2", courseNumber: "89-111", academicYear: 2028, semester: "spring" },
      ],
    },
  });

  result = await removeAttemptFrom(workspace, "id-1", { ...ALICE, basedOn: await versionOf(workspace), history });
  expect(result).toMatchObject({ view: { attempts: [{ id: "id-2" }] } });
  expect(history.edits.map((edit) => edit.label)).toEqual([
    "add-attempt",
    "add-attempt",
    "update-attempt",
    "move-attempt",
    "remove-attempt",
  ]);
});

it("accepts a suspicious entry and answers with its Warning rather than refusing it", async () => {
  const workspace = memoryWorkspace({ created: true });

  const added = await addAttemptTo(workspace, { ...planned, grade: { kind: "numeric", value: 140 } }, {
    ...ALICE,
    basedOn: undefined,
    newId: counting(),
  });

  expect(added).toMatchObject({
    kind: "served",
    view: {
      attempts: [{ id: "id-1" }],
      attemptWarnings: [
        { kind: "grade-out-of-range", target: { kind: "attempt", id: "id-1" }, value: 140 },
        { kind: "grade-not-completed", target: { kind: "attempt", id: "id-1" }, status: "planned" },
      ],
    },
  });
});

it("refuses an edit based on a revision the file no longer holds, and writes nothing", async () => {
  const workspace = memoryWorkspace({ created: true });
  await addAttemptTo(workspace, planned, { ...ALICE, basedOn: undefined, newId: counting() });
  const stale = await versionOf(workspace);
  await updateAttemptOf(workspace, "id-1", { status: "registered" }, { ...ALICE, basedOn: stale });
  const written = workspace.written().length;

  const refused = await removeAttemptFrom(workspace, "id-1", { ...ALICE, basedOn: stale });

  expect(refused).toMatchObject({ kind: "refused", reason: "state-file-changed" });
  expect(workspace.written()).toHaveLength(written);
});

it("writes nothing for an edit that changes nothing, and still serves the revision", async () => {
  const workspace = memoryWorkspace({ created: true });
  await addAttemptTo(workspace, planned, { ...ALICE, basedOn: undefined, newId: counting() });
  const version = await versionOf(workspace);
  const written = workspace.written().length;

  const unchanged = await moveAttemptTo(workspace, "id-1", { academicYear: 2027, semester: "fall" }, {
    ...ALICE,
    basedOn: version,
  });

  expect(unchanged).toMatchObject({ kind: "served", version });
  expect(workspace.written()).toHaveLength(written);
});

/**
 * #291: every Plan answer carries the Plan checks against the chosen Programs' Requirements Files,
 * at the student's own credit load limit. The Requirements File is invented (ADR-0006).
 */
describe("the Plan checks in the answer", () => {
  const CS = {
    schemaVersion: 1,
    program: { id: "cs", name: { he: "מדעי המחשב" } },
    courses: [
      { number: "89-110", credits: 6, offeringPattern: "fall" },
      { number: "89-111", credits: 6, prerequisites: { kind: "passed", course: "89-110" } },
    ],
    requirements: [{ id: "intro", kind: "course", course: "89-110" }],
  };
  const seeded = (state: Record<string, unknown>): MemoryWorkspace => {
    const workspace = memoryWorkspace({ created: true });
    workspace.seed({ kind: "requirements", name: "cs-2027" }, CS);
    workspace.seed(REF, { schemaVersion: 1, ...state });
    return workspace;
  };

  it("serves the Plan checks of the chosen Program, each pointing at its Attempt", async () => {
    const workspace = seeded({
      programs: [{ requirementsFile: "cs-2027" }],
      attempts: [
        { id: "a", courseNumber: "89-110", academicYear: 2027, semester: "spring", status: "planned" },
        { id: "b", courseNumber: "89-111", academicYear: 2027, semester: "spring", status: "planned" },
      ],
    });

    const read = await readPlan(workspace, ALICE);

    expect(read.kind === "served" && read.view.planWarnings).toEqual([
      {
        kind: "prerequisite-unmet",
        target: { kind: "attempt", id: "b" },
        requirementsFile: "cs-2027",
        courseNumber: "89-111",
        missing: ["89-110"],
        reliesOn: [],
      },
      {
        kind: "offering-pattern",
        target: { kind: "attempt", id: "a" },
        requirementsFile: "cs-2027",
        courseNumber: "89-110",
        pattern: "fall",
      },
    ]);
  });

  it("checks credit load at the limit the State File stores", async () => {
    const attempts = [
      { id: "a", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "planned" },
      { id: "b", courseNumber: "89-111", academicYear: 2028, semester: "fall", status: "planned" },
    ];
    const generous = await readPlan(seeded({ programs: [{ requirementsFile: "cs-2027" }], attempts }), ALICE);
    const strict = await readPlan(
      seeded({ programs: [{ requirementsFile: "cs-2027" }], attempts, settings: { creditLoadLimit: 5 } }),
      ALICE,
    );

    const loads = (result: typeof generous) =>
      result.kind === "served" ? result.view.planWarnings.filter((w) => w.kind === "credit-load") : [];
    expect(loads(generous)).toEqual([]);
    expect(loads(strict)).toEqual([
      { kind: "credit-load", target: { kind: "semester", academicYear: 2027, semester: "fall" }, credits: 6, limit: 5 },
      { kind: "credit-load", target: { kind: "semester", academicYear: 2028, semester: "fall" }, credits: 6, limit: 5 },
    ]);
  });

  it("runs no Requirements-based check with no Program chosen, or for a file the Workspace lacks", async () => {
    const attempts = [{ id: "b", courseNumber: "89-111", academicYear: 2027, semester: "fall", status: "planned" }];

    for (const programs of [[], [{ requirementsFile: "math-2027" }]]) {
      const read = await readPlan(seeded({ programs, attempts }), ALICE);
      expect(read.kind === "served" && read.view.planWarnings).toEqual([]);
    }
  });

  it("names the Requirements a Plan leaves missing, read off the projected lens", async () => {
    const read = await readPlan(seeded({ programs: [{ requirementsFile: "cs-2027" }] }), ALICE);

    expect(read.kind === "served" && read.view.planWarnings).toEqual([
      { kind: "requirements-missing", target: { kind: "program", requirementsFile: "cs-2027" }, requirementIds: ["intro"] },
    ]);
  });
});
