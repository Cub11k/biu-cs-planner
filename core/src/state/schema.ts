import { z } from "zod";
import { daySchema, semesterSchema } from "../catalog/schema.ts";

/**
 * A State File is one student's or one scenario's own data: Attempts, Timetables, Pins and
 * settings. As with the Catalog the Zod schemas are the single source of truth — the types
 * below are inferred from them, every read is validated through them, and `file.ts` exports
 * JSON Schema from them. Unknown keys are stripped rather than carried.
 *
 * **Courses are referenced by course number, never by Catalog entry.** Nothing here holds a
 * pointer into a Catalog, so importing a new year's Catalog cannot invalidate a State File.
 * `semesterSchema` and `daySchema` are shared vocabulary rather than entries — closed sets of
 * values, which a Catalog can only ever widen, and which both sides must agree on for a
 * snapshot to be comparable at all. Every record shape is declared here, for the reason under
 * `pickedMeetingSchema`.
 */
export const CURRENT_STATE_SCHEMA_VERSION = 1;

/** Literal pattern, never built from data (ADR-0007). */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The same clock plus `"24:00"`, the end of the Day. A Blocked Time's `end` is the only field
 * that takes it, and the extra literal rather than a widened `CLOCK_TIME` is what keeps it
 * that way: a field declared later inherits the narrow clock unless it asks for this one.
 *
 * It buys the one spelling of "work until midnight" that occupies time. `22:00`-`00:00` keeps
 * no time free — `file.ts` warns `blocked-time-does-not-advance` about it — and `22:00`-`23:59`
 * gives the Day's last minute away. A `start` still tops out at `23:59`, because a Day has
 * nothing after the end of it to start at, and a Pick's snapshot of a Meeting keeps the narrow
 * clock: Shoham publishes no `24:00`, so a snapshot carrying one could never match the Catalog
 * Meeting it is compared against. Shoham does write an end of the Day — as `00:00`, which
 * `web/src/timetable/week.ts` reads and `overlapOf` in the Clashes module does not. That
 * disagreement is older than this and is not resolved here; #42 widened one `end` and left
 * every other reading of the clock as it found it.
 */
const CLOCK_TIME_OR_END_OF_DAY = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

export const statusSchema = z.enum([
  "planned",
  "registered",
  "passed",
  "failed",
  "exempt",
  "credited",
]);

/**
 * Numeric or pass/fail, because some Prerequisites demand a minimum grade. There is no GPA,
 * and no range check here: a grade outside 0–100 is a domain Warning for a Plan check to
 * raise, not a reason to refuse the file that holds it.
 */
export const gradeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("numeric"), value: z.number() }),
  z.object({ kind: z.literal("pass-fail"), passed: z.boolean() }),
]);

/**
 * One instance of taking a Course in a Semester. A retake is simply another Attempt, so
 * nothing may assume one Attempt per Course — there is deliberately no key here that would
 * make a second one for the same Course impossible.
 */
export const attemptSchema = z.object({
  courseNumber: z.string(),
  academicYear: z.number(),
  semester: semesterSchema,
  status: statusSchema,
  grade: gradeSchema.optional(),
});

/**
 * A Meeting as it stood when it was picked. Deliberately declared here rather than borrowed
 * from the Catalog, even though the two are the same shape today and the snapshot exists to
 * be compared against a Catalog's Meetings.
 *
 * A snapshot is a student's data, versioned by `CURRENT_STATE_SCHEMA_VERSION`; a Catalog's
 * Meeting is versioned by the Catalog's own counter, and the two move independently. Borrow
 * it and the day the crawler learns to read rooms — a required `room` on a Catalog Meeting —
 * every State File on every disk fails to load its Picks, with no migration possible, because
 * the version that would have triggered one never changed. A Catalog change must never be
 * able to invalidate a State File; that is the rule this whole file is written around, and a
 * shared record shape is the one way through it.
 */
export const pickedMeetingSchema = z.object({
  semester: semesterSchema,
  day: daySchema,
  start: z.string().regex(CLOCK_TIME),
  end: z.string().regex(CLOCK_TIME),
});

