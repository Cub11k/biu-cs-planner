import { z } from "zod";
import { daySchema, semesterSchema } from "../catalog/schema.ts";
/**
 * One constant, imported rather than copied, so a file that says nothing about Exam spacing and a
 * `checkExams` call given no threshold cannot come to mean two different numbers (#164).
 *
 * **Not in tension with what `blockedTimeSchema` says below.** That doc declines to *borrow a
 * record shape* from the Clashes module, because a Blocked Time is not a Meeting and the two must
 * be free to differ; this borrows a number both sides have to agree on, which is the opposite
 * situation. The direction is one `./picks.ts` already takes (it imports `../timetable/clashes.ts`)
 * and it closes no loop: `../timetable/exams.ts` imports one type from `../catalog/schema.ts` and
 * nothing from here.
 */
import { DEFAULT_EXAM_SPACING_DAYS } from "../timetable/exams.ts";

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
 * What names one Attempt (#290). Opaque: a UUID for an Attempt this build created, and
 * `attempt-<n>` for one a file held without an id, which the reader fills in (`file.ts`).
 */
export const attemptIdSchema = z.string().min(1).max(200);

/**
 * One instance of taking a Course in a Semester. A retake is simply another Attempt, so
 * nothing may assume one Attempt per Course — there is deliberately no key here that would
 * make a second one for the same Course impossible.
 *
 * **`id` is what names an Attempt** (#290), because nothing else can: a retake makes course
 * number plus Semester non-unique, and a position moves with every add and remove. Two tabs and
 * Plan Diffs both have to name one Attempt and mean the same one tomorrow. `CONTEXT.md` records
 * the decision under Attempt.
 *
 * **Required in the State, and the schema version did not move for it.** A file written before
 * Attempts had ids still opens: `file.ts` reads an Attempt with no id, or with an id an earlier
 * Attempt already took, and gives it `attempt-<n>`, the smallest `n` no other Attempt in the file
 * uses. That is deterministic, so every read of an unchanged file names its Attempts alike, and
 * the first save writes the ids down. It needs no migration, by the rule `variantSchema`'s `tray`
 * set: an older build strips the field on save, and the next read here fills it in again.
 */
export const attemptSchema = z.object({
  id: attemptIdSchema,
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

/**
 * A named alternative set of Picks for a Semester, and its Tray.
 *
 * **`tray` is the Courses the student added to this Variant directly**, by course number, in the
 * order they were added (#283). It is not the Tray a student sees: that is derived
 * (`trayEntries` in `./tray.ts`), adding every Course with a Pick here and every Course with a
 * planned Attempt in the Semester, so only what cannot be derived is stored.
 *
 * **Defaulted, and the schema version did not move for it.** A file written before the Tray
 * existed has no `tray` on any Variant, and reads as every Variant having an empty one — which is
 * exactly what that file meant, so it opens unchanged and needs no migration, the test #173 set.
 * The cost is on the other side: a build older than this one strips the key it does not know, so
 * opening a newer file there and saving loses the Courses added to a Tray (never a Pick, which
 * re-derives them). That is a downgrade, which nothing here promises to survive, and is said here
 * rather than paid for with a version every older build would then refuse to open at all.
 */
export const variantSchema = variantHeadSchema.extend({
  picks: z.array(groupPickSchema).default([]),
  tray: z.array(z.string()).default([]),
});

/**
 * A weekly period to keep free, such as work or commute. The four fields before `label` are
 * a structural contract with the Clashes module: it consumes `{ semester, day, start, end }`
 * without either module importing the other, so they are spelled out here rather than
 * borrowed from a Meeting — a Blocked Time is not a Meeting and must not drift with one.
 */
export const blockedTimeSchema = z.object({
  semester: semesterSchema,
  day: daySchema,
  start: z.string().regex(CLOCK_TIME),
  end: z.string().regex(CLOCK_TIME),
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
 * Which Requirement a Pin or a ticked Manual Requirement names: a Requirement id, and the
 * Requirements File it is an id in (#287).
 *
 * **The file is named because an id is unique only within one file**, and a double major has
 * two. Without it a Pin on `core` in one Program was a Pin on `core` in the other as well,
 * whatever that Requirement was. The name is the one a Programs entry carries — the file name
 * within `requirements/`, never a path and never its content.
 *
 * **Optional, and the schema version did not move for it.** Pins were written before this field
 * existed, so a Pin without one still opens, and it names the student's **first Program**
 * (`effectiveFile` in `./programs.ts`): a single major, which is every State File written before
 * Programs could be chosen, has only that one. Every Pin and tick this build writes names its
 * file. `CONTEXT.md` records the decision under Pin.
 *
 * Opaque here, as the id always was: resolving it is the Progress engine's job, and a Pin that no
 * longer resolves is a Warning there rather than a broken State File.
 */
const requirementRefShape = {
  requirementId: z.string(),
  requirementsFile: z.string().optional(),
};

/** A student's override fixing an Assignment: this Course counts toward this Requirement. */
export const pinSchema = z.object({
  courseNumber: z.string(),
  ...requirementRefShape,
});

/**
 * A Manual Requirement the student has ticked off (#288), referenced the way a Pin references
 * its Requirement. Kept as a list of the ticked ones: an unticked Manual Requirement is simply
 * not here.
 */
export const manualTickSchema = z.object(requirementRefShape);

/**
 * One Program the student is enrolled in (#287): which Requirements File holds its rules, by the
 * file's name within `requirements/`, and which of its Tracks the student chose, by the Track's
 * id. A name and an id, never content, so a reissued file is picked up as it is.
 */
export const programSchema = z.object({
  requirementsFile: z.string().min(1),
  track: z.string().min(1).optional(),
});

/**
 * The Academic Year and Semester the student started in (#287). Declared here rather than
 * borrowed from the Requirements File's own `cohortSchema`, for the reason under
 * `pickedMeetingSchema`: a Requirements File is versioned by its own counter, and a change there
 * must never be able to invalidate a State File.
 */
export const studentCohortSchema = z.object({
  academicYear: z.number().int(),
  semester: semesterSchema,
});

export const settingsSchema = z.object({
  language: z.enum(["en", "he"]).default("en"),
  /**
   * Exams closer together than this many calendar days raise a spacing Warning
   * (`docs/design.md`, "Exams"). Bounded the way a count of days is bounded: whole, and never
   * negative (#164). **This doc is where that bound is explained**; everything else that mentions
   * it points here rather than arguing it again.
   *
   * **`0` is allowed and means "never warn me about spacing".** `checkExams` warns on a gap
   * *fewer* than this, and two sittings on one day are a Clash rather than a spacing Warning,
   * so zero raises nothing and is the off switch. `1` happens to mean the same thing, which is
   * the reason the floor is the number that says so deliberately rather than the one that says
   * it by accident.
   *
   * **A bound here is not a domain check**, and the guardrail that every domain check is a
   * Warning an edit goes through is untouched by it: this says which values a day count *is*,
   * the way `pickedMeetingSchema`'s `CLOCK_TIME` says which strings a time is. A State File on
   * disk holding `-5` therefore still opens — `file.ts` reads the settings one field at a time,
   * so the field keeps its default and the read carries a `settings-unreadable` Warning naming
   * it, exactly as a corrupted language does. What is refused is a *write* of such a value, at
   * the API, as the shape of the request and before the domain ever sees it.
   *
   * No ceiling, deliberately: a threshold wider than an exam period warns about every sitting,
   * which is true and is what a student who asked for it asked for, while `.int()` already
   * refuses `NaN`, the infinities and anything past `Number.MAX_SAFE_INTEGER` — the values the
   * arithmetic would be a lie about.
   *
   * The default is the check's own constant and not a second `3`: a file that says nothing about
   * Exam spacing and a `checkExams` call given no threshold have to mean the same thing.
   */
  examSpacingDays: z.number().int().min(0).default(DEFAULT_EXAM_SPACING_DAYS),
});

export const stateSchema = z.object({
  schemaVersion: z.number(),
  attempts: z.array(attemptSchema).default([]),
  timetables: z.array(timetableSchema).default([]),
  pins: z.array(pinSchema).default([]),
  /**
   * The three fields #287 and #288 add, each defaulted (or optional) so that a version-1 file
   * written before them opens unchanged and needs no migration — the rule `variantSchema`'s `tray`
   * set. A build older than this one strips them on save, which is a downgrade nothing promises
   * to survive.
   */
  cohort: studentCohortSchema.optional(),
  programs: z.array(programSchema).default([]),
  manualTicks: z.array(manualTickSchema).default([]),
  settings: settingsSchema.prefault({}),
});

export type Status = z.infer<typeof statusSchema>;
export type Grade = z.infer<typeof gradeSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type AttemptId = z.infer<typeof attemptIdSchema>;
/** An Attempt without its id: what the Requirement engine reads, since it never names one. */
export type AttemptFacts = Omit<Attempt, "id">;
export type PickedMeeting = z.infer<typeof pickedMeetingSchema>;
export type GroupPick = z.infer<typeof groupPickSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type BlockedTime = z.infer<typeof blockedTimeSchema>;
export type Timetable = z.infer<typeof timetableSchema>;
export type Pin = z.infer<typeof pinSchema>;
export type ManualTick = z.infer<typeof manualTickSchema>;
export type Program = z.infer<typeof programSchema>;
export type StudentCohort = z.infer<typeof studentCohortSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type State = z.infer<typeof stateSchema>;
