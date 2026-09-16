import { expect, it } from "vitest";
/**
 * The one import of the Catalog's own schemas here, and it is read-only: this file is where
 * the two clocks are compared, so this is where the Catalog's narrower one is pinned. #42
 * widened a Blocked Time's `end` alone, and a Catalog Meeting arriving from Shoham — which
 * publishes no `24:00` — must not drift after it.
 */
import { examSchema, meetingSchema } from "../catalog/schema.ts";
import {
  attemptSchema,
  blockedTimeSchema,
  CURRENT_STATE_SCHEMA_VERSION,
  groupPickSchema,
  stateSchema,
  statusSchema,
  type BlockedTime,
  type GroupPick,
} from "./schema.ts";

it("accepts several Attempts for the same Course in different Semesters", () => {
  const retaken = stateSchema.safeParse({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: [
      { courseNumber: "89-110", academicYear: 2026, semester: "fall", status: "failed" },
      { courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "passed" },
    ],
  });

  expect(retaken.success).toBe(true);
  expect(retaken.data?.attempts).toHaveLength(2);
});

it("accepts every status", () => {
  for (const status of statusSchema.options) {
    const attempt = attemptSchema.safeParse({
      courseNumber: "89-110",
      academicYear: 2027,
      semester: "spring",
      status,
    });
    expect(attempt.success, status).toBe(true);
  }
});

it("accepts both kinds of grade and no grade at all", () => {
  const base = { courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "passed" };

  expect(attemptSchema.safeParse({ ...base, grade: { kind: "numeric", value: 87 } }).success)
    .toBe(true);
  expect(attemptSchema.safeParse({ ...base, grade: { kind: "pass-fail", passed: true } }).success)
    .toBe(true);
  expect(attemptSchema.safeParse(base).data?.grade).toBeUndefined();
});

it("refuses a grade that is neither kind", () => {
  const attempt = attemptSchema.safeParse({
    courseNumber: "89-110",
    academicYear: 2027,
    semester: "fall",
    status: "passed",
    grade: 87,
  });

  expect(attempt.success).toBe(false);
});

/**
 * The snapshot is a Meeting in shape but not in ownership: it is the student's record of what
 * was picked, and a Catalog that grows a field must not be able to stop it loading.
 */
it("keeps a Pick's snapshot of the Group's Meetings", () => {
  const pick = groupPickSchema.parse({
    courseNumber: "89-110",
    lessonType: "הרצאה",
    groupNumber: "01",
    meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
  });

  expect(pick.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
  ]);
});

it("refuses a Pick whose snapshot is missing, so it can never be dropped as an optimisation", () => {
  const pick = groupPickSchema.safeParse({
    courseNumber: "89-110",
    lessonType: "הרצאה",
    groupNumber: "01",
  });

  expect(pick.success).toBe(false);
});

it("gives a Blocked Time the shape a Clashes module can read without importing this one", () => {
  const blocked = blockedTimeSchema.parse({
    semester: "fall",
    day: "sunday",
    start: "08:00",
    end: "10:00",
    label: "commute",
  });

  // The structural contract with #14, written out rather than imported: a Blocked Time is
  // assignable to a weekly period, so Clashes can take one without either module depending
  // on the other. The Semester and Day are spelled out as their values rather than as
  // `string`, because widening either of them here would break Clashes while a `string`
  // target went on compiling — which is the breakage this test is named for.
  const period: {
    semester: "fall" | "spring" | "summer";
    day: "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday";
    start: string;
    end: string;
  } = blocked;
  expect(period).toMatchObject({ semester: "fall", day: "sunday", start: "08:00", end: "10:00" });
});

/**
 * A Blocked Time is typed by a student, unlike a Meeting which arrives from a Catalog, so
 * the hour it carries is the one likely to be written informally. An unpadded "9:00" sorts
 * after "10:00" as a string, which is how a Clash quietly fails to be one — so it is refused
 * here, where the file is read, rather than going unnoticed by whatever compares it later.
 */
