import { recordPick, type GroupPick, type State } from "@biu-cs-planner/core";
import { expect, it } from "vitest";
import { editStateFile, readStateFile, type StateEdit, type StateEditing } from "./edit.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

/**
 * The external-edit guard where a use case meets it (#90).
 *
 * `docs/design.md`, "Storage" has each save carry the file version it was based on, and the
 * server refuse the overwrite when the file changed on disk meanwhile. Two halves make that
 * true and they answer different questions, so both are tested: this one asks whether the
 * *student's view* is still current, before their edit is applied to a State they never saw;
 * the adapter's asks whether the *file* is still what was read, at the moment of the write
 * (`server/src/workspace.fs.test.ts`).
 *
 * Fixture data is invented. 89-110 is a real BIU course number, the Meetings are not, and
 * no crawled data is committed to this repo (ADR-0006).
 */
const ALICE = "alice";
const REF = { kind: "state", name: ALICE } as const;
const FALL_2027_A = { academicYear: 2027, semester: "fall", variant: "A" } as const;

const LECTURE: GroupPick = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

/** One ordinary edit: a pure `state -> state` function from `core`, plus a label. */
const picking = (pick: GroupPick): StateEditing => ({
  label: "pick-group",
  apply: (state) => recordPick(state, FALL_2027_A, pick),
});

const ready = (): MemoryWorkspace => memoryWorkspace({ created: true });

const versionOf = async (workspace: MemoryWorkspace): Promise<string | undefined> =>
  (await workspace.readStateFile(REF))?.version;

it("reads a State File that is not there as an empty one, based on no revision", async () => {
  const loaded = await readStateFile(ready(), ALICE);

  expect(loaded).toMatchObject({ warnings: [] });
  if ("refused" in loaded) throw new Error("an absent State File is an empty week, not a refusal");
  // `undefined` is the honest answer and the one a first save has to carry: there is no
  // revision of a file that does not exist
  expect(loaded.version).toBeUndefined();
  expect(loaded.state.timetables).toEqual([]);
});

it("hands back the revision it read, so a save can be based on it", async () => {
  const workspace = ready();
  await editStateFile(workspace, ALICE, picking(LECTURE), { basedOn: undefined });

  const loaded = await readStateFile(workspace, ALICE);

  if ("refused" in loaded) throw new Error("the file it just wrote came back refused");
  expect(loaded.version).toBe(await versionOf(workspace));
  expect(loaded.version).toEqual(expect.any(String));
});

it("saves when the edit is based on the revision the file holds, and says which it wrote", async () => {
  const workspace = ready();
  const first = await editStateFile(workspace, ALICE, picking(LECTURE), { basedOn: undefined });

  expect(first.kind).toBe("saved");
  if (first.kind !== "saved") throw new Error("the first save was refused");
  // the revision it wrote, so a page saving twice in a row needs no re-read between them
  expect(first.version).toBe(await versionOf(workspace));

  const second = await editStateFile(
    workspace,
    ALICE,
    picking({ ...LECTURE, groupNumber: "02" }),
    { basedOn: first.version },
  );

  expect(second.kind).toBe("saved");
  expect(workspace.written()).toEqual([REF, REF]);
});

/**
 * The lost update this whole ticket exists for, in the shape the maintainer works in: two
 * views of one plan open side by side. Tab A saves; tab B, still showing what it read
 * before, saves on top and the edit tab A made is gone. It is refused instead.
 */
it("refuses a save based on a revision another writer has already replaced", async () => {
  const workspace = ready();
  await editStateFile(workspace, ALICE, picking(LECTURE), { basedOn: undefined });
  const seenByBothTabs = await versionOf(workspace);
  // tab A saves
  await editStateFile(workspace, ALICE, picking({ ...LECTURE, groupNumber: "02" }), {
    basedOn: seenByBothTabs,
  });

  // tab B, whose screen still shows what it read before tab A saved
  const outcome = await editStateFile(
    workspace,
    ALICE,
    picking({ ...LECTURE, groupNumber: "03" }),
    { basedOn: seenByBothTabs },
  );

  expect(outcome).toMatchObject({ kind: "refused", reason: "state-file-changed" });
  // tab A's Pick is still the one in the file
  const held = await readStateFile(workspace, ALICE);
  if ("refused" in held) throw new Error("the file became unreadable");
  expect(held.state.timetables[0]?.variants[0]?.picks).toEqual([
    { ...LECTURE, groupNumber: "02" },
  ]);
  expect(workspace.written()).toEqual([REF, REF]);
});

/**
 * `basedOn: undefined` is a claim about the file and not a way past the guard: it says the
 * save is based on there being no file. #80 shipped passing it always, because nothing could
 * produce anything else; now it is guarded like any other revision.
 */
it("refuses a save based on no file when the file is already there", async () => {
  const workspace = ready();
  workspace.seed(REF, { schemaVersion: 1 });

  const outcome = await editStateFile(workspace, ALICE, picking(LECTURE), {
    basedOn: undefined,
  });

  expect(outcome).toMatchObject({ kind: "refused", reason: "state-file-changed" });
  expect(workspace.written()).toEqual([]);
});

