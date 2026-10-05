import { expect, it } from "vitest";
import { recordPick } from "./picks.ts";
import { stateSchema, type Attempt, type GroupPick, type State } from "./schema.ts";
import { addToTray, removeFromTray, trayEntries, type TrayOffering } from "./tray.ts";
import { duplicateVariant } from "./variants.ts";

/**
 * The Tray (#283): what is stored — the Courses added to a Variant directly — and what is
 * derived from it: that list, plus every Course with a Pick in the Variant, plus every Course
 * with a planned Attempt in the Semester, each with one chip per Lesson Type and a completeness.
 *
 * Fixture data is invented. 89-110, 89-210 and 89-230 are real BIU course numbers, the Groups and
 * the Meetings are not, and no crawled data is committed to this repo (ADR-0006).
 */
const A = { academicYear: 2027, semester: "fall", variant: "A" } as const;
const B = { ...A, variant: "B" } as const;

const empty = (): State => stateSchema.parse({ schemaVersion: 1 });

const pick = (courseNumber: string, lessonType: string, groupNumber: string): GroupPick => ({
  courseNumber,
  lessonType,
  groupNumber,
  meetings: [{ semester: "fall", day: "sunday", start: "10:00", end: "12:00" }],
});

/** 89-110 has a lecture and a tirgul, so it needs two Picks; 89-210 a lecture only. */
const OFFERINGS: TrayOffering[] = [
  {
    courseNumber: "89-110",
    groups: [
      { lessonType: "הרצאה" },
      { lessonType: "תרגיל" },
      { lessonType: "תרגיל" },
      { lessonType: "הרצאה" },
    ],
  },
  { courseNumber: "89-210", groups: [{ lessonType: "הרצאה" }] },
];

const tray = (state: State) => state.timetables[0]?.variants[0]?.tray;

const withAttempts = (state: State, attempts: Omit<Attempt, "id">[]): State => ({
  ...state,
  attempts: attempts.map((attempt, index) => ({ id: `attempt-${index + 1}`, ...attempt })),
});

it("adds a Course to a Variant's Tray, making the Timetable and the Variant", () => {
  const state = addToTray(empty(), A, "89-110");

  expect(state.timetables[0]?.variants).toEqual([
    { name: "A", primary: true, picks: [], tray: ["89-110"] },
  ]);
});

it("keeps the Tray in the order Courses were added", () => {
  const state = addToTray(addToTray(empty(), A, "89-210"), A, "89-110");

  expect(tray(state)).toEqual(["89-210", "89-110"]);
});

it("hands the same State back for a Course already in the Tray", () => {
  const state = addToTray(empty(), A, "89-110");

  expect(addToTray(state, A, "89-110")).toBe(state);
});

it("gives each Variant its own Tray", () => {
  const state = addToTray(addToTray(empty(), A, "89-110"), B, "89-210");

  expect(state.timetables[0]?.variants.map((v) => [v.name, v.tray])).toEqual([
    ["A", ["89-110"]],
    ["B", ["89-210"]],
  ]);
});

it("removes a Course from the Tray together with its Picks in that Variant, in one edit", () => {
  let state = addToTray(empty(), A, "89-110");
  state = recordPick(state, A, pick("89-110", "הרצאה", "01"));
  state = recordPick(state, A, pick("89-210", "הרצאה", "01"));
  state = recordPick(state, B, pick("89-110", "הרצאה", "02"));

  const removed = removeFromTray(state, A, "89-110");

  expect(tray(removed)).toEqual([]);
  expect(removed.timetables[0]?.variants[0]?.picks).toEqual([pick("89-210", "הרצאה", "01")]);
  // the other Variant's Pick of the same Course is not this Tray's to remove
  expect(removed.timetables[0]?.variants[1]?.picks).toEqual([pick("89-110", "הרצאה", "02")]);
});

it("removes the Picks of a Course in the Tray only because it was picked", () => {
  const state = recordPick(empty(), A, pick("89-110", "הרצאה", "01"));

  expect(removeFromTray(state, A, "89-110").timetables[0]?.variants[0]?.picks).toEqual([]);
});

it("leaves a planned Attempt alone: the Timetable never edits the Plan", () => {
  const planned: Omit<Attempt, "id"> = {
    courseNumber: "89-230",
    academicYear: 2027,
    semester: "fall",
    status: "planned",
  };
  const state = withAttempts(recordPick(empty(), A, pick("89-230", "הרצאה", "01")), [planned]);

  const removed = removeFromTray(state, A, "89-230");

  expect(removed.attempts).toEqual([{ id: "attempt-1", ...planned }]);
  expect(removed.timetables[0]?.variants[0]?.picks).toEqual([]);
  // and with nothing left to remove, it is a no-op rather than a save
  expect(removeFromTray(removed, A, "89-230")).toBe(removed);
});

it("hands the same State back when there is nothing of the Course to remove", () => {
  const state = addToTray(empty(), A, "89-110");

  expect(removeFromTray(state, A, "89-210")).toBe(state);
  expect(removeFromTray(empty(), A, "89-110").timetables).toEqual([]);
});

