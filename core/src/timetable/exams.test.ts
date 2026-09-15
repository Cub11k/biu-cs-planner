import { afterEach, expect, it } from "vitest";
import { checkExams, DEFAULT_EXAM_SPACING_DAYS } from "./exams.ts";
import type { Offering } from "../catalog/schema.ts";

/** An invented Offering with Exams. No crawl data reaches a test. */
function offering(
  courseNumber: string,
  sittings: { moed: string; date: string; time?: string }[],
): Offering {
  return {
    courseNumber,
    nameHebrew: `קורס ${courseNumber}`,
    credits: { known: true, total: 4 },
    semesters: ["fall"],
    groups: [],
    exams: {
      known: true,
      sittings: sittings.map((s) => ({ moed: s.moed, date: s.date, time: s.time ?? "09:00" })),
    },
  };
}

/** An Offering no part has published Exams for, which is not the same as having none. */
function offeringWithoutKnownExams(courseNumber: string): Offering {
  return { ...offering(courseNumber, []), exams: { known: false, sittings: [] } };
}

// Two tests move the machine's timezone to prove the day gaps do not follow it. Putting it
// back means deleting the variable when there was none: assigning `undefined` would leave
// the literal string "undefined" behind for every test after them.
const originalTimezone = process.env.TZ;
afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

it("calls two Exams on the same day a Clash, whichever Moed each belongs to", () => {
  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21", time: "09:00" }]),
    offering("89-112", [{ moed: "מועד ב", date: "2027-01-21", time: "13:00" }]),
  ]);

  expect(result.warnings).toEqual([
    {
      kind: "exam-clash",
      date: "2027-01-21",
      sittings: [
        { courseNumber: "89-110", moed: "מועד א", date: "2027-01-21", time: "09:00" },
        { courseNumber: "89-112", moed: "מועד ב", date: "2027-01-21", time: "13:00" },
      ],
    },
  ]);
});

it("calls a same-day pair a Clash and not also a spacing Warning", () => {
  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offering("89-112", [{ moed: "מועד א", date: "2027-01-21" }]),
  ]);

  expect(result.warnings.map((w) => w.kind)).toEqual(["exam-clash"]);
});

it("warns about each Exam fewer than the default three days from another", () => {
  const first = { courseNumber: "89-110", moed: "מועד א", date: "2027-01-21", time: "09:00" };
  const second = { courseNumber: "89-112", moed: "מועד א", date: "2027-01-23", time: "09:00" };

  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offering("89-112", [{ moed: "מועד א", date: "2027-01-23" }]),
  ]);

  expect(DEFAULT_EXAM_SPACING_DAYS).toBe(3);
  expect(result.warnings).toEqual([
    { kind: "exam-spacing", sitting: first, nearbyCount: 1, nearby: [second] },
    { kind: "exam-spacing", sitting: second, nearbyCount: 1, nearby: [first] },
  ]);
});

it("leaves Exams exactly the threshold apart alone", () => {
  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offering("89-112", [{ moed: "מועד א", date: "2027-01-24" }]),
  ]);

  expect(result.warnings).toEqual([]);
});

it("takes the threshold as a parameter, so raising it warns about a wider gap", () => {
  const offerings = [
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offering("89-112", [{ moed: "מועד א", date: "2027-01-25" }]),
  ];

  expect(checkExams(offerings).warnings).toEqual([]);
  expect(checkExams(offerings, { spacingDays: 5 }).warnings).toMatchObject([
    { kind: "exam-spacing", sitting: { courseNumber: "89-110" }, nearbyCount: 1 },
    { kind: "exam-spacing", sitting: { courseNumber: "89-112" }, nearbyCount: 1 },
  ]);
});

