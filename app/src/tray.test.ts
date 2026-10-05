import {
  CURRENT_CATALOG_SCHEMA_VERSION,
  parseStateFile,
  type Catalog,
  type GroupPick,
  type Offering,
  type State,
} from "@biu-cs-planner/core";
import { expect, it } from "vitest";
import type { EditHistory, StateEdit } from "./edit.ts";
import { DEFAULT_STATE_FILE, pickGroup, readTimetable, type TimetableRef } from "./picks.ts";
import { addCourseToTray, removeCourseFromTray } from "./tray.ts";
import { duplicateVariantAs } from "./variants.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * The Tray use cases through the Workspace port (#283): a Course added and removed through the
 * one guarded writer, and the derived Tray — chips read off this year's Catalog — in every answer.
 *
 * Fixture data is invented. 89-110 is a real BIU course number, the Groups are not, and no
 * crawled data is committed to this repo (ADR-0006).
 */
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const REF = { kind: "state", name: DEFAULT_STATE_FILE } as const;

const INTRO: Offering = {
  courseNumber: "89-110",
  nameHebrew: "מבוא למדעי המחשב",
  credits: { known: true, total: 5 },
  semesters: ["fall"],
  groups: [
    { number: "01", lessonType: "הרצאה", lecturers: [], meetings: [] },
    { number: "03", lessonType: "תרגיל", lecturers: [], meetings: [] },
  ],
  exams: { known: false, sittings: [] },
};

const CATALOG: Catalog = {
  schemaVersion: CURRENT_CATALOG_SCHEMA_VERSION,
  academicYear: 2027,
  sources: [],
  offerings: [INTRO],
};

const LECTURE: GroupPick = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

function ready(withCatalog = true): MemoryWorkspace {
  const workspace = memoryWorkspace({ created: true });
  if (withCatalog) workspace.seed({ kind: "catalog", academicYear: 2027 }, CATALOG);
  return workspace;
}

async function stored(workspace: MemoryWorkspace): Promise<State | undefined> {
  return parseStateFile((await workspace.readStateFile(REF))?.data).state;
}

async function now(workspace: MemoryWorkspace, at: TimetableRef = FALL_2027) {
  const read = await readTimetable(workspace, at);
  return { basedOn: read.kind === "served" ? read.version : undefined };
}

const trayOf = (result: Awaited<ReturnType<typeof readTimetable>>) =>
  result.kind === "served" ? result.view.tray : undefined;

it("adds a Course to the Tray and answers with its chips, all still empty", async () => {
  const workspace = ready();

  const result = await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));

  expect(trayOf(result)).toEqual([
    {
      courseNumber: "89-110",
      origins: ["added"],
      known: true,
      chips: [{ lessonType: "הרצאה" }, { lessonType: "תרגיל" }],
      complete: false,
    },
  ]);
  expect((await stored(workspace))?.timetables[0]?.variants[0]?.tray).toEqual(["89-110"]);
});

it("keeps a Course added across a fresh read, which is what storing the Tray is for", async () => {
  const workspace = ready();
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));

  expect(trayOf(await readTimetable(workspace, FALL_2027))).toMatchObject([
    { courseNumber: "89-110", origins: ["added"] },
  ]);
});

it("fills a chip when its Lesson Type is picked, in the answer to the Pick itself", async () => {
  const workspace = ready();
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));

  const result = await pickGroup(workspace, FALL_2027, LECTURE, await now(workspace));

  expect(trayOf(result)).toMatchObject([
    {
      origins: ["added", "picked"],
      chips: [{ lessonType: "הרצאה", groupNumber: "01" }, { lessonType: "תרגיל" }],
      complete: false,
    },
  ]);
});

it("removes a Course and its Picks in one edit, and one undo entry", async () => {
  const workspace = ready();
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));
  await pickGroup(workspace, FALL_2027, LECTURE, await now(workspace));
  const pushed: StateEdit[] = [];
  const history: EditHistory = { push: (edit) => pushed.push(edit), wrote: () => {} };

  const result = await removeCourseFromTray(workspace, FALL_2027, "89-110", {
    ...(await now(workspace)),
    history,
  });

  expect(result).toMatchObject({ kind: "served", view: { picks: [], tray: [] } });
  expect(pushed.map((edit) => edit.label)).toEqual(["remove-from-tray"]);
  // the one entry holds both, so one undo puts the Course and its Pick back together
  expect(pushed[0]?.previous.timetables[0]?.variants[0]).toMatchObject({
    tray: ["89-110"],
    picks: [LECTURE],
  });
});

it("labels an added Course for the undo stack", async () => {
  const workspace = ready();
  const pushed: StateEdit[] = [];

  await addCourseToTray(workspace, FALL_2027, "89-110", {
    ...(await now(workspace)),
    history: { push: (edit) => pushed.push(edit), wrote: () => {} },
  });

  expect(pushed.map((edit) => edit.label)).toEqual(["add-to-tray"]);
});

it("lists a Course with its chips unknown when there is no Catalog for the year", async () => {
  const workspace = ready(false);

  const result = await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));

  expect(result).toMatchObject({ kind: "served" });
  expect(trayOf(result)).toEqual([
    { courseNumber: "89-110", origins: ["added"], known: false, chips: [], complete: null },
  ]);
});

it("refuses a Tray edit based on a revision the file has moved past", async () => {
  const workspace = ready();
  const stale = await now(workspace);
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));

  const result = await removeCourseFromTray(workspace, FALL_2027, "89-110", stale);

  expect(result).toMatchObject({ kind: "refused", reason: "state-file-changed" });
  expect((await stored(workspace))?.timetables[0]?.variants[0]?.tray).toEqual(["89-110"]);
});

it("copies the Tray when the Variant is duplicated, end to end", async () => {
  const workspace = ready();
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));

  const copy = await duplicateVariantAs(workspace, FALL_2027, {}, await now(workspace));

  expect(copy).toMatchObject({ kind: "served", view: { variantName: "B" } });
  expect(trayOf(copy)).toMatchObject([{ courseNumber: "89-110", origins: ["added"] }]);
});

it("adds to the Tray of the Variant named, and only that one", async () => {
  const workspace = ready();
  await addCourseToTray(workspace, FALL_2027, "89-110", await now(workspace));
  await duplicateVariantAs(workspace, FALL_2027, {}, await now(workspace));

  await removeCourseFromTray(workspace, { ...FALL_2027, variant: "B" }, "89-110", await now(workspace));

  expect((await stored(workspace))?.timetables[0]?.variants.map((v) => v.tray)).toEqual([
    ["89-110"],
    [],
  ]);
});
