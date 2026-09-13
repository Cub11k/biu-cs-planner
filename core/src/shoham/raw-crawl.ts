import { z } from "zod";
import { provenanceSchema } from "../catalog/schema.ts";

/**
 * A Raw Crawl as it arrives over the wire: every field a string, exactly as Shoham
 * renders it (docs/research/shoham-raw-shape.md). This exists so a request body can be
 * validated before it reaches the Importer.
 *
 * Unknown keys are stripped, per the API and data rules in docs/design.md. That has a
 * consequence worth stating: **when the Raw Crawl shape grows, this schema has to grow
 * with it, or the new field is silently dropped on the way in.** Issue #6 adds a
 * `sections` map, and it will need a line here.
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
  /** Shoham's internal id for the section. Not every dump records it. */
  lid: z.string().optional(),
});

export const rawTermSchema = z.object({
  type: z.string(),
  date: z.string(),
  hour: z.string(),
});

export const rawDetailSchema = z.object({
  points: z.string().optional(),
  code: z.string().optional(),
  hours: z.string().optional(),
  terms: z.array(rawTermSchema).optional(),
});

export const rawCrawlSchema = z.object({
  rows: z.array(rawCrawlRowSchema).optional(),
  /** Keyed "<code>|<semester>"; the key's Semester needs normalising before use. */
  details: z.record(z.string(), rawDetailSchema).optional(),
  provenance: provenanceSchema.optional(),
});
