import { z } from "zod";

/**
 * The Zod schemas are the single source of truth: the types below are inferred from them,
 * every file read is validated against them, and they export JSON Schema for hand-written
 * files. Unknown keys are stripped rather than carried.
 */
export const CURRENT_CATALOG_SCHEMA_VERSION = 1;

export const semesterSchema = z.enum(["fall", "spring", "summer"]);

export const daySchema = z.enum([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
]);

/** Literal patterns, never built from data (ADR-0007). */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const meetingSchema = z.object({
  semester: semesterSchema,
  day: daySchema,
  start: z.string().regex(CLOCK_TIME),
  end: z.string().regex(CLOCK_TIME),
});

export const examSchema = z.object({
  /** The label Shoham publishes, an open set: see the decision recorded on issue #1. */
  moed: z.string(),
  date: z.string().regex(ISO_DATE),
  time: z.string().regex(CLOCK_TIME),
});

export const groupSchema = z.object({
  number: z.string(),
  lessonType: z.string(),
  lecturers: z.array(z.string()),
  /**
   * Weekly hours of this Group, which is what Shoham publishes per Group rather than a
   * Course-wide credit figure. Present only for Groups a detail record was read from.
   */
  weeklyHours: z.number().optional(),
  meetings: z.array(meetingSchema),
});

export const offeringSchema = z.object({
  courseNumber: z.string(),
  nameHebrew: z.string(),
  /** Only the detail page carries it, and not for every Course. */
  nameEnglish: z.string().optional(),
  /**
   * The sum of one Group's weekly hours per Lesson Type. `known: false` until every Lesson
   * Type the Offering has is covered, because one detail record only speaks for one Group.
   */
  credits: z.object({ known: z.boolean(), total: z.number().optional() }),
  semesters: z.array(semesterSchema),
  groups: z.array(groupSchema),
  /** `known: false` means no part has published them yet, not that there are none. */
  exams: z.object({ known: z.boolean(), sittings: z.array(examSchema) }),
});

/**
 * Where a part came from. Every field is optional because the older crawls record none of
 * them, and an Academic Year that cannot say how it was gathered is still worth importing.
 */
export const provenanceSchema = z.object({
  query: z.string().optional(),
  crawledAt: z.string().optional(),
  crawlerVersion: z.string().optional(),
  /** The page the part was gathered from, so a Catalog can name what it is derived from. */
  source: z.string().optional(),
  /**
   * Whether the crawl reached the end of its query. A part that stopped early holds fewer
   * Offerings than the year really has, which is worth seeing rather than guessing at.
   */
  complete: z.boolean().optional(),
});

export const catalogSchema = z.object({
  schemaVersion: z.number(),
  academicYear: z.number(),
  /** One entry per part merged in, in the order they were imported. */
  sources: z.array(provenanceSchema),
  offerings: z.array(offeringSchema),
});

export type Semester = z.infer<typeof semesterSchema>;
export type Day = z.infer<typeof daySchema>;
export type Meeting = z.infer<typeof meetingSchema>;
export type Exam = z.infer<typeof examSchema>;
export type Group = z.infer<typeof groupSchema>;
export type Offering = z.infer<typeof offeringSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