it("copies the Tray when a Variant is duplicated", () => {
  const state = addToTray(addToTray(empty(), A, "89-110"), A, "89-210");

  const copied = duplicateVariant(state, A, "B");

  expect(copied.timetables[0]?.variants.map((v) => [v.name, v.tray])).toEqual([
    ["A", ["89-110", "89-210"]],
    ["B", ["89-110", "89-210"]],
  ]);
  // a copy and not a shared list: adding to one leaves the other alone
  expect(tray(addToTray(copied, B, "89-230"))).toEqual(["89-110", "89-210"]);
});

it("derives the Tray as added, then picked, then planned, each Course once with its origins", () => {
  let state = addToTray(empty(), A, "89-110");
  state = recordPick(state, A, pick("89-210", "הרצאה", "01"));
  state = recordPick(state, A, pick("89-110", "הרצאה", "01"));
  state = withAttempts(state, [
    { courseNumber: "89-230", academicYear: 2027, semester: "fall", status: "planned" },
    { courseNumber: "89-210", academicYear: 2027, semester: "fall", status: "planned" },
    // not this Semester, not this year, and not planned: none of them joins this Tray
    { courseNumber: "89-214", academicYear: 2027, semester: "spring", status: "planned" },
    { courseNumber: "89-215", academicYear: 2026, semester: "fall", status: "planned" },
    { courseNumber: "89-216", academicYear: 2027, semester: "fall", status: "passed" },
  ]);

  expect(
    trayEntries(state, A, OFFERINGS).map((entry) => [entry.courseNumber, entry.origins]),
  ).toEqual([
    ["89-110", ["added", "picked"]],
    ["89-210", ["picked", "planned"]],
    ["89-230", ["planned"]],
  ]);
});

it("collapses a Course a hand edit added twice", () => {
  const state = addToTray(empty(), A, "89-110");
  const twice: State = {
    ...state,
    timetables: state.timetables.map((t) => ({
      ...t,
      variants: t.variants.map((v) => ({ ...v, tray: ["89-110", "89-110"] })),
    })),
  };

  expect(trayEntries(twice, A, OFFERINGS).map((entry) => entry.courseNumber)).toEqual(["89-110"]);
});

it("carries one chip per Lesson Type the Offering has, filled once picked", () => {
  const state = recordPick(addToTray(empty(), A, "89-110"), A, pick("89-110", "תרגיל", "03"));

  expect(trayEntries(state, A, OFFERINGS)).toEqual([
    {
      courseNumber: "89-110",
      origins: ["added", "picked"],
      known: true,
      // in the order the Offering lists its Groups, each Lesson Type once
      chips: [{ lessonType: "הרצאה" }, { lessonType: "תרגיל", groupNumber: "03" }],
      complete: false,
    },
  ]);
});

it("marks an entry complete once every Lesson Type is picked", () => {
  let state = recordPick(empty(), A, pick("89-110", "תרגיל", "03"));
  state = recordPick(state, A, pick("89-110", "הרצאה", "01"));

  expect(trayEntries(state, A, OFFERINGS)[0]).toMatchObject({
    chips: [
      { lessonType: "הרצאה", groupNumber: "01" },
      { lessonType: "תרגיל", groupNumber: "03" },
    ],
    complete: true,
  });
});

it("keeps a picked Lesson Type the Offering no longer has as a chip of its own", () => {
  // a re-import dropped the lab, and the Pick of it is still on the week
  let state = recordPick(empty(), A, pick("89-210", "מעבדה", "01"));
  state = recordPick(state, A, pick("89-210", "הרצאה", "01"));

  expect(trayEntries(state, A, OFFERINGS)[0]).toMatchObject({
    chips: [
      { lessonType: "הרצאה", groupNumber: "01" },
      { lessonType: "מעבדה", groupNumber: "01" },
    ],
    complete: true,
  });
});

it("lists a Course the Catalog does not have, with its chips unknown", () => {
  let state = addToTray(empty(), A, "89-999");
  state = recordPick(state, A, pick("89-999", "הרצאה", "01"));

  expect(trayEntries(state, A, OFFERINGS)).toEqual([
    {
      courseNumber: "89-999",
      origins: ["added", "picked"],
      known: false,
      // what the Picks say is still said; what the Course needs is not known
      chips: [{ lessonType: "הרצאה", groupNumber: "01" }],
      complete: null,
    },
  ]);
});

it("reads every Course as unknown when there is no Catalog to ask", () => {
  const state = addToTray(empty(), A, "89-110");

  expect(trayEntries(state, A, undefined)).toEqual([
    { courseNumber: "89-110", origins: ["added"], known: false, chips: [], complete: null },
  ]);
});

it("derives an empty Tray for a Variant or a Timetable that is not there", () => {
  expect(trayEntries(empty(), A, OFFERINGS)).toEqual([]);
});

it("derives planned Attempts into the Tray of a Variant that does not exist yet", () => {
  const state = withAttempts(empty(), [
    { courseNumber: "89-210", academicYear: 2027, semester: "fall", status: "planned" },
  ]);

  expect(trayEntries(state, A, OFFERINGS)).toEqual([
    {
      courseNumber: "89-210",
      origins: ["planned"],
      known: true,
      chips: [{ lessonType: "הרצאה" }],
      complete: false,
    },
  ]);
});
