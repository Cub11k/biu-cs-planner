import { describe, expect, it } from "vitest";
import type { EditHistory, StateEdit } from "./edit.ts";
import {
  addAttemptTo,
  moveAttemptTo,
  planFromSuggestedLayout,
  readPlan,
  removeAttemptFrom,
  updateAttemptOf,
} from "./plan.ts";
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

  it("counts a Manual Requirement ticked in this Program as met, and one ticked in another as not", async () => {
    const withManual = { ...CS, requirements: [{ id: "english", kind: "manual", text: { he: "אנגלית" } }] };
    const read = async (requirementsFile: string) => {
      const workspace = memoryWorkspace({ created: true });
      workspace.seed({ kind: "requirements", name: "cs-2027" }, withManual);
      workspace.seed(REF, {
        schemaVersion: 1,
        programs: [{ requirementsFile: "cs-2027" }],
        manualTicks: [{ requirementId: "english", requirementsFile }],
      });
      const result = await readPlan(workspace, ALICE);
      return result.kind === "served" ? result.view.planWarnings : undefined;
    };

    expect(await read("cs-2027")).toEqual([]);
    expect(await read("math-2027")).toMatchObject([{ kind: "requirements-missing", requirementIds: ["english"] }]);
  });

  it("honours the student's Pins in the missing-Requirements lens", async () => {
    const competing = {
      ...CS,
      pools: [{ id: "all", kind: "prefix", prefix: "89-" }],
      requirements: [
        { id: "electives", kind: "credits", min: 6, pool: "all" },
        { id: "intro", kind: "course", course: "89-110" },
      ],
    };
    const read = async (pins: unknown[]) => {
      const workspace = memoryWorkspace({ created: true });
      workspace.seed({ kind: "requirements", name: "cs-2027" }, competing);
      workspace.seed(REF, {
        schemaVersion: 1,
        programs: [{ requirementsFile: "cs-2027" }],
        attempts: [{ id: "a", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "planned" }],
        pins,
      });
      const result = await readPlan(workspace, ALICE);
      return result.kind === "served" ? result.view.planWarnings : undefined;
    };

    // one Course, two Requirements it could meet: the Pin decides which is left missing
    expect(await read([{ courseNumber: "89-110", requirementId: "electives", requirementsFile: "cs-2027" }])).toMatchObject([
      { kind: "requirements-missing", requirementIds: ["intro"] },
    ]);
    expect(await read([{ courseNumber: "89-110", requirementId: "intro", requirementsFile: "cs-2027" }])).toMatchObject([
      { kind: "requirements-missing", requirementIds: ["electives"] },
    ]);
  });

  it("names the Requirements a Plan leaves missing, read off the projected lens", async () => {
    const read = await readPlan(seeded({ programs: [{ requirementsFile: "cs-2027" }] }), ALICE);

    expect(read.kind === "served" && read.view.planWarnings).toEqual([
      { kind: "requirements-missing", target: { kind: "program", requirementsFile: "cs-2027" }, requirementIds: ["intro"] },
    ]);
  });
});

/**
 * #293: New Plan from Suggested Layout through the guarded writer — one save, one undo step, a
 * summary of what it created and skipped, and what it needs said rather than guessed. The layout
 * is invented (ADR-0006).
 */
