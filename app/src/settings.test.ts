import {
  CURRENT_STATE_SCHEMA_VERSION,
  recordPick,
  type GroupPick,
  type StateFileVersion,
} from "@biu-cs-planner/core";
import { expect, it } from "vitest";
import { editStateFile, type EditHistory, type StateEdit } from "./edit.ts";
import { DEFAULT_STATE_FILE } from "./picks.ts";
import { choosing, readSettings, setSettings } from "./settings.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * The settings use cases (#115): reading the preferences the State File holds, and setting one.
 *
 * What is under test is mostly *how a preference is written* rather than the writing itself,
 * because the writing is `editStateFile`'s and is tested in `./edit.test.ts`. Three properties
 * are this module's own and each has bitten a preference in some other codebase:
 *
 *   - a change is a change to a guarded document, so it can be **refused**;
 *   - it puts **nothing** on the undo stack, and still tells the stack the revision it wrote
 *     (ADR-0013);
 *   - a `settings-unreadable` Warning from `core` comes back with the settings rather than
 *     being dropped here.
 *
 * Fixture data is invented. 89-110 is a real BIU course number and the Meetings are not; no
 * crawled data is committed to this repo (ADR-0006).
 */
const ALICE = "alice";
const REF = { kind: "state", name: ALICE } as const;
/**
 * Every call below names the State File, so the fixture and the use case cannot disagree about
 * which one is under test. The default is `DEFAULT_STATE_FILE` and has its own test at the foot
 * of this file.
 */
const AT = { stateFile: ALICE } as const;

const ready = (): MemoryWorkspace => memoryWorkspace({ created: true });

const versionOf = async (workspace: MemoryWorkspace): Promise<StateFileVersion | undefined> =>
  (await workspace.readStateFile(REF))?.version;

/** What the file holds, read straight off the port rather than through the use case. */
async function stored(workspace: MemoryWorkspace): Promise<unknown> {
  const file = await workspace.readStateFile(REF);
  if (file === undefined) throw new Error("there is no State File");
  return file.data;
}

/** The settings the use case serves, or a failure naming what came back instead. */
async function served(workspace: MemoryWorkspace): Promise<{
  language: string;
  examSpacingDays: number;
  version: StateFileVersion | undefined;
}> {
  const result = await readSettings(workspace, AT);
  if (result.kind !== "served") throw new Error(`the settings came back ${result.reason}`);
  return { ...result.settings, version: result.version };
}

/** What a save told the stack, which is both revisions and never one of them. */
type Wrote = { basedOn: StateFileVersion | undefined; version: StateFileVersion };

/**
 * A collecting history. `port` is the real `EditHistory` and not a shape of this test's own, so a
 * change to what the wrapper reports is a compile error here rather than a test that keeps passing.
 */
function watchedHistory(): { pushed: StateEdit[]; wrote: Wrote[]; port: EditHistory } {
  const pushed: StateEdit[] = [];
  const wrote: Wrote[] = [];
  return {
    pushed,
    wrote,
    port: {
      push: (edit) => void pushed.push(edit),
      wrote: (save) => void wrote.push(save),
    },
  };
}

const LECTURE: GroupPick = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

const FALL_2027_A = { academicYear: 2027, semester: "fall", variant: "A" } as const;

it("serves the schema's defaults when there is no State File yet", async () => {
  const workspace = ready();

  const settings = await served(workspace);

  // The defaults `core/src/state/schema.ts` sets, reached without a file having been written:
  // nothing is created by a read (docs/design.md, "Storage").
  expect(settings).toEqual({ language: "en", examSpacingDays: 3, version: undefined });
  expect(await versionOf(workspace)).toBeUndefined();
});

it("serves the defaults for a State File written before settings existed", async () => {
  const workspace = ready();
  // `prefault({})` covers a file with no `settings` key at all, which is every State File
  // written before the field was added.
  workspace.seed(REF, { schemaVersion: CURRENT_STATE_SCHEMA_VERSION });

  expect(await served(workspace)).toMatchObject({ language: "en", examSpacingDays: 3 });
});

/**
 * The criterion the ticket puts most weight on: a language chosen survives. Here that is the
 * whole round trip inside `app` — set it, then read it back off the disk the way the next page
 * load would.
 */
it("reads back a language that was set", async () => {
  const workspace = ready();

  const set = await setSettings(workspace, { language: "he" }, { ...AT, basedOn: undefined });

  expect(set.kind).toBe("served");
  expect(await served(workspace)).toMatchObject({ language: "he" });
});

it("leaves the preference it was not asked about alone", async () => {
  const workspace = ready();
  await setSettings(workspace, { examSpacingDays: 7 }, { ...AT, basedOn: undefined });

  await setSettings(workspace, { language: "he" }, { ...AT, basedOn: await versionOf(workspace) });

  expect(await served(workspace)).toMatchObject({ language: "he", examSpacingDays: 7 });
});