it("tells an Exam how many others crowd it, not which pairs are tight", () => {
  // Every one of the three is within three days of both the others, which as a list of
  // pairs would be three Warnings saying the same thing about the same week.
  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offering("89-112", [{ moed: "מועד א", date: "2027-01-22" }]),
    offering("89-114", [{ moed: "מועד א", date: "2027-01-23" }]),
  ]);

  expect(result.warnings).toMatchObject([
    { kind: "exam-spacing", sitting: { courseNumber: "89-110" }, nearbyCount: 2 },
    { kind: "exam-spacing", sitting: { courseNumber: "89-112" }, nearbyCount: 2 },
    { kind: "exam-spacing", sitting: { courseNumber: "89-114" }, nearbyCount: 2 },
  ]);
});

it("names the Exams crowding one, in rail order, and counts only those in range", () => {
  // The middle sitting has one on either side; the outer two are four days apart and so
  // are near the middle one only. This is the case the per-Exam count exists for.
  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offering("89-112", [{ moed: "מועד א", date: "2027-01-23" }]),
    offering("89-114", [{ moed: "מועד א", date: "2027-01-25" }]),
  ]);

  expect(result.warnings).toMatchObject([
    { sitting: { courseNumber: "89-110" }, nearbyCount: 1, nearby: [{ courseNumber: "89-112" }] },
    {
      sitting: { courseNumber: "89-112" },
      nearbyCount: 2,
      nearby: [{ courseNumber: "89-110" }, { courseNumber: "89-114" }],
    },
    { sitting: { courseNumber: "89-114" }, nearbyCount: 1, nearby: [{ courseNumber: "89-112" }] },
  ]);
});

it("returns the sittings in date order, each with the day gap to the previous one", () => {
  const result = checkExams([
    offering("89-114", [{ moed: "מועד א", date: "2027-02-04" }]),
    offering("89-110", [
      { moed: "מועד א", date: "2027-01-21" },
      { moed: "מועד ב", date: "2027-02-18" },
    ]),
  ]);

  expect(result.sittings).toEqual([
    {
      courseNumber: "89-110",
      moed: "מועד א",
      date: "2027-01-21",
      time: "09:00",
      daysSincePrevious: undefined,
    },
    {
      courseNumber: "89-114",
      moed: "מועד א",
      date: "2027-02-04",
      time: "09:00",
      daysSincePrevious: 14,
    },
    {
      courseNumber: "89-110",
      moed: "מועד ב",
      date: "2027-02-18",
      time: "09:00",
      daysSincePrevious: 14,
    },
  ]);
});

it("orders same-day sittings by time, then course number", () => {
  const result = checkExams([
    offering("89-114", [{ moed: "מועד א", date: "2027-01-21", time: "09:00" }]),
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21", time: "09:00" }]),
    offering("89-112", [{ moed: "מועד א", date: "2027-01-21", time: "08:00" }]),
  ]);

  expect(result.sittings.map((s) => s.courseNumber)).toEqual(["89-112", "89-110", "89-114"]);
  expect(result.sittings.map((s) => s.daysSincePrevious)).toEqual([undefined, 0, 0]);
});

it("counts calendar days in UTC, so a DST change cannot shorten a gap", () => {
  // Israel moves to summer time between these two dates, making the local-time
  // difference 95 hours where the calendar difference is four days.
  process.env.TZ = "Asia/Jerusalem";

  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-03-25" }]),
    offering("89-112", [{ moed: "מועד א", date: "2027-03-29" }]),
  ]);

  expect(result.sittings[1]?.daysSincePrevious).toBe(4);
  expect(result.warnings).toEqual([]);
});

it("counts the same gap from the far side of the date line", () => {
  process.env.TZ = "Pacific/Kiritimati";

  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offering("89-112", [{ moed: "מועד א", date: "2027-01-22" }]),
  ]);

  expect(result.sittings[1]?.daysSincePrevious).toBe(1);
  expect(result.warnings).toMatchObject([
    { kind: "exam-spacing", nearbyCount: 1 },
    { kind: "exam-spacing", nearbyCount: 1 },
  ]);
});