describe("planFromSuggestedLayout", () => {
  const LAYOUT = {
    schemaVersion: 1,
    program: { id: "cs", name: { he: "מדעי המחשב" } },
    suggestedLayout: [
      { studyYear: 1, semester: "fall", courses: ["89-110", "88-101"] },
      { studyYear: 1, semester: "spring", courses: ["89-111"] },
    ],
    tracks: [{ id: "ai", name: { he: "בינה" }, suggestedLayout: [{ studyYear: 2, semester: "fall", courses: ["89-391"] }] }],
  };
  const MATH = {
    schemaVersion: 1,
    program: { id: "math", name: { he: "מתמטיקה" } },
    suggestedLayout: [{ studyYear: 1, semester: "fall", courses: ["88-132"] }],
  };
  const seeded = (state: Record<string, unknown>): MemoryWorkspace => {
    const workspace = memoryWorkspace({ created: true });
    workspace.seed({ kind: "requirements", name: "cs-2027" }, LAYOUT);
    workspace.seed({ kind: "requirements", name: "math-2027" }, MATH);
    workspace.seed({ kind: "requirements", name: "bare" }, { schemaVersion: 1, program: { id: "b", name: { he: "b" } } });
    workspace.seed(REF, { schemaVersion: 1, ...state });
    return workspace;
  };
  const cohort = { academicYear: 2027, semester: "fall" };

  it("creates the layout's Attempts in one save and one undo step, and summarises them", async () => {
    const workspace = seeded({
      cohort,
      programs: [{ requirementsFile: "cs-2027", track: "ai" }],
      attempts: [{ id: "x", courseNumber: "88-101", academicYear: 2026, semester: "summer", status: "passed" }],
    });
    const history = collecting();
    const before = workspace.written().length;

    const made = await planFromSuggestedLayout(workspace, {}, {
      ...ALICE,
      basedOn: await versionOf(workspace),
      history,
      newId: counting(),
    });

    expect(made).toMatchObject({
      kind: "served",
      summary: {
        created: [
          { id: "id-1", courseNumber: "89-110", academicYear: 2027, semester: "fall" },
          { id: "id-2", courseNumber: "89-111", academicYear: 2027, semester: "spring" },
          { id: "id-3", courseNumber: "89-391", academicYear: 2028, semester: "fall" },
        ],
        skipped: [{ courseNumber: "88-101", reason: "attempted" }],
      },
      view: { attempts: [{ id: "x" }, { id: "id-1" }, { id: "id-2" }, { id: "id-3" }] },
      version: await versionOf(workspace),
    });
    expect(workspace.written().length - before).toBe(1);
    expect(history.edits.map((edit) => edit.label)).toEqual(["plan-from-suggested-layout"]);
    // the one undo step puts back the Plan as it was, without any of the three
    expect(history.edits[0]?.previous.attempts.map((a) => a.id)).toEqual(["x"]);
  });

  it("uses the Program it is asked for, and refuses to guess one the student has not chosen", async () => {
    const workspace = seeded({ cohort, programs: [{ requirementsFile: "cs-2027" }, { requirementsFile: "math-2027" }] });

    const math = await planFromSuggestedLayout(workspace, { requirementsFile: "math-2027" }, {
      ...ALICE,
      basedOn: await versionOf(workspace),
      newId: counting(),
    });
    expect(math).toMatchObject({ kind: "served", summary: { created: [{ courseNumber: "88-132" }] } });

    const physics = await planFromSuggestedLayout(workspace, { requirementsFile: "physics" }, {
      ...ALICE,
      basedOn: await versionOf(workspace),
    });
    expect(physics).toMatchObject({ kind: "unavailable", reason: "program-not-chosen" });
  });

  it("says what it needs, writing nothing, rather than guessing", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ programs: [{ requirementsFile: "cs-2027" }] }, "cohort-not-chosen"],
      [{ cohort }, "program-not-chosen"],
      [{ cohort, programs: [{ requirementsFile: "missing" }] }, "requirements-file-unavailable"],
      [{ cohort, programs: [{ requirementsFile: "bare" }] }, "no-suggested-layout"],
    ];
    for (const [state, reason] of cases) {
      const workspace = seeded(state);
      const version = await versionOf(workspace);
      const before = workspace.written().length;

      const answer = await planFromSuggestedLayout(workspace, {}, { ...ALICE, basedOn: version });

      expect(answer, reason).toEqual({ kind: "unavailable", reason, version });
      expect(workspace.written()).toHaveLength(before);
    }
  });

  it("creates nothing and writes nothing the second time", async () => {
    const workspace = seeded({ cohort, programs: [{ requirementsFile: "cs-2027" }] });
    await planFromSuggestedLayout(workspace, {}, { ...ALICE, basedOn: await versionOf(workspace), newId: counting() });
    const before = workspace.written().length;

    const again = await planFromSuggestedLayout(workspace, {}, { ...ALICE, basedOn: await versionOf(workspace) });

    expect(again).toMatchObject({ kind: "served", summary: { created: [], skipped: [{}, {}, {}] } });
    expect(workspace.written()).toHaveLength(before);
  });

  it("is refused when based on a revision the file no longer holds", async () => {
    const workspace = seeded({ cohort, programs: [{ requirementsFile: "cs-2027" }] });
    const stale = await versionOf(workspace);
    await addAttemptTo(workspace, planned, { ...ALICE, basedOn: stale, newId: counting() });

    expect(await planFromSuggestedLayout(workspace, {}, { ...ALICE, basedOn: stale })).toMatchObject({
      kind: "refused",
      reason: "state-file-changed",
    });
  });
});
