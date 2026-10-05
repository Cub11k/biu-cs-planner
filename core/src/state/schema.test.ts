import { expect, it } from "vitest";
import {
  attemptSchema,
  blockedTimeSchema,
  CURRENT_STATE_SCHEMA_VERSION,
  groupPickSchema,
  settingsSchema,
  stateSchema,
  statusSchema,
  type BlockedTime,
  type GroupPick,
} from "./schema.ts";
import { DEFAULT_EXAM_SPACING_DAYS } from "../timetable/exams.ts";

it("accepts several Attempts for the same Course in different Semesters", () => {
  const retaken = stateSchema.safeParse({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: [
      { id: "a", courseNumber: "89-110", academicYear: 2026, semester: "fall", status: "failed" },
      { id: "b", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "passed" },
    ],
  });

  expect(retaken.success).toBe(true);
  expect(retaken.data?.attempts).toHaveLength(2);
});

it("accepts every status", () => {
  for (const status of statusSchema.options) {
    const attempt = attemptSchema.safeParse({
      id: "a",
      courseNumber: "89-110",
      academicYear: 2027,
      semester: "spring",
      status,
    });
    expect(attempt.success, status).toBe(true);
  }
});

it("accepts both kinds of grade and no grade at all", () => {
  const base = { id: "a", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "passed" };

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

it("fills an all-but-empty file in, so a new State File is a version and nothing else", () => {
  const fresh = stateSchema.parse({ schemaVersion: CURRENT_STATE_SCHEMA_VERSION });

  expect(fresh).toEqual({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: [],
    timetables: [],
    pins: [],
    programs: [],
    manualTicks: [],
    settings: { language: "en", examSpacingDays: 3, creditLoadLimit: 24 },
  });
});

/**
 * #164's bound, and the values it is a bound against. Why it has this shape — what `0` means, why
 * there is no ceiling, and why a State File already holding a refused value still opens — is
 * argued once, on the field in `./schema.ts`, and deliberately not again here.
 *
 * The infinities and `NaN` are handed to the schema directly, which is the only place they can be
 * tested from: JSON can write neither, so no request body can carry one — `JSON.stringify` turns
 * both into `null`, which this refuses too.
 */
it("refuses an Exam spacing a number of days cannot be, and allows zero", () => {
  const spacing = settingsSchema.shape.examSpacingDays;

  const refusals = [-5, -1, 2.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2, null];
  for (const refused of refusals) {
    expect(spacing.safeParse(refused).success, String(refused)).toBe(false);
  }
  for (const allowed of [0, 1, 3, 14, 365]) {
    expect(spacing.safeParse(allowed).success, String(allowed)).toBe(true);
  }
});

/**
 * One 3, and not two that agree today. The threshold the design settles on lives in the module
 * that checks it (`../timetable/exams.ts`), and this field defaults to that constant: a file that
 * says nothing about Exam spacing and a `checkExams` call that is given no threshold have to mean
 * the same thing, and two literals would be free to drift apart silently.
 */
it("defaults the Exam spacing to the one the check itself defaults to", () => {
  expect(settingsSchema.parse({}).examSpacingDays).toBe(DEFAULT_EXAM_SPACING_DAYS);
});

it("strips a key it does not know rather than carrying it", () => {
  const parsed = attemptSchema.parse({
    id: "a",
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