/**
 * `examSpacingDays` is readable and writable by the same mechanism as the language, which is
 * the ticket's second criterion. Nothing carries it to `checkExams` yet — that is the other
 * half and a different ticket — so this is the whole of what is claimed.
 */
it("reads and writes exam spacing by the same mechanism as the language", async () => {
  const workspace = ready();

  const set = await setSettings(workspace, { examSpacingDays: 10 }, { ...AT, basedOn: undefined });

  expect(set.kind === "served" && set.settings.examSpacingDays).toBe(10);
  expect(await served(workspace)).toMatchObject({ examSpacingDays: 10 });
});

it("sets both preferences in one save", async () => {
  const workspace = ready();

  await setSettings(workspace, { language: "he", examSpacingDays: 5 }, { ...AT, basedOn: undefined });

  expect(await served(workspace)).toMatchObject({ language: "he", examSpacingDays: 5 });
});

/**
 * An explicit `undefined` means "leave this alone" and must not reach the file, where it would
 * be a State File the schema rejects — written by a caller that meant nothing of the kind.
 * Nothing over the API can produce one, because JSON has no `undefined`; a caller inside the
 * process can.
 */
it("treats a preference named as undefined as one not named at all", async () => {
  const workspace = ready();
  await setSettings(workspace, { language: "he" }, { ...AT, basedOn: undefined });

  const set = await setSettings(
    workspace,
    { language: undefined, examSpacingDays: 4 },
    { ...AT, basedOn: await versionOf(workspace) },
  );

  expect(set.kind).toBe("served");
  expect(await served(workspace)).toMatchObject({ language: "he", examSpacingDays: 4 });
});

/**
 * Choosing what is already chosen writes nothing. A save moves the Workspace's change count,
 * which makes every open tab re-read everything it is showing, so a no-op write is noise the
 * whole app pays for — and `choosing` returning the State it was handed is what `editStateFile`
 * reads as "nothing to do".
 */
it("writes nothing when the preference is already what was asked for", async () => {
  const workspace = ready();
  await setSettings(workspace, { language: "he" }, { ...AT, basedOn: undefined });
  const before = await versionOf(workspace);
  const history = watchedHistory();

  const again = await setSettings(workspace, { language: "he" }, { ...AT, basedOn: before, history: history.port });

  expect(again.kind).toBe("served");
  expect(await versionOf(workspace)).toBe(before);
  // the double counts its writes, which is the direct proof: the first save is the only one
  expect(workspace.written()).toHaveLength(1);
  // and nothing was written, so the undo stack has nothing to hear about either
  expect(history.wrote).toEqual([]);
});

/**
 * ADR-0013, "One stack covers the document, minus settings … folding them in would let undoing
 * a Pick flip the UI language." Asserted on the real use case rather than on a stand-in edit:
 * `./edit.test.ts` proves the wrapper's rule, and this proves that the thing which actually
 * writes a preference is subject to it.
 */
it("puts no undo entry on the stack for a settings save", async () => {
  const workspace = ready();
  const history = watchedHistory();

  const set = await setSettings(workspace, { language: "he" }, { ...AT, basedOn: undefined, history: history.port });

  expect(set.kind).toBe("served");
  expect(history.pushed).toEqual([]);
});

/**
 * The other half, and the one whose absence would be silent and destructive: the stack is still
 * told which revision this save wrote. A stack that had not heard would go on believing the
 * revision before it, read the file on the next undo, see a revision it never wrote, and throw
 * the student's history away as though something outside the app had edited the file.
 */
it("still tells the stack both revisions of a settings save", async () => {
  const workspace = ready();
  const history = watchedHistory();
  await editStateFile(
    workspace,
    ALICE,
    { label: "pick-group", apply: (state) => recordPick(state, FALL_2027_A, LECTURE) },
    { basedOn: undefined, history: history.port },
  );
  const afterPick = await versionOf(workspace);

  await setSettings(workspace, { language: "he" }, { ...AT, basedOn: afterPick, history: history.port });

  const settingsSave = history.wrote.at(-1);
  expect(settingsSave?.basedOn).toBe(afterPick);
  expect(settingsSave?.version).toBe(await versionOf(workspace));
  // and the Pick is still the only thing on the stack
  expect(history.pushed.map((edit) => edit.label)).toEqual(["pick-group"]);
});

/**
 * The consequence of a preference living in a guarded document, and the thing the screen has to
 * have an answer for: **a language change can fail.** Somebody else wrote the file between the
 * read this change was based on and this save, and overwriting it would destroy their work.
 */
