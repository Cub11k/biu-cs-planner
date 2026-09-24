import type { Provenance } from "../catalog/schema.ts";
import type { RawCrawlMeta } from "./raw-crawl.ts";

export type { RawCrawlMeta };


function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A Provenance from a meta block, keeping only the fields that carry a usable value.
 *
 * Returns undefined when the block says nothing about where the crawl came from, so a meta
 * block holding only counters still counts as a part with no provenance.
 */
export function provenanceFromMeta(meta: RawCrawlMeta | undefined): Provenance | undefined {
  if (!meta) return undefined;

  const provenance: Provenance = {};
  // `label` is what the crawl was asked for -- the query, named the way the crawler names it.
  const query = stringOr(meta.label);
  const crawledAt = stringOr(meta.scraped_at);
  // The crawler's own file, which is how a crawl records the version that produced it.
  const crawlerVersion = stringOr(meta.script);
  const source = stringOr(meta.source);

  if (query) provenance.query = query;
  if (crawledAt) provenance.crawledAt = crawledAt;
  if (crawlerVersion) provenance.crawlerVersion = crawlerVersion;
  if (source) provenance.source = source;
  if (typeof meta.complete === "boolean") provenance.complete = meta.complete;

  return Object.keys(provenance).length ? provenance : undefined;
}
