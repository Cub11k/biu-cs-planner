import { expect, it } from "vitest";
import {
  attemptSchema,
  blockedTimeSchema,
  CURRENT_STATE_SCHEMA_VERSION,
  pickSchema,
  stateSchema,
  statusSchema,
  type BlockedTime,
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

it("keeps a Pick's snapshot of the Group's Meetings", () => {
  const pick = pickSchema.parse({
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
  const pick = pickSchema.safeParse({
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
  // on the other.
  const period: { semester: string; day: string; start: string; end: string } = blocked;
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
