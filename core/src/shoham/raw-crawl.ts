import { z } from "zod";
import { provenanceSchema } from "../catalog/schema.ts";

/**
 * A Raw Crawl, as it arrives: every field a string, exactly as Shoham renders it
 * (docs/research/shoham-raw-shape.md).
 *
 * These schemas are the single source of truth for the shape. The Importer's types are
 * inferred from them and a request body is validated against them, so there is one
 * definition to keep current rather than two that can drift — and a field added here
 * reaches the Importer instead of being stripped on the way in.
 */
export const rawCrawlRowSchema = z.object({
  code: z.string(),
  name: z.string(),
  group: z.string(),
  teachers: z.string(),
  kind: z.string(),
  semester: z.string(),
  day: z.string(),
  hours: z.string(),
  /** Shoham's id for the row, and the only thing that matches it to a per-Group record. */
  lid: z.string().optional(),
});

export const rawTermSchema = z.object({
  type: z.string(),
  date: z.string(),
  hour: z.string(),
});

/**
 * The Course-wide facts: credits and Exams. They are keyed by course number and Semester,
 * and the Semester inside that key is written in more than one way across files, so the
 * key is normalised before anything is matched against it (ADR-0010).
 */
export const rawDetailSchema = z.object({
  points: z.string().optional(),
  code: z.string().optional(),
  hours: z.string().optional(),
  terms: z.array(rawTermSchema).optional(),
});

/**
 * A detail page keyed by the `lid` of the one Group it was read from, which is how the
 * 2026-09-13 crawl records them, in a block it calls `sections`. Same page as a `RawDetail`,
 * read per Group rather than per (course, Semester), so its `points` speak for a Group that
 * is known by name rather than one that has to be guessed at from `code`.
 */
export const rawGroupDetailSchema = rawDetailSchema.extend({
  name_en: z.string().optional(),
});

/**
 * The block the crawler writes at the head of a Raw Crawl, saying when it ran, what it asked
 * for and against what. Older crawls have none; the fields are read as they are found rather
 * than required.
 *
 * Unknown keys are kept rather than stripped here, unlike everywhere else: the block also
 * carries counters the Catalog has no use for, and throwing them away would make a crawl's
 * own record of itself less complete than the crawl.
 */
export const rawCrawlMetaSchema = z.looseObject({
  label: z.unknown().optional(),
  scraped_at: z.unknown().optional(),
  script: z.unknown().optional(),
  source: z.unknown().optional(),
  complete: z.unknown().optional(),
});

export const rawCrawlSchema = z.object({
  rows: z.array(rawCrawlRowSchema).optional(),
  /** Keyed "<code>|<semester>"; the key's Semester needs normalising before use. */
  details: z.record(z.string(), rawDetailSchema).optional(),
  /** Keyed by the `lid` of the Group each record was read from. */
  sections: z.record(z.string(), rawGroupDetailSchema).optional(),
  /** Where the crawl came from, as the crawler writes it. */
  meta: rawCrawlMetaSchema.optional(),
  /** An already-shaped Provenance, from before a crawl recorded its own. */
  provenance: provenanceSchema.optional(),
});

export type RawCrawlRow = z.infer<typeof rawCrawlRowSchema>;
export type RawDetail = z.infer<typeof rawDetailSchema>;
export type RawGroupDetail = z.infer<typeof rawGroupDetailSchema>;
export type RawCrawlMeta = z.infer<typeof rawCrawlMetaSchema>;
export type RawCrawl = z.infer<typeof rawCrawlSchema>;
