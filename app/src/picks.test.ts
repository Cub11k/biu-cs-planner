import { parseStateFile, type GroupPick, type State } from "@biu-cs-planner/core";
import { expect, it } from "vitest";
import type { EditHistory, StateEdit } from "./edit.ts";
import {
  DEFAULT_STATE_FILE,
  pickGroup,
  readTimetable,
  removeGroupPick,
  type TimetableRef,
} from "./picks.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * Picking a Group through the Workspace port: the pure edit in `core` applied, saved, and
 * read back. The double stands in for a folder so these exercise the port rather than a
 * disk; that a Pick survives a real server restart is `server/src/api.test.ts`.
 *
 * Fixture data is invented. 89-110 and 89-210 are real BIU course numbers, the Meetings
 * are not, and no crawled data is committed to this repo (ADR-0006).
 */
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const REF = { kind: "state", name: DEFAULT_STATE_FILE } as const;

const LECTURE: GroupPick = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};
const OTHER_LECTURE: GroupPick = { ...LECTURE, groupNumber: "02" };
const CLASHING: GroupPick = {
  courseNumber: "89-210",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "16:00", end: "17:00" }],
};

const ready = (): MemoryWorkspace => memoryWorkspace({ created: true });

/** The State File as it actually sits in the Workspace, read the way the app reads it. */
async function stored(workspace: MemoryWorkspace): Promise<State | undefined> {
  return parseStateFile((await workspace.readStateFile(REF))?.data).state;
}

/**
 * Picking the way a page picks: on the revision the last read served (docs/design.md,
 * "External edits"). Spelled once here so that each test below reads as what it is about
 * rather than about revisions — that the revision is *enforced* is `edit.test.ts`, and that
 * a real file's revision is its content is `server/src/workspace.fs.test.ts`.
 */
async function basedOnNow(
  workspace: MemoryWorkspace,
  at: TimetableRef,
): Promise<{ basedOn: string | undefined }> {
  const read = await readTimetable(workspace, at);
  return { basedOn: read.kind === "served" ? read.version : undefined };
}

const pick = async (
  workspace: MemoryWorkspace,
  at: TimetableRef,
  group: GroupPick,
  options: { history?: EditHistory } = {},
) => pickGroup(workspace, at, group, { ...(await basedOnNow(workspace, at)), ...options });

const unpick = async (
  workspace: MemoryWorkspace,
  at: TimetableRef,
  slot: { courseNumber: string; lessonType: string },
  options: { history?: EditHistory } = {},
) => removeGroupPick(workspace, at, slot, { ...(await basedOnNow(workspace, at)), ...options });

it("records a Pick in a State File that does not exist yet", async () => {
  const workspace = ready();

  const result = await pick(workspace, FALL_2027, LECTURE);

  expect(result).toMatchObject({ kind: "served", view: { picks: [LECTURE], clashes: [] } });
  expect(workspace.written()).toEqual([REF]);
  expect((await stored(workspace))?.timetables[0]?.variants).toEqual([
    { name: "A", primary: true, picks: [LECTURE] },
  ]);
});

it("keeps the Pick on disk, so a reader that never saw the edit still finds it", async () => {
  const workspace = ready();
  await pick(workspace, FALL_2027, LECTURE);

  // a second, ignorant read: nothing of the first call is in memory here
  const read = await readTimetable(workspace, FALL_2027);

  expect(read).toMatchObject({ kind: "served", view: { variantName: "A", picks: [LECTURE] } });
});

it("replaces the Pick for a Lesson Type already picked", async () => {
  const workspace = ready();
  await pick(workspace, FALL_2027, LECTURE);

  const result = await pick(workspace, FALL_2027, OTHER_LECTURE);

  expect(result).toMatchObject({ kind: "served", view: { picks: [OTHER_LECTURE] } });
});

it("records a Pick that Clashes and reports the Clash", async () => {
  const workspace = ready();
  await pick(workspace, FALL_2027, LECTURE);

  const result = await pick(workspace, FALL_2027, CLASHING);

  // nothing is refused: both Picks are in the file and the Clash is a Warning on top
  expect(result.kind).toBe("served");
  if (result.kind !== "served") throw new Error("the edit was refused");
  expect(result.view.picks).toHaveLength(2);
  expect(result.view.clashes).toHaveLength(1);
  expect(result.view.clashes[0]).toMatchObject({ kind: "meeting-meeting" });
});

