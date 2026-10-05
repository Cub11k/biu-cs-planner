import { expect, it } from "vitest";
import type { EditHistory, StateEdit } from "./edit.ts";
import { chooseCohort, choosePrograms, readPrograms } from "./programs.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";
import { WorkspaceRefusedError } from "./workspace.ts";

/**
 * The student's Cohort and Programs through the guarded writer (#287): read, set, and the
 * Warnings for a Programs entry the Workspace cannot honour — never a refusal of the choice.
 *
 * File names and Track ids are invented (ADR-0006).
 */
const ALICE = { stateFile: "alice" } as const;
const REF = { kind: "state", name: "alice" } as const;

const CS = {
  schemaVersion: 1,
  program: { id: "cs", name: { he: "מדעי המחשב" } },
  tracks: [{ id: "ai", name: { he: "בינה מלאכותית" } }],
};

const ready = (): MemoryWorkspace => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "requirements", name: "cs-2027" }, CS);
  return workspace;
};

const versionOf = async (workspace: MemoryWorkspace) =>
  (await workspace.readStateFile(REF))?.version;

/** A history that only collects, so a test can say what an undo would restore. */
const collecting = (): EditHistory & { edits: StateEdit[] } => {
  const edits: StateEdit[] = [];
  return { edits, push: (edit) => edits.push(edit), wrote: () => {} };
};

it("serves no Cohort and no Program before any is chosen, and writes nothing", async () => {
  const workspace = ready();

  expect(await readPrograms(workspace, ALICE)).toEqual({
    kind: "served",
    view: { cohort: undefined, programs: [], programWarnings: [] },
    version: undefined,
    warnings: [],
  });
  expect(workspace.written()).toEqual([]);
});

it("sets the Programs, keeps them in the State File, and serves them back", async () => {
  const workspace = ready();

  const set = await choosePrograms(workspace, [{ requirementsFile: "cs-2027", track: "ai" }], {
    ...ALICE,
    basedOn: undefined,
  });

  expect(set).toMatchObject({
    kind: "served",
    view: { programs: [{ requirementsFile: "cs-2027", track: "ai" }], programWarnings: [] },
  });
  expect((await workspace.readStateFile(REF))?.data).toMatchObject({
    programs: [{ requirementsFile: "cs-2027", track: "ai" }],
  });
  expect(await readPrograms(workspace, ALICE)).toMatchObject({
    view: { programs: [{ requirementsFile: "cs-2027", track: "ai" }] },
    version: await versionOf(workspace),
  });
});

it("sets the Cohort and clears it again, one undo step each", async () => {
  const workspace = ready();
  const history = collecting();

  const set = await chooseCohort(
    workspace,
    { academicYear: 2026, semester: "fall" },
    { ...ALICE, basedOn: undefined, history },
  );
  expect(set).toMatchObject({ view: { cohort: { academicYear: 2026, semester: "fall" } } });

  const cleared = await chooseCohort(workspace, undefined, {
    ...ALICE,
    basedOn: await versionOf(workspace),
    history,
  });
  expect(cleared).toMatchObject({ view: { cohort: undefined } });
  expect(history.edits.map((edit) => edit.label)).toEqual(["set-cohort", "set-cohort"]);
  expect(history.edits[1]?.previous.cohort).toEqual({ academicYear: 2026, semester: "fall" });
});

it("labels a change of Programs as its own undo step", async () => {
  const workspace = ready();
  const history = collecting();

  await choosePrograms(workspace, [{ requirementsFile: "cs-2027" }], {
    ...ALICE,
    basedOn: undefined,
    history,
  });

  expect(history.edits.map((edit) => edit.label)).toEqual(["set-programs"]);
  expect(history.edits[0]?.previous.programs).toEqual([]);
});

it("keeps a Program whose file is not in the Workspace, and warns about it", async () => {
  const workspace = ready();

  const set = await choosePrograms(
    workspace,
    [{ requirementsFile: "cs-2027", track: "robotics" }, { requirementsFile: "math-2027" }],
    { ...ALICE, basedOn: undefined },
  );

  expect(set).toMatchObject({
    kind: "served",
    view: {
      programs: [{ requirementsFile: "cs-2027", track: "robotics" }, { requirementsFile: "math-2027" }],
      programWarnings: [
        { kind: "program-track-unknown", index: 0, requirementsFile: "cs-2027", track: "robotics" },
        { kind: "program-file-missing", index: 1, requirementsFile: "math-2027" },
      ],
    },
  });
});

it("warns again once a chosen file is taken out of the folder", async () => {
  const workspace = ready();
  await choosePrograms(workspace, [{ requirementsFile: "cs-2027" }], { ...ALICE, basedOn: undefined });

  workspace.remove({ kind: "requirements", name: "cs-2027" });

  expect(await readPrograms(workspace, ALICE)).toMatchObject({
    view: {
      programs: [{ requirementsFile: "cs-2027" }],
      programWarnings: [{ kind: "program-file-missing", index: 0, requirementsFile: "cs-2027" }],
    },
  });
});

it("says the folder could not be listed rather than calling every Program missing", async () => {
  const base = ready();
  await choosePrograms(base, [{ requirementsFile: "cs-2027" }], { ...ALICE, basedOn: undefined });
  const workspace = {
    ...base,
    list: async () => {
      throw new WorkspaceRefusedError(
        { reason: "not-a-folder", subject: { kind: "folder", folder: "requirements" } },
        "no",
      );
    },
  };

  expect(await readPrograms(workspace, ALICE)).toMatchObject({
    view: { programWarnings: [{ kind: "requirements-unlisted" }] },
  });
});

it("refuses a change based on a revision the file no longer holds", async () => {
  const workspace = ready();
  await choosePrograms(workspace, [{ requirementsFile: "cs-2027" }], { ...ALICE, basedOn: undefined });

  expect(
    await choosePrograms(workspace, [], { ...ALICE, basedOn: undefined }),
  ).toMatchObject({ kind: "refused", reason: "state-file-changed" });
});

it("refuses to write a Program into a folder that is not a Workspace yet", async () => {
  const workspace = memoryWorkspace();

  expect(
    await chooseCohort(workspace, { academicYear: 2026, semester: "fall" }, {
      ...ALICE,
      basedOn: undefined,
    }),
  ).toMatchObject({ kind: "refused", reason: "workspace-not-ready" });
});

it("serves an unchanged choice with the revision the file still holds, and saves nothing", async () => {
  const workspace = ready();
  await choosePrograms(workspace, [{ requirementsFile: "cs-2027" }], { ...ALICE, basedOn: undefined });
  const version = await versionOf(workspace);
  const writes = workspace.written().length;

  expect(
    await choosePrograms(workspace, [{ requirementsFile: "cs-2027" }], { ...ALICE, basedOn: version }),
  ).toMatchObject({ kind: "served", version });
  expect(workspace.written()).toHaveLength(writes);
});

it("warns about a Program whose file is there and is not a Requirements File", async () => {
  const workspace = ready();
  workspace.seed({ kind: "requirements", name: "notes" }, { shopping: [] });

  const set = await choosePrograms(workspace, [{ requirementsFile: "notes" }], {
    ...ALICE,
    basedOn: undefined,
  });

  expect(set).toMatchObject({
    view: {
      programWarnings: [{ kind: "program-file-unreadable", index: 0, requirementsFile: "notes" }],
    },
  });
});
