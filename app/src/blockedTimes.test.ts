import { parseStateFile, type GroupPick, type State } from "@biu-cs-planner/core";
import { expect, it } from "vitest";
import type { StateEdit } from "./edit.ts";
import {
  addBlockedTimeTo,
  copyBlockedTimesTo,
  removeBlockedTimeAt,
  replaceBlockedTimeAt,
} from "./blockedTimes.ts";
import { DEFAULT_STATE_FILE, pickGroup, readTimetable, type TimetableRef } from "./picks.ts";
import { addVariant } from "./variants.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * The Blocked Time use cases through the Workspace port (#282). Fixture data is invented, and no
 * crawled data is committed to this repo (ADR-0006).
 */
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const SPRING_2027 = { academicYear: 2027, semester: "spring" } as const;
const REF = { kind: "state", name: DEFAULT_STATE_FILE } as const;
const WORK = { day: "tuesday", start: "13:00", end: "17:00", label: "work" } as const;

const LECTURE: GroupPick = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

const ready = (): MemoryWorkspace => memoryWorkspace({ created: true });

async function stored(workspace: MemoryWorkspace): Promise<State | undefined> {
  return parseStateFile((await workspace.readStateFile(REF))?.data).state;
}

async function now(workspace: MemoryWorkspace, at: TimetableRef = FALL_2027) {
  const read = await readTimetable(workspace, at);
  return { basedOn: read.kind === "served" ? read.version : undefined };
}

it("adds a Blocked Time and answers with it, splitting a night shift into two rows", async () => {
  const workspace = ready();

  const result = await addBlockedTimeTo(
    workspace,
    FALL_2027,
    { day: "monday", start: "23:00", end: "01:00", label: "shift" },
    await now(workspace),
  );

  expect(result).toMatchObject({
    kind: "served",
    view: {
      blockedTimes: [
        { semester: "fall", day: "monday", start: "23:00", end: "00:00", label: "shift" },
        { semester: "fall", day: "tuesday", start: "00:00", end: "01:00", label: "shift" },
      ],
      blockedTimeWarnings: [],
    },
  });
});

it("reports a Pick that overlaps a Blocked Time as a Clash naming its label, and records it", async () => {
  const workspace = ready();
  await addBlockedTimeTo(workspace, FALL_2027, WORK, await now(workspace));

  const result = await pickGroup(workspace, FALL_2027, LECTURE, await now(workspace));

  expect(result).toMatchObject({
    kind: "served",
    view: {
      picks: [LECTURE],
      clashes: [
        {
          kind: "meeting-blocked-time",
          blockedTime: { label: "work" },
          blockedTimeIndex: 0,
        },
      ],
    },
  });
});

it("answers with a Warning about a range that does not advance, and keeps it", async () => {
  const workspace = ready();

  const result = await addBlockedTimeTo(
    workspace,
    FALL_2027,
    { ...WORK, start: "10:00", end: "10:00" },
    await now(workspace),
  );

  expect(result).toMatchObject({
    view: {
      blockedTimes: [{ start: "10:00", end: "10:00" }],
      blockedTimeWarnings: [{ kind: "blocked-time-does-not-advance", index: 0 }],
    },
  });
});

it("replaces and removes a Blocked Time by position", async () => {
  const workspace = ready();
  await addBlockedTimeTo(workspace, FALL_2027, WORK, await now(workspace));
  await addBlockedTimeTo(workspace, FALL_2027, { ...WORK, label: "gym" }, await now(workspace));

  await replaceBlockedTimeAt(workspace, FALL_2027, 0, { ...WORK, day: "sunday" }, await now(workspace));
  const removed = await removeBlockedTimeAt(workspace, FALL_2027, 1, await now(workspace));

  expect(removed).toMatchObject({
    view: { blockedTimes: [{ day: "sunday", label: "work" }] },
  });
});

it("copies a Semester's Blocked Times to another, adding to what is there", async () => {
  const workspace = ready();
  await addBlockedTimeTo(workspace, FALL_2027, WORK, await now(workspace));
  await addBlockedTimeTo(workspace, SPRING_2027, { ...WORK, label: "gym" }, await now(workspace));

  await copyBlockedTimesTo(workspace, FALL_2027, SPRING_2027, await now(workspace));

  const spring = (await stored(workspace))?.timetables.find((t) => t.semester === "spring");
  expect(spring?.blockedTimes.map((b) => [b.semester, b.label])).toEqual([
    ["spring", "gym"],
    ["spring", "work"],
  ]);
});

it("shows the Semester's Blocked Times whichever Variant is shown", async () => {
  const workspace = ready();
  await addBlockedTimeTo(workspace, FALL_2027, WORK, await now(workspace));
  await addVariant(workspace, FALL_2027, { name: "B" }, await now(workspace));

  expect(await readTimetable(workspace, { ...FALL_2027, variant: "B" })).toMatchObject({
    view: { variantName: "B", blockedTimes: [{ label: "work" }] },
  });
});

it("labels each Blocked Time edit for the undo stack, and refuses a stale one", async () => {
  const workspace = ready();
  const pushed: StateEdit[] = [];
  const history = { push: (edit: StateEdit) => pushed.push(edit), wrote: () => {} };
  const step = async () => ({ ...(await now(workspace)), history });

  await addBlockedTimeTo(workspace, FALL_2027, WORK, await step());
  await replaceBlockedTimeAt(workspace, FALL_2027, 0, { ...WORK, label: "job" }, await step());
  await copyBlockedTimesTo(workspace, FALL_2027, SPRING_2027, await step());
  const stale = await now(workspace);
  await removeBlockedTimeAt(workspace, FALL_2027, 0, await step());

  expect(pushed.map((edit) => edit.label)).toEqual([
    "add-blocked-time",
    "replace-blocked-time",
    "copy-blocked-times",
    "remove-blocked-time",
  ]);
  await expect(removeBlockedTimeAt(workspace, SPRING_2027, 0, stale)).resolves.toMatchObject({
    kind: "refused",
    reason: "state-file-changed",
  });
});