it("counts a Course whose Exams are unknown and takes no Warning from it", () => {
  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offeringWithoutKnownExams("89-112"),
    offeringWithoutKnownExams("89-114"),
  ]);

  expect(result.coursesWithUnknownExams).toBe(2);
  expect(result.warnings).toEqual([]);
  expect(result.sittings).toHaveLength(1);
});

it("ignores sittings listed under an Offering that says its Exams are unknown", () => {
  const partial: Offering = {
    ...offering("89-112", [{ moed: "מועד א", date: "2027-01-21" }]),
    exams: {
      known: false,
      sittings: [{ moed: "מועד א", date: "2027-01-21", time: "09:00" }],
    },
  };

  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    partial,
  ]);

  expect(result.sittings).toHaveLength(1);
  expect(result.warnings).toEqual([]);
  expect(result.coursesWithUnknownExams).toBe(1);
});

it("takes one Offering's sittings once however many Groups it has", () => {
  const withGroups: Offering = {
    ...offering("89-110", [
      { moed: "מועד א", date: "2027-01-21" },
      { moed: "מועד ב", date: "2027-02-18" },
    ]),
    groups: [
      { number: "01", lessonType: "הרצאה", lecturers: [], meetings: [] },
      { number: "01", lessonType: "תרגיל", lecturers: [], meetings: [] },
      { number: "02", lessonType: "תרגיל", lecturers: [], meetings: [] },
    ],
  };

  const result = checkExams([withGroups]);

  expect(result.sittings).toHaveLength(2);
  expect(result.warnings).toEqual([]);
});

it("counts a Course whose Exams are unknown once, however often it is handed in", () => {
  const unknown = offeringWithoutKnownExams("89-112");

  const result = checkExams([unknown, unknown, offeringWithoutKnownExams("89-114")]);

  expect(result.coursesWithUnknownExams).toBe(2);
});

it("treats the same Offering handed in twice as the one set of Exams it is", () => {
  const one = offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]);

  const result = checkExams([one, one]);

  expect(result.sittings).toHaveLength(1);
  expect(result.warnings).toEqual([]);
});

it("keeps both Offerings of one Course when their Exams differ", () => {
  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offering("89-110", [{ moed: "מועד א", date: "2027-06-21" }]),
  ]);

  expect(result.sittings.map((s) => s.date)).toEqual(["2027-01-21", "2027-06-21"]);
});

it("finds nothing in an empty Timetable", () => {
  const result = checkExams([]);

  expect(result).toEqual({ sittings: [], warnings: [], coursesWithUnknownExams: 0 });
});

it("treats an unfamiliar Moed label exactly like a familiar one", () => {
  const result = checkExams([
    offering("89-110", [{ moed: "מועד מיוחד", date: "2027-01-21" }]),
    offering("89-112", [{ moed: "", date: "2027-01-21" }]),
  ]);

  expect(result.warnings).toMatchObject([{ kind: "exam-clash", date: "2027-01-21" }]);
});

it("puts the Clashes first, then the crowded Exams in rail order", () => {
  const result = checkExams([
    offering("89-110", [{ moed: "מועד א", date: "2027-01-21" }]),
    offering("89-112", [{ moed: "מועד ב", date: "2027-01-21" }]),
    offering("89-114", [{ moed: "מועד א", date: "2027-01-22" }]),
  ]);

  // The same-day pair Clashes and does not count towards either one's crowding, so each of
  // them is near the third Exam alone, while the third is near both of them.
  expect(result.warnings).toMatchObject([
    { kind: "exam-clash", date: "2027-01-21" },
    { kind: "exam-spacing", sitting: { courseNumber: "89-110" }, nearbyCount: 1 },
    { kind: "exam-spacing", sitting: { courseNumber: "89-112" }, nearbyCount: 1 },
    { kind: "exam-spacing", sitting: { courseNumber: "89-114" }, nearbyCount: 2 },
  ]);
});
