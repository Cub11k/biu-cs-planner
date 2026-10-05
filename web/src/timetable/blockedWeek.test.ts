import { expect, it } from "vitest";
import type { Offering } from "./catalog.ts";
import type { BlockedTime, GroupPick } from "./picks.ts";
import { blockedTiles, daysShown, hourRange, spansOverlap, weekGroups } from "./week.ts";

/**
 * What the week decides about Blocked Times (#282), with no DOM: where one is drawn, the Days and
 * hours it brings onto the grid, and which pencil options it hatches as "would Clash".
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the times are not (ADR-0006).
 */
const WORK: BlockedTime = { semester: "fall", day: "tuesday", start: "13:00", end: "17:00", label: "work" };

const OFFERING: Offering = {
  courseNumber: "89-110",
  nameHebrew: "מבוא למדעי המחשב",
  credits: { known: true, total: 5 },
  semesters: ["fall"],
  groups: [
    // over the Blocked Time
    { number: "01", lessonType: "הרצאה", lecturers: [], meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }] },
    // clear of it
    { number: "02", lessonType: "הרצאה", lecturers: [], meetings: [{ semester: "fall", day: "sunday", start: "10:00", end: "12:00" }] },
    // over the tirgul picked below, which is another Lesson Type
    { number: "04", lessonType: "הרצאה", lecturers: [], meetings: [{ semester: "fall", day: "wednesday", start: "09:00", end: "11:00" }] },
    { number: "03", lessonType: "תרגיל", lecturers: [], meetings: [{ semester: "fall", day: "wednesday", start: "10:00", end: "12:00" }] },
    { number: "05", lessonType: "תרגיל", lecturers: [], meetings: [{ semester: "fall", day: "wednesday", start: "10:30", end: "11:30" }] },
  ],
  exams: { known: false, sittings: [] },
};

const TIRGUL: GroupPick = {
  courseNumber: "89-110",
  lessonType: "תרגיל",
  groupNumber: "03",
  meetings: [{ semester: "fall", day: "wednesday", start: "10:00", end: "12:00" }],
};

const hatched = (picks: GroupPick[] | undefined, blockedTimes: BlockedTime[]) =>
  weekGroups({ offering: OFFERING, picks, nameOf: (n) => n, semester: "fall", blockedTimes })
    .filter((group) => group.wouldClash === true)
    .map((group) => group.number);

it("hatches an option that overlaps a Blocked Time, and leaves the rest pencil", () => {
  expect(hatched([], [WORK])).toEqual(["01"]);
});

it("hatches an option that overlaps a Pick of another Lesson Type, not one of its own slot", () => {
  // tirgul 05 overlaps the tirgul picked, and picking it would replace that Pick, not Clash
  expect(hatched([TIRGUL], [])).toEqual(["04"]);
});

it("hatches nothing while the Picks are unread, since what is taken is not known", () => {
  expect(hatched(undefined, [WORK])).toEqual([]);
});

it("never hatches a Pick: red pen is for a Clash that is real", () => {
  const groups = weekGroups({
    offering: OFFERING,
    picks: [{ ...TIRGUL, lessonType: "הרצאה", groupNumber: "01", meetings: OFFERING.groups[0]!.meetings }],
    nameOf: (n) => n,
    semester: "fall",
    blockedTimes: [WORK],
  });
  expect(groups.find((group) => group.number === "01")?.wouldClash).toBeUndefined();
});

it("reads both ends in their own position, so a block to midnight overlaps the evening", () => {
  const evening = { day: "monday", start: "22:00", end: "00:00" } as const;
  expect(spansOverlap(evening, { day: "monday", start: "23:00", end: "23:30" })).toBe(true);
  expect(spansOverlap(evening, { day: "monday", start: "20:00", end: "22:00" })).toBe(false);
  expect(spansOverlap(evening, { day: "tuesday", start: "23:00", end: "23:30" })).toBe(false);
  expect(spansOverlap(evening, { day: "monday", start: "bad", end: "23:30" })).toBe(false);
});

it("places a Blocked Time by its minutes and position, and leaves off one that frees no time", () => {
  const tiles = blockedTiles(
    [
      WORK,
      { ...WORK, start: "10:00", end: "10:00", label: "typo" },
      { ...WORK, semester: "spring", label: "next semester" },
      { ...WORK, day: "monday", start: "22:00", end: "00:00", label: "evening" },
    ],
    "fall",
  );

  expect(tiles).toEqual([
    { key: "blocked:0", index: 0, day: "tuesday", label: "work", startMinutes: 780, endMinutes: 1020 },
    { key: "blocked:3", index: 3, day: "monday", label: "evening", startMinutes: 1320, endMinutes: 1440 },
  ]);
});

it("brings Friday onto the week, and widens the hours, for a Blocked Time alone", () => {
  const tiles = blockedTiles([{ ...WORK, day: "friday", start: "06:00", end: "08:00" }], "fall");

  expect(daysShown(tiles)).toContain("friday");
  expect(hourRange(tiles).startHour).toBe(6);
});
