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

export const meetingSchema = z.object({
  semester: semesterSchema,
  day: daySchema,
  start: z.string(),
  end: z.string(),
});

export const examSchema = z.object({
  moed: z.string(),
  date: z.string(),
  time: z.string(),
});

export const groupSchema = z.object({
  number: z.string(),
  lessonType: z.string(),
  lecturers: z.array(z.string()),
  meetings: z.array(meetingSchema),
});

export const offeringSchema = z.object({
  courseNumber: z.string(),
  nameHebrew: z.string(),
  /** Only the detail page carries it, and not for every Course. */
  nameEnglish: z.string().optional(),
  credits: z.number().optional(),
  semesters: z.array(semesterSchema),
  groups: z.array(groupSchema),
  /** `known: false` means no part has published them yet, not that there are none. */
  exams: z.object({ known: z.boolean(), sittings: z.array(examSchema) }),
});

/**
 * Where a part came from. Every field is optional because no crawl on hand records any of
 * them, and an Academic Year that cannot say how it was gathered is still worth importing.
 */
export const provenanceSchema = z.object({
  query: z.string().optional(),
  crawledAt: z.string().optional(),
  crawlerVersion: z.string().optional(),
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