it("removes a Pick, and writes nothing when there is none to remove", async () => {
  const workspace = ready();
  await pick(workspace, FALL_2027, LECTURE);
  const writesAfterPicking = workspace.written().length;

  const removed = await unpick(workspace, FALL_2027, {
    courseNumber: "89-110",
    lessonType: "הרצאה",
  });
  expect(removed).toMatchObject({ kind: "served", view: { picks: [] } });
  expect(workspace.written().length).toBe(writesAfterPicking + 1);

  const again = await unpick(workspace, FALL_2027, {
    courseNumber: "89-110",
    lessonType: "הרצאה",
  });
  expect(again).toMatchObject({ kind: "served", view: { picks: [] } });
  // an edit that changed nothing saves nothing: a write moves the Workspace change count
  // and would reload every open page over an edit that did not happen
  expect(workspace.written().length).toBe(writesAfterPicking + 1);
});

it("serves an empty Variant for a State File that is not there", async () => {
  const result = await readTimetable(ready(), FALL_2027);

  expect(result).toMatchObject({
    kind: "served",
    view: { variantName: "A", picks: [], clashes: [] },
  });
});

it("refuses to write over a State File it could not read, rather than losing it", async () => {
  const workspace = ready();
  // a hand edit, a half-synced file, another tool's output: whatever it is, it is not
  // this build's to overwrite (docs/design.md, "Storage")
  workspace.seed(REF, { schemaVersion: 99 });

  const picked = await pick(workspace, FALL_2027, LECTURE);

  expect(picked).toMatchObject({
    kind: "refused",
    reason: "state-file-unreadable",
    warnings: [{ kind: "schema-version-too-new", found: 99 }],
  });
  expect(workspace.written()).toEqual([]);
  expect((await workspace.readStateFile(REF))?.data).toEqual({ schemaVersion: 99 });
});

it("hands the previous value and the edit's label to the undo history", async () => {
  const workspace = ready();
  const history: StateEdit[] = [];
  const into = { push: (edit: StateEdit) => void history.push(edit), wrote: () => {} };

  await pick(workspace, FALL_2027, LECTURE, { history: into });
  await pick(workspace, FALL_2027, CLASHING, { history: into });
  await unpick(
    workspace,
    FALL_2027,
    { courseNumber: "89-210", lessonType: "הרצאה" },
    { history: into },
  );

  // one entry per edit, each carrying the State File as it stood before that edit — which
  // is all undo (#73) needs, because undo writes an earlier value back (ADR-0013)
  expect(history.map((edit) => edit.label)).toEqual([
    "pick-group",
    "pick-group",
    "remove-pick",
  ]);
  expect(history[0]?.previous.timetables).toEqual([]);
  expect(history[1]?.previous.timetables[0]?.variants[0]?.picks).toEqual([LECTURE]);
  expect(history[2]?.previous.timetables[0]?.variants[0]?.picks).toEqual([LECTURE, CLASHING]);
});

it("leaves an untouched Variant alone when another one is edited", async () => {
  const workspace = ready();
  await pick(workspace, FALL_2027, LECTURE);

  await pick(workspace, { ...FALL_2027, variant: "B" }, CLASHING);

  await expect(readTimetable(workspace, FALL_2027)).resolves.toMatchObject({
    view: { picks: [LECTURE] },
  });
  await expect(
    readTimetable(workspace, { ...FALL_2027, variant: "B" }),
  ).resolves.toMatchObject({ view: { variantName: "B", picks: [CLASHING] } });
});

it("keeps each State File to itself", async () => {
  const workspace = ready();

  await pick(workspace, { ...FALL_2027, stateFile: "alice" }, LECTURE);

  await expect(
    readTimetable(workspace, { ...FALL_2027, stateFile: "bob" }),
  ).resolves.toMatchObject({ view: { picks: [] } });
  expect(workspace.written()).toEqual([{ kind: "state", name: "alice" }]);
});

it("reports a Workspace that would not touch the file, rather than crashing", async () => {
  // A State File is named, never a path: the port refuses the rest, in both adapters
  // (app/src/workspace.ts). Nothing can send this today — the name is a constant until
  // there is a picker — so this is the refusal arriving as a reason and not as a 500.
  const at = { ...FALL_2027, stateFile: "../elsewhere" };

  await expect(pickGroup(ready(), at, LECTURE, { basedOn: undefined })).resolves.toMatchObject({
    kind: "refused",
    reason: "workspace-refused",
  });
  await expect(readTimetable(ready(), at)).resolves.toMatchObject({
    kind: "refused",
    reason: "workspace-refused",
  });
});

it("refuses to pick into a folder that is not a Workspace yet", async () => {
  // nothing is written until the student accepts the layout (docs/design.md, "Storage"),
  // which is the same refusal `importCrawl` makes
  const workspace = memoryWorkspace();

  const picked = await pick(workspace, FALL_2027, LECTURE);

  expect(picked).toMatchObject({ kind: "refused", reason: "workspace-not-ready" });
  expect(workspace.written()).toEqual([]);
  // reading is not refused: a folder with no State File is an empty week, not a failure
  await expect(readTimetable(workspace, FALL_2027)).resolves.toMatchObject({
    kind: "served",
    view: { picks: [] },
  });
});