/** A refusal costs the student nothing they could have kept: the edit was never applied. */
it("pushes nothing onto the undo history when a save is refused", async () => {
  const workspace = ready();
  const history: StateEdit[] = [];
  const into = { push: (edit: StateEdit) => void history.push(edit) };
  await editStateFile(workspace, ALICE, picking(LECTURE), { basedOn: undefined });

  await editStateFile(workspace, ALICE, picking({ ...LECTURE, groupNumber: "02" }), {
    basedOn: "a revision this file never held",
    history: into,
  });

  expect(history).toEqual([]);
});

/**
 * ADR-0013: "the save path is the undo path", so the guard "applies equally to an undo".
 * There is no undo stack yet (#73 owes it), but an undo is already expressible — an edit
 * whose `apply` returns an earlier value — and this is that edit meeting the guard. It is
 * refused on a stale revision exactly as a first-hand edit is, and a file changed on disk
 * therefore invalidates the stack rather than being silently overwritten by it.
 */
it("guards an undo exactly as it guards the edit it undoes", async () => {
  const workspace = ready();
  const before = await editStateFile(workspace, ALICE, picking(LECTURE), {
    basedOn: undefined,
  });
  if (before.kind !== "saved") throw new Error("the edit to be undone was not saved");
  const undoing: StateEditing = {
    label: "undo pick-group",
    apply: () => before.edit.previous,
  };
  // somebody else writes the file after the edit and before the undo
  workspace.seed(REF, { schemaVersion: 1, pins: [{ courseNumber: "89-110" }] });

  const refused = await editStateFile(workspace, ALICE, undoing, { basedOn: before.version });

  expect(refused).toMatchObject({ kind: "refused", reason: "state-file-changed" });
  // and the same undo, based on what the file now holds, goes through: the guard is about
  // the revision and not about undo
  const current = await versionOf(workspace);
  const done = await editStateFile(workspace, ALICE, undoing, { basedOn: current });
  expect(done).toMatchObject({ kind: "saved", edit: { label: "undo pick-group" } });
});

/**
 * An edit that changes nothing writes nothing, and so cannot be refused for a revision it
 * was not going to overwrite — but it is still told what the file is, because the caller's
 * next save has to be based on something.
 */
it("serves the current revision with an edit that changed nothing", async () => {
  const workspace = ready();
  const first = await editStateFile(workspace, ALICE, picking(LECTURE), { basedOn: undefined });
  if (first.kind !== "saved") throw new Error("the first save was refused");

  const again = await editStateFile(workspace, ALICE, picking(LECTURE), {
    basedOn: first.version,
  });

  expect(again).toMatchObject({ kind: "unchanged", version: first.version });
  expect(workspace.written()).toEqual([REF]);
});

/**
 * The two halves are not the same check. This one has the view still current — so the use
 * case applies the edit and calls the port — and the file changing underneath between that
 * read and the write, which only the adapter can see. The edit itself writes the file from
 * outside, which is the one way a test can land inside that window on purpose.
 */
it("reports the adapter's refusal when the file changes between the read and the write", async () => {
  const workspace = ready();
  await editStateFile(workspace, ALICE, picking(LECTURE), { basedOn: undefined });
  const current = await versionOf(workspace);

  // the view is current, so nothing this use case can see is stale
  const outcome = await editStateFile(
    workspace,
    ALICE,
    {
      label: "pick-group",
      apply: (state: State): State => {
        workspace.seed(REF, { schemaVersion: 1, pins: [] });
        return recordPick(state, FALL_2027_A, { ...LECTURE, groupNumber: "02" });
      },
    },
    { basedOn: current },
  );

  expect(outcome).toMatchObject({ kind: "refused", reason: "state-file-changed" });
});

/**
 * #109 where it reaches a use case. A State File that is there and cannot be read — a mode bit,
 * a directory in its place, failing hardware — is the port's refusal and not absence, and this
 * function must not answer it with a new empty State: it would then save over the file with
 * `basedOn: undefined`, which is what destroyed a Pin on `dev`.
 *
 * The refusal is injected rather than produced, because the double has no unreadable files and
 * should not grow a knob for one: what is under test here is the mapping, and the adapter that
 * raises it for real is tested against a real folder (`server/src/workspace.fs.test.ts`).
 */
const cannotBeRead = (workspace: MemoryWorkspace): Workspace => ({
  ...workspace,
  readStateFile: () =>
    Promise.reject(new WorkspaceRefusedError("refusing ./alice.state.json: it is there and cannot be read (EACCES)")),
});

it("refuses an edit to a State File the port cannot read, rather than starting an empty one", async () => {
  const workspace = ready();
  await editStateFile(workspace, ALICE, picking(LECTURE), { basedOn: undefined });
  const before = workspace.written().length;

  const loaded = await readStateFile(cannotBeRead(workspace), ALICE);
  const outcome = await editStateFile(cannotBeRead(workspace), ALICE, picking(LECTURE), {
    basedOn: undefined,
  });

  expect(loaded).toEqual({ refused: "workspace-refused", warnings: [] });
  expect(outcome).toMatchObject({ kind: "refused", reason: "workspace-refused" });
  // and nothing was written over it
  expect(workspace.written().length).toBe(before);
});
