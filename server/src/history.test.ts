import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createWorkspace,
  editStateFile,
  readStateFile,
  snapshotOf,
  type StateEdit,
  type Workspace,
} from "@biu-cs-planner/app";
import { recordPick, type GroupPick, type StateFileVersion } from "@biu-cs-planner/core";
import { fileSystemWorkspace } from "./workspace.fs.ts";
import {
  editHistories,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
  type EditHistories,
  type HistoryBounds,
} from "./history.ts";

/**
 * The undo and redo stacks over a real folder, because what an undo has to leave behind is a
 * file: the assertions below read the bytes on disk rather than a value in memory, so an undo
 * that restored the right document through a different serialisation would still fail.
 *
 * Fixture data is invented. 89-110 is a real BIU course number, the Meetings are not, and no
 * crawled data is committed to this repo (ADR-0006).
 */
const ALICE = "alice";
const FALL_2027_A = { academicYear: 2027, semester: "fall", variant: "A" } as const;

const LECTURE: GroupPick = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

let root: string;
let workspace: Workspace;
let history: EditHistories;

/** A history as a server that has just started holds it: empty, and nobody's but its own. */
const started = (bounds: HistoryBounds = {}): void => {
  history = editHistories(workspace, bounds);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-history-"));
  workspace = fileSystemWorkspace(root);
  await createWorkspace(workspace);
  started();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const statePath = (): string => join(root, `${ALICE}.state.json`);

/** The State File as bytes. What an undo has to put back, exactly. */
const bytes = (): Promise<string> => readFile(statePath(), "utf8");

const currentVersion = async (): Promise<StateFileVersion | undefined> => {
  const loaded = await readStateFile(workspace, ALICE);
  if ("refused" in loaded) throw new Error(`the file came back refused: ${loaded.refused}`);
  return loaded.version;
};

/**
 * One ordinary edit, made the way a route makes one: on the revision the file holds, through
 * the wrapper, handing the history the port. Nothing in this file writes a State File any
 * other way, which is the guardrail as much as it is the setup.
 */
async function pick(group: GroupPick): Promise<void> {
  const outcome = await editStateFile(
    workspace,
    ALICE,
    { label: "pick-group", apply: (state) => recordPick(state, FALL_2027_A, group) },
    { basedOn: await currentVersion(), history: history.of(ALICE) },
  );
  if (outcome.kind !== "saved") throw new Error(`the edit was ${outcome.kind}`);
}

/** A Pick that differs from the last one, so that every edit moves the document. */
const groupNumber = (n: number): GroupPick => ({
  ...LECTURE,
  groupNumber: String(n).padStart(2, "0"),
});

/** Undo and redo the way a page asks for them: on the revision it is showing. */
const undo = async () => history.undo(ALICE, await currentVersion());
const redo = async () => history.redo(ALICE, await currentVersion());

/** How deep the undo stack really is, counted by emptying it. */
async function undoUntilEmpty(): Promise<number> {
  let done = 0;
  for (;;) {
    const moved = await undo();
    if (moved.kind === "refused") {
      expect(moved.reason).toBe("nothing-to-undo");
      return done;
    }
    done += 1;
    // no stack may hold more than the bound, so a loop that outlasts it is the bug
    if (done > MAX_HISTORY_ENTRIES) throw new Error("the undo stack never emptied");
  }
}

/**
 * The round trip the ticket asks for, asserted on the bytes: an edit, then an undo, and the
 * file is the file it was. Byte-identical rather than deep-equal, because the writer's round
 * trip (#63) is part of the claim — an undo that restored the same document through a
 * different serialisation would move the revision and make every open tab stale.
 */
it("leaves the State File byte-identical to what it was before the edit it undid", async () => {
  await pick(LECTURE);
  const before = await bytes();
  await pick(groupNumber(2));
  expect(await bytes()).not.toBe(before);

  const undone = await undo();

  expect(undone).toMatchObject({ kind: "moved", label: "pick-group", canUndo: true });
  expect(await bytes()).toBe(before);
  // and the revision it reports is the one the file now holds, for the caller's next save
  expect(undone.kind === "moved" && undone.version).toBe(await currentVersion());
});

it("puts the edit back on a redo, and says there is nothing left to redo", async () => {
  await pick(LECTURE);
  await pick(groupNumber(2));
  const edited = await bytes();
  await undo();

  const redone = await redo();

  expect(redone).toMatchObject({ kind: "moved", label: "pick-group", canRedo: false });
  expect(await bytes()).toBe(edited);
  await expect(redo()).resolves.toMatchObject({ kind: "refused", reason: "nothing-to-redo" });
});

/**
 * ADR-0013 has one API call be one entry, so undoing twice walks back two edits rather than
 * two calls arriving at the same place.
 */
it("walks back one edit per call, in the order the edits were made", async () => {
  await pick(LECTURE);
  const afterFirst = await bytes();
  await pick(groupNumber(2));
  await pick(groupNumber(3));

  await undo();
  await undo();

  expect(await bytes()).toBe(afterFirst);
});

/**
 * A new edit is a new future. The redo stack held a document that followed the one the undo
 * put back, and this edit is a different document following it — so redoing onto it would put
 * back a value that never came after this state.
 */
it("clears the redo stack when a new edit follows an undo", async () => {
  await pick(LECTURE);
  await pick(groupNumber(2));
  await undo();
  expect(history.availability(ALICE)).toEqual({ canUndo: true, canRedo: true });

  await pick(groupNumber(3));

  expect(history.availability(ALICE)).toEqual({ canUndo: true, canRedo: false });
  await expect(redo()).resolves.toMatchObject({ kind: "refused", reason: "nothing-to-redo" });
});

/**
 * The count bound drops the *oldest* entry rather than refusing the newest, which is what
 * makes it a history of the last hundred edits and not the first hundred. The bound is
 * injected here so the property can be asserted in four edits; that the real number is a
 * hundred is the test after next.
 */
it("keeps the last entries by count, dropping the oldest", async () => {
  started({ maxEntries: 2 });
  await pick(LECTURE);
  await pick(groupNumber(2));
  const afterTwo = await bytes();
  await pick(groupNumber(3));
  await pick(groupNumber(4));

  const walkedBack = await undoUntilEmpty();

  expect(walkedBack).toBe(2);
  // the two oldest entries went, so the earliest document still reachable is the one after
  // the second edit: those first two edits are in the file and can no longer be taken back
  expect(await bytes()).toBe(afterTwo);
});

/**
 * The byte bound, dropping the oldest for the same reason — and never the only entry. A
 * single snapshot past the budget means the plan itself is that large, and the process is
 * already holding a copy of it to have saved it; dropping it would make the edit a student
 * just made the one edit they cannot take back.
 */
it("keeps the last entries by bytes, dropping the oldest and never the only one", async () => {
  started({ maxBytes: 1 });
  await pick(LECTURE);
  await pick(groupNumber(2));
  const afterTwo = await bytes();
  await pick(groupNumber(3));

  const walkedBack = await undoUntilEmpty();

  expect(walkedBack).toBe(1);
  expect(await bytes()).toBe(afterTwo);
});

/**
 * The bounds ADR-0013 actually sets, crossed rather than injected.
 *
 * Both are reached with entries pushed straight onto the port, because a hundred real edits
 * is a hundred writes and eight megabytes of real Picks is eight megabytes of JSON. A pushed
 * entry is undoable like any other as long as the history still believes the file, so the
 * snapshot pushed here is the document that is already on disk: each undo writes the same
 * bytes back, which leaves the revision where it was and the next undo just as valid.
 */
const entryHolding = async (previous: StateEdit["previous"]): Promise<StateEdit> => ({
  label: "pick-group",
  at: Date.now(),
  previous,
});

const documentOnDisk = async (): Promise<StateEdit["previous"]> => {
  const loaded = await readStateFile(workspace, ALICE);
  if ("refused" in loaded) throw new Error(`the file came back refused: ${loaded.refused}`);
  return snapshotOf(loaded.state);
};

it("holds the last hundred edits and no more", async () => {
  await pick(LECTURE);
  const entry = await entryHolding(await documentOnDisk());
  const into = history.of(ALICE);
  // a hundred and one on top of the one real edit, so the bound is crossed twice over
  for (let n = 0; n <= MAX_HISTORY_ENTRIES; n += 1) into.push(entry);

  const walkedBack = await undoUntilEmpty();

  expect(MAX_HISTORY_ENTRIES).toBe(100);
  expect(walkedBack).toBe(MAX_HISTORY_ENTRIES);
});

it("drops entries sooner than a hundred once a stack passes eight megabytes", async () => {
  await pick(LECTURE);
  const held = await documentOnDisk();
  // one Pin carrying a megabyte of opaque Requirement id: the Progress engine never resolves
  // it here, and it makes one entry cost a measurable share of the budget
  const heavy = await entryHolding({
    ...held,
    pins: [{ courseNumber: "89-110", requirementId: "x".repeat(1024 * 1024) }],
  });
  const into = history.of(ALICE);
  // nine megabytes offered to an eight megabyte budget, which no count bound would touch
  const offered = 9;
  for (let n = 0; n < offered; n += 1) into.push(heavy);

  const walkedBack = await undoUntilEmpty();

  expect(MAX_HISTORY_BYTES).toBe(8 * 1024 * 1024);
  expect(walkedBack).toBeLessThan(offered);
  expect(walkedBack).toBeGreaterThan(0);
});

/**
 * The edge on the watcher, ruled by ADR-0013: "A file changed on disk invalidates the stack."
 * The snapshots were based on a file that no longer exists, so putting one back would
 * silently overwrite the change the external-edit guard exists to protect — and no caller can
 * stop it, because a tab that reloaded after Dropbox wrote the folder holds a perfectly
 * current revision.
 */
it("empties both stacks and writes nothing when the file changed on disk", async () => {
  await pick(LECTURE);
  await pick(groupNumber(2));
  await undo();
  // Dropbox, git, an editor, or another tool
  const fromOutside = (await bytes()).replace('"01"', '"09"');
  await writeFile(statePath(), fromOutside, "utf8");

  const refused = await undo();

  expect(refused).toEqual({
    kind: "refused",
    reason: "history-invalidated",
    canUndo: false,
    canRedo: false,
    warnings: [],
  });
  // the other writer's work is untouched, and the redo that was waiting went with the undo
  expect(await bytes()).toBe(fromOutside);
  expect(history.availability(ALICE)).toEqual({ canUndo: false, canRedo: false });
  await expect(redo()).resolves.toMatchObject({ kind: "refused", reason: "nothing-to-redo" });
});

/**
 * The other reason an undo can be refused, and it is not the same reason. A stale *caller* —
 * a tab showing what the file held an edit ago — is refused by the guard inside the wrapper,
 * and the history survives it: the file is still the one these snapshots came from, so a
 * reload and a second click make the undo.
 */
it("refuses an undo from a stale view without throwing the history away", async () => {
  await pick(LECTURE);
  const stale = await currentVersion();
  await pick(groupNumber(2));

  const refused = await history.undo(ALICE, stale);

  expect(refused).toMatchObject({
    kind: "refused",
    reason: "state-file-changed",
    canUndo: true,
  });
  // the page reloads, and the undo it asked for is still there to be made
  await expect(undo()).resolves.toMatchObject({ kind: "moved", label: "pick-group" });
});

it("says there is nothing to undo before anything has been edited", async () => {
  const nothing = await undo();

  expect(nothing).toEqual({
    kind: "refused",
    reason: "nothing-to-undo",
    canUndo: false,
    canRedo: false,
    warnings: [],
  });
});

/**
 * ADR-0013 keeps `settings` off the stack, and that cuts both ways: setting the language puts
 * no entry on it, and it must not look like an external change either. The save moved the
 * file's revision, so a history that only heard about undoable edits would read the file, see
 * a revision it did not write, and throw a student's undo away because they switched to
 * Hebrew.
 */
it("survives a settings edit, which moves the file but puts nothing on the stack", async () => {
  await pick(LECTURE);
  await pick(groupNumber(2));
  const settings = await editStateFile(
    workspace,
    ALICE,
    {
      label: "set-language",
      apply: (state) => ({ ...state, settings: { ...state.settings, language: "he" } }),
    },
    { basedOn: await currentVersion(), history: history.of(ALICE) },
  );
  expect(settings.kind).toBe("saved");

  const undone = await undo();

  // the Pick was undone and the language was not: the snapshot never held one to put back
  expect(undone).toMatchObject({ kind: "moved", label: "pick-group" });
  const held = await readStateFile(workspace, ALICE);
  if ("refused" in held) throw new Error("the file came back refused");
  expect(held.state.settings.language).toBe("he");
  expect(held.state.timetables[0]?.variants[0]?.picks).toEqual([LECTURE]);
});

/**
 * One history per State File, keyed by its name — not by a connection and not by a tab. Two
 * names are two histories, which is what makes this right on the day the Workspace screen
 * offers a picker (`app/src/picks.ts`, `DEFAULT_STATE_FILE`).
 */
it("keeps one history per State File, keyed by its name", async () => {
  await pick(LECTURE);

  expect(history.availability(ALICE)).toEqual({ canUndo: true, canRedo: false });
  expect(history.availability("bob")).toEqual({ canUndo: false, canRedo: false });
  await expect(history.undo("bob", undefined)).resolves.toMatchObject({
    reason: "nothing-to-undo",
  });
  // and alice's is where it was: a call about another State File touched nothing of hers
  expect(history.availability(ALICE)).toEqual({ canUndo: true, canRedo: false });
});

/**
 * A State File that cannot be read is a reason to write nothing and not a reason to throw the
 * stacks away: a half-synced file or a hand edit this build does not understand may be
 * readable again in a moment, and the snapshots are still the ones it was built from. If the
 * bytes that come back are somebody else's, the read after them sees a revision the history
 * never wrote and invalidates there — it heals on the read rather than guessing here.
 */
it("refuses an undo while the State File cannot be read, and keeps the stacks", async () => {
  await pick(LECTURE);
  await pick(groupNumber(2));
  // a hand edit, a half-written file, or a sync that stopped mid-copy
  await writeFile(statePath(), '{"schemaVersion":99}', "utf8");

  const refused = await history.undo(ALICE, undefined);

  expect(refused).toMatchObject({
    kind: "refused",
    reason: "state-file-unreadable",
    canUndo: true,
    warnings: [{ kind: "schema-version-too-new", found: 99 }],
  });
  // nothing was written over it, and nothing of the student's history was dropped
  expect(await bytes()).toBe('{"schemaVersion":99}');
  expect(history.availability(ALICE)).toEqual({ canUndo: true, canRedo: false });
});