/**
 * A Pick: one Group chosen for one Lesson Type of an Offering, carrying a snapshot of that
 * Group's Meetings as they stood when it was picked. The snapshot is the point and is
 * required — re-import compares it against the new Catalog to show "changed since picked", so
 * it is not redundant with the Catalog and must not be dropped as an optimisation.
 *
 * The domain term is **Pick** and prose should say so; the code symbol is `GroupPick` only
 * because a type called `Pick` shadows TypeScript's built-in `Pick<T, K>`, which every
 * importer would otherwise have to alias around. Recorded in `CONTEXT.md` under Pick.
 */
export const groupPickSchema = z.object({
  courseNumber: z.string(),
  lessonType: z.string(),
  groupNumber: z.string(),
  meetings: z.array(pickedMeetingSchema),
});

/**
 * A Variant and a Timetable without their lists. `file.ts` parses these first and then fills
 * the lists in element by element, so one unreadable Pick costs a Pick rather than the whole
 * Variant that holds it.
 */
export const variantHeadSchema = z.object({
  name: z.string(),
  /**
   * Exactly one Variant of a Timetable is primary. A file that breaks it still opens —
   * `parseStateFile` reports it as a Warning, because a Warning never blocks an edit.
   */
  primary: z.boolean().default(false),
});

/** A named alternative set of Picks for a Semester. */
export const variantSchema = variantHeadSchema.extend({
  picks: z.array(groupPickSchema).default([]),
});

/**
 * A weekly period to keep free, such as work or commute. The four fields before `label` are
 * a structural contract with the Clashes module: it consumes `{ semester, day, start, end }`
 * without either module importing the other, so they are spelled out here rather than
 * borrowed from a Meeting — a Blocked Time is not a Meeting and must not drift with one.
 *
 * `end` is the one field on either side of that contract that reads `"24:00"`, so that a
 * Blocked Time can cover the Day's last minute; see `CLOCK_TIME_OR_END_OF_DAY`. It is a
 * widening, so every State File that was valid before this is still valid.
 */
export const blockedTimeSchema = z.object({
  semester: semesterSchema,
  day: daySchema,
  start: z.string().regex(CLOCK_TIME),
  end: z.string().regex(CLOCK_TIME_OR_END_OF_DAY),
  label: z.string(),
});

/** The weekly schedule work for one Semester of one Academic Year. */
export const timetableHeadSchema = z.object({
  academicYear: z.number(),
  semester: semesterSchema,
});

export const timetableSchema = timetableHeadSchema.extend({
  variants: z.array(variantSchema).default([]),
  blockedTimes: z.array(blockedTimeSchema).default([]),
});

/**
 * A student's override fixing an Assignment. `requirementId` names a Requirement inside a
 * Requirements File and is opaque here — resolving it is the Progress engine's job, and a
 * Pin that no longer resolves is a Warning there rather than a broken State File.
 */
export const pinSchema = z.object({
  courseNumber: z.string(),
  requirementId: z.string(),
});

export const settingsSchema = z.object({
  language: z.enum(["en", "he"]).default("en"),
  /** Exams closer together than this raise a spacing Warning; see `docs/design.md`. */
  examSpacingDays: z.number().default(3),
});

export const stateSchema = z.object({
  schemaVersion: z.number(),
  attempts: z.array(attemptSchema).default([]),
  timetables: z.array(timetableSchema).default([]),
  pins: z.array(pinSchema).default([]),
  settings: settingsSchema.prefault({}),
});

export type Status = z.infer<typeof statusSchema>;
export type Grade = z.infer<typeof gradeSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type PickedMeeting = z.infer<typeof pickedMeetingSchema>;
export type GroupPick = z.infer<typeof groupPickSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type BlockedTime = z.infer<typeof blockedTimeSchema>;
export type Timetable = z.infer<typeof timetableSchema>;
export type Pin = z.infer<typeof pinSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type State = z.infer<typeof stateSchema>;