it("refuses a change based on a revision the file has moved past", async () => {
  const workspace = ready();
  await setSettings(workspace, { language: "he" }, { ...AT, basedOn: undefined });
  const stale = await versionOf(workspace);
  // somebody else: another tab, an editor, git, Dropbox
  await editStateFile(
    workspace,
    ALICE,
    { label: "pick-group", apply: (state) => recordPick(state, FALL_2027_A, LECTURE) },
    { basedOn: stale },
  );

  const refused = await setSettings(workspace, { language: "en" }, { ...AT, basedOn: stale });

  expect(refused).toMatchObject({ kind: "refused", reason: "state-file-changed" });
  // and the change did not happen: the preference is the one the file held
  expect(await served(workspace)).toMatchObject({ language: "he" });
});

it("refuses to write a preference into a folder that is not a Workspace yet", async () => {
  const workspace = memoryWorkspace({ created: false });

  const refused = await setSettings(workspace, { language: "he" }, { ...AT, basedOn: undefined });

  expect(refused).toMatchObject({ kind: "refused", reason: "workspace-not-ready" });
});

/**
 * Reading is not guarded on the layout and writing is: a folder that is not a Workspace holds
 * no State File, which is the schema's defaults rather than a failure, and a student who has
 * not accepted the layout yet should still see a screen in a language.
 */
it("still serves the defaults from a folder that is not a Workspace yet", async () => {
  const workspace = memoryWorkspace({ created: false });

  expect(await readSettings(workspace, AT)).toMatchObject({
    kind: "served",
    settings: { language: "en" },
  });
});

/**
 * The Warning `core` already produces, arriving where something can show it. `readSettings` in
 * `core/src/state/file.ts` reads the fields one at a time, so a corrupted Exam spacing costs
 * that field and not the language beside it — and the field it lost is named.
 */
it("carries the settings-unreadable Warning core raises, naming the field", async () => {
  const workspace = ready();
  workspace.seed(REF, {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    settings: { language: "he", examSpacingDays: "three" },
  });

  const result = await readSettings(workspace, AT);

  expect(result).toMatchObject({ kind: "served", settings: { language: "he", examSpacingDays: 3 } });
  expect(result.warnings).toEqual([{ kind: "settings-unreadable", field: "examSpacingDays" }]);
});

it("carries one settings-unreadable Warning for settings that are not an object at all", async () => {
  const workspace = ready();
  workspace.seed(REF, { schemaVersion: CURRENT_STATE_SCHEMA_VERSION, settings: "he" });

  const result = await readSettings(workspace, AT);

  expect(result.warnings).toEqual([{ kind: "settings-unreadable" }]);
});

/**
 * A file this build cannot read at all is refused rather than replaced. Writing a preference
 * into a new empty State File over it would cost the student everything in it, silently, for
 * the sake of one field (#109, and `readStateFile`'s own rule).
 */
it("refuses to set a preference in a State File it cannot read", async () => {
  const workspace = ready();
  workspace.seed(REF, "not a State File");

  const refused = await setSettings(workspace, { language: "he" }, { ...AT, basedOn: undefined });

  expect(refused).toMatchObject({ kind: "refused", reason: "state-file-unreadable" });
  expect(await stored(workspace)).toEqual("not a State File");
});

/** The pure edit on its own, which is the part `editStateFile` reads for two decisions. */
it("hands back the State it was given when the preference already says that", () => {
  const state = {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: [],
    timetables: [],
    pins: [],
    settings: { language: "he" as const, examSpacingDays: 3 },
  };

  expect(choosing({ language: "he" }).apply(state)).toBe(state);
});

it("leaves every part of the document but settings the object it already was", () => {
  const state = {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: [],
    timetables: [],
    pins: [],
    settings: { language: "en" as const, examSpacingDays: 3 },
  };

  const next = choosing({ language: "he" }).apply(state);

  // reference equality, which is exactly what `movedOutsideSettings` in ./edit.ts compares
  expect(next).not.toBe(state);
  expect(next.attempts).toBe(state.attempts);
  expect(next.timetables).toBe(state.timetables);
  expect(next.pins).toBe(state.pins);
});

/**
 * The State File both use cases work in when nothing names one: the same `DEFAULT_STATE_FILE`
 * the Pick use cases default to, so a preference and a Pick made from one page land in one
 * document. A second opinion about which file that is would be invisible until a student's
 * language and their Picks were in two files.
 */
it("works in DEFAULT_STATE_FILE when no State File is named", async () => {
  const workspace = ready();

  await setSettings(workspace, { language: "he" }, { basedOn: undefined });

  const written = await workspace.readStateFile({ kind: "state", name: DEFAULT_STATE_FILE });
  expect((written?.data as { settings: { language: string } }).settings.language).toBe("he");
  expect(await readSettings(workspace)).toMatchObject({ settings: { language: "he" } });
  // and nothing landed in the file this file's other tests use
  expect(await workspace.readStateFile(REF)).toBeUndefined();
});
