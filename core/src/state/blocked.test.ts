import { expect, it } from "vitest";
import {
  addBlockedTime,
  blockedTimeWarnings,
  copyBlockedTimes,
  removeBlockedTime,
  replaceBlockedTime,
  splitBlockedRange,
} from "./blocked.ts";
import { clashesIn, recordPick } from "./picks.ts";
import { stateSchema, type BlockedTime, type GroupPick, type State } from "./schema.ts";
import { createVariant } from "./variants.ts";
import type { TimetableAt } from "./timetable.ts";

/**
 * Blocked Times as a student edits them (#282): added — a range that wraps past midnight split
 * into two rows, as the glossary rules (#39) — replaced, removed, and copied to another Semester.
 *
 * Fixture data is invented. 89-110 is a real BIU course number, the Meetings are not, and no
 * crawled data is committed to this repo (ADR-0006).
 */
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const SPRING_2027 = { academicYear: 2027, semester: "spring" } as const;

const empty = (): State => stateSchema.parse({ schemaVersion: 1 });

const blocked = (state: State, at: TimetableAt = FALL_2027): BlockedTime[] | undefined =>
  state.timetables.find((t) => t.academicYear === at.academicYear && t.semester === at.semester)
    ?.blockedTimes;

const WORK = { day: "tuesday", start: "13:00", end: "17:00", label: "work" } as const;

it("adds a Blocked Time to the Semester's Timetable, making the Timetable", () => {
  const state = addBlockedTime(empty(), FALL_2027, WORK);

  expect(state.timetables).toEqual([
    { ...FALL_2027, variants: [], blockedTimes: [{ semester: "fall", ...WORK }] },
  ]);
});

it("splits a range that wraps past midnight into two rows on consecutive Days", () => {
  expect(
    splitBlockedRange("fall", { day: "monday", start: "23:00", end: "01:00", label: "shift" }),
  ).toEqual([
    { semester: "fall", day: "monday", start: "23:00", end: "00:00", label: "shift" },
    { semester: "fall", day: "tuesday", start: "00:00", end: "01:00", label: "shift" },
  ]);
});

it("takes a range ending at midnight as the end of that Day, one row", () => {
  expect(
    splitBlockedRange("fall", { day: "monday", start: "22:00", end: "00:00", label: "evening" }),
  ).toEqual([{ semester: "fall", day: "monday", start: "22:00", end: "00:00", label: "evening" }]);
});

it("takes 00:00 to 00:00 as the whole Day, one row", () => {
  expect(
    splitBlockedRange("fall", { day: "sunday", start: "00:00", end: "00:00", label: "away" }),
  ).toEqual([{ semester: "fall", day: "sunday", start: "00:00", end: "00:00", label: "away" }]);
});

it("keeps a range that does not advance as typed, and warns about it", () => {
  const state = addBlockedTime(empty(), FALL_2027, {
    day: "sunday",
    start: "10:00",
    end: "10:00",
    label: "typo",
  });

  // one row, kept: a Warning never costs a student what they typed
  expect(blocked(state)).toEqual([
    { semester: "fall", day: "sunday", start: "10:00", end: "10:00", label: "typo" },
  ]);
  expect(blockedTimeWarnings(state, FALL_2027)).toEqual([
    { kind: "blocked-time-does-not-advance", index: 0, start: "10:00", end: "10:00" },
  ]);
});

it("keeps only Friday's part of a Friday night, since no Day follows Friday", () => {
  expect(
    splitBlockedRange("fall", { day: "friday", start: "23:00", end: "02:00", label: "shift" }),
  ).toEqual([{ semester: "fall", day: "friday", start: "23:00", end: "00:00", label: "shift" }]);
});

it("adds the two rows of a wrapping range at the end, in Day order", () => {
  const state = addBlockedTime(addBlockedTime(empty(), FALL_2027, WORK), FALL_2027, {
    day: "wednesday",
    start: "23:30",
    end: "06:00",
    label: "night",
  });

  expect(blocked(state)?.map((b) => [b.day, b.start, b.end])).toEqual([
    ["tuesday", "13:00", "17:00"],
    ["wednesday", "23:30", "00:00"],
    ["thursday", "00:00", "06:00"],
  ]);
  expect(blockedTimeWarnings(state, FALL_2027)).toEqual([]);
});

it("replaces one Blocked Time where it stands, splitting a wrapping replacement", () => {
  let state = addBlockedTime(empty(), FALL_2027, WORK);
  state = addBlockedTime(state, FALL_2027, { ...WORK, day: "thursday", label: "gym" });

  const replaced = replaceBlockedTime(state, FALL_2027, 0, {
    day: "monday",
    start: "23:00",
    end: "01:00",
    label: "shift",
  });

  expect(blocked(replaced)?.map((b) => [b.day, b.start, b.end, b.label])).toEqual([
    ["monday", "23:00", "00:00", "shift"],
    ["tuesday", "00:00", "01:00", "shift"],
    ["thursday", "13:00", "17:00", "gym"],
  ]);
});