it("refuses a clock time it cannot read, an unpadded hour included", () => {
  const written = (start: string) => ({
    semester: "fall",
    day: "sunday",
    start,
    end: "17:00",
    label: "work",
  });

  expect(blockedTimeSchema.safeParse(written("9:00")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(written("8am")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(written("24:00")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(written("09:60")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(written("09:00")).success).toBe(true);
});

/**
 * "Work until midnight" is `22:00`-`24:00`. Written `22:00`-`00:00` it keeps no time free at
 * all, and `22:00`-`23:59` quietly gives the last minute of the Day away, so `24:00` is the
 * one spelling that means what a student meant. It is an `end` and only an `end`: a Day has
 * nothing after the end of it for a span to start at, and `#39` already ruled that a Blocked
 * Time never wraps, so the other half of a night shift is the next Day's own row.
 */
it("lets a Blocked Time end at 24:00, the end of the Day, but never start there", () => {
  const untilMidnight = (start: string, end: string) => ({
    semester: "fall",
    day: "sunday",
    start,
    end,
    label: "work",
  });

  expect(blockedTimeSchema.safeParse(untilMidnight("22:00", "24:00")).success).toBe(true);
  expect(blockedTimeSchema.safeParse(untilMidnight("24:00", "24:00")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(untilMidnight("00:00", "24:00")).success).toBe(true);
});

it("refuses a time past the end of the Day wherever it accepts 24:00", () => {
  const until = (end: string) => ({
    semester: "fall",
    day: "sunday",
    start: "22:00",
    end,
    label: "work",
  });

  expect(blockedTimeSchema.safeParse(until("24:01")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(until("24:15")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(until("24:59")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(until("25:00")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(until("2400")).success).toBe(false);
  // Both spellings of the clock have to stay anchored at both ends. An alternation written
  // without a group around it anchors one branch and leaves the other trailing, and then
  // "23:0024:00" is a time.
  expect(blockedTimeSchema.safeParse(until("23:0024:00")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(until("23:000")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(until("0024:00")).success).toBe(false);
  expect(blockedTimeSchema.safeParse(until(" 24:00")).success).toBe(false);
});

/**
 * The end of the Day belongs to the Blocked Time and nowhere else. A Pick's snapshot is a
 * Catalog Meeting as it stood, and Shoham publishes no such time, so widening this one too
 * would put a value in a student's file that no Catalog could ever be compared against.
 */
it("keeps the end of the Day out of the Catalog, on a Meeting and on an Exam", () => {
  const meeting = (end: string) => ({ semester: "fall", day: "sunday", start: "22:00", end });
  const exam = (time: string) => ({ moed: "\u05d0", date: "2027-02-01", time });

  expect(meetingSchema.safeParse(meeting("24:00")).success).toBe(false);
  expect(meetingSchema.safeParse(meeting("23:59")).success).toBe(true);
  expect(examSchema.safeParse(exam("24:00")).success).toBe(false);
  expect(examSchema.safeParse(exam("23:59")).success).toBe(true);
});

it("keeps the end of the Day out of a Pick's snapshot of a Meeting", () => {
  const snapshot = (end: string) => ({
    courseNumber: "89-110",
    lessonType: "\u05d4\u05e8\u05e6\u05d0\u05d4",
    groupNumber: "01",
    meetings: [{ semester: "fall", day: "sunday", start: "22:00", end }],
  });

  expect(groupPickSchema.safeParse(snapshot("24:00")).success).toBe(false);
  expect(groupPickSchema.safeParse(snapshot("23:59")).success).toBe(true);
});

it("fills an all-but-empty file in, so a new State File is a version and nothing else", () => {
  const fresh = stateSchema.parse({ schemaVersion: CURRENT_STATE_SCHEMA_VERSION });

  expect(fresh).toEqual({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: [],
    timetables: [],
    pins: [],
    settings: { language: "en", examSpacingDays: 3 },
  });
});

it("strips a key it does not know rather than carrying it", () => {
  const parsed = attemptSchema.parse({
    courseNumber: "89-110",
    academicYear: 2027,
    semester: "fall",
    status: "planned",
    gpaWeight: 4,
  });

  expect(parsed).not.toHaveProperty("gpaWeight");
});

it("types a Blocked Time as the glossary describes it", () => {
  const blocked: BlockedTime = {
    semester: "summer",
    day: "friday",
    start: "09:30",
    end: "12:00",
    label: "work",
  };

  expect(blocked.label).toBe("work");
});

/**
 * The whole reason the code symbol is `GroupPick` while the domain term stays Pick: a type
 * named `Pick` shadows TypeScript's built-in, so a module importing one could not use the
 * other without aliasing. This file does both at once, which is the guarantee.
 */
it("leaves TypeScript's own Pick usable by anything that imports a Pick", () => {
  const named: Pick<GroupPick, "courseNumber" | "lessonType"> = {
    courseNumber: "89-110",
    lessonType: "הרצאה",
  };

  expect(named).toEqual({ courseNumber: "89-110", lessonType: "הרצאה" });
});