it("hands the same State back for a replacement that changes nothing or misses", () => {
  const state = addBlockedTime(empty(), FALL_2027, WORK);

  expect(replaceBlockedTime(state, FALL_2027, 0, WORK)).toBe(state);
  expect(replaceBlockedTime(state, FALL_2027, 3, WORK)).toBe(state);
  expect(replaceBlockedTime(state, SPRING_2027, 0, WORK)).toBe(state);
});

it("removes one Blocked Time by its position", () => {
  let state = addBlockedTime(empty(), FALL_2027, WORK);
  state = addBlockedTime(state, FALL_2027, { ...WORK, label: "gym" });

  expect(blocked(removeBlockedTime(state, FALL_2027, 0))?.map((b) => b.label)).toEqual(["gym"]);
});

it("hands the same State back when removing a position that is not there", () => {
  const state = addBlockedTime(empty(), FALL_2027, WORK);

  expect(removeBlockedTime(state, FALL_2027, 1)).toBe(state);
  expect(removeBlockedTime(state, FALL_2027, -1)).toBe(state);
  expect(removeBlockedTime(state, SPRING_2027, 0)).toBe(state);
});

it("copies every Blocked Time to another Semester, rewriting the Semester they carry", () => {
  const state = addBlockedTime(empty(), FALL_2027, WORK);

  const copied = copyBlockedTimes(state, FALL_2027, SPRING_2027);

  expect(blocked(copied, SPRING_2027)).toEqual([{ semester: "spring", ...WORK }]);
  // the source is left as it was
  expect(blocked(copied)).toEqual([{ semester: "fall", ...WORK }]);
});

it("adds to the target Semester's Blocked Times rather than replacing them", () => {
  let state = addBlockedTime(empty(), FALL_2027, WORK);
  state = addBlockedTime(state, SPRING_2027, { ...WORK, label: "gym" });

  const copied = copyBlockedTimes(state, FALL_2027, SPRING_2027);

  expect(blocked(copied, SPRING_2027)?.map((b) => b.label)).toEqual(["gym", "work"]);
});

it("does not copy a Blocked Time the target already holds, so copying twice copies once", () => {
  const once = copyBlockedTimes(addBlockedTime(empty(), FALL_2027, WORK), FALL_2027, SPRING_2027);

  expect(copyBlockedTimes(once, FALL_2027, SPRING_2027)).toBe(once);
});

it("copies across Academic Years too", () => {
  const next = { academicYear: 2028, semester: "fall" } as const;

  const copied = copyBlockedTimes(addBlockedTime(empty(), FALL_2027, WORK), FALL_2027, next);

  expect(blocked(copied, next)).toEqual([{ semester: "fall", ...WORK }]);
});

it("hands the same State back when there is nothing to copy, or it is the same Semester", () => {
  const state = addBlockedTime(empty(), FALL_2027, WORK);

  expect(copyBlockedTimes(state, SPRING_2027, FALL_2027)).toBe(state);
  expect(copyBlockedTimes(state, FALL_2027, FALL_2027)).toBe(state);
});

it("keeps Blocked Times on the Semester, so every Variant sees them", () => {
  const state = createVariant(addBlockedTime(empty(), FALL_2027, WORK), { ...FALL_2027, variant: "B" });

  expect(state.timetables[0]?.variants.map((v) => v.name)).toEqual(["B"]);
  expect(blocked(state)).toHaveLength(1);
});

it("reports a Clash between a Pick and a Blocked Time with the Blocked Time's label", () => {
  const lecture: GroupPick = {
    courseNumber: "89-110",
    lessonType: "הרצאה",
    groupNumber: "01",
    meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
  };
  const at = { ...FALL_2027, variant: "A" };
  const state = recordPick(addBlockedTime(empty(), FALL_2027, WORK), at, lecture);

  expect(clashesIn(state, at)).toEqual([
    {
      kind: "meeting-blocked-time",
      overlap: { semester: "fall", day: "tuesday", start: "15:00", end: "17:00" },
      group: { courseNumber: "89-110", lessonType: "הרצאה", number: "01" },
      meeting: lecture.meetings[0],
      blockedTime: { semester: "fall", ...WORK },
      blockedTimeIndex: 0,
    },
  ]);
});

it("reports a Clash with the second row of a split night, at its own position", () => {
  const early: GroupPick = {
    courseNumber: "89-110",
    lessonType: "תרגיל",
    groupNumber: "03",
    meetings: [{ semester: "fall", day: "tuesday", start: "00:30", end: "02:00" }],
  };
  const at = { ...FALL_2027, variant: "A" };
  const state = recordPick(
    addBlockedTime(empty(), FALL_2027, { day: "monday", start: "23:00", end: "01:00", label: "shift" }),
    at,
    early,
  );

  expect(clashesIn(state, at).map((clash) => clash.kind === "meeting-blocked-time" && clash.blockedTimeIndex)).toEqual([1]);
});

it("warns about nothing for a Timetable that is not there", () => {
  expect(blockedTimeWarnings(empty(), FALL_2027)).toEqual([]);
});
