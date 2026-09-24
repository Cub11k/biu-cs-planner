import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rawCrawlSchema } from "./raw-crawl.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8"));

it("accepts a real crawl whole, keeping every block it carries", () => {
  const parsed = rawCrawlSchema.safeParse(fixture("raw-crawl-2027-newer-trimmed.json"));

  expect(parsed.success).toBe(true);
  const crawl = parsed.success ? parsed.data : undefined;
  // the counts are the fixture's own: nothing was dropped on the way through
  expect(crawl?.rows).toHaveLength(10);
  expect(Object.keys(crawl?.details ?? {})).toHaveLength(4);
  expect(Object.keys(crawl?.sections ?? {})).toHaveLength(7);
  expect(crawl?.meta?.["scraped_at"]).toBe("2026-09-13T13:53:03.017Z");
});

it("accepts an older crawl that carries no sections and no meta", () => {
  const parsed = rawCrawlSchema.safeParse(fixture("raw-crawl-2027-trimmed.json"));

  expect(parsed.success).toBe(true);
  expect(parsed.success && parsed.data.sections).toBeUndefined();
  expect(parsed.success && parsed.data.meta).toBeUndefined();
});

it("keeps the counters in a meta block it does not name", () => {
  // A crawl's record of itself should not come out less complete than the crawl.
  const parsed = rawCrawlSchema.parse({
    meta: { scraped_at: "2026-09-13T13:53:03.017Z", reported_total: 513, captured: 513 },
  });

  expect(parsed.meta).toEqual({
    scraped_at: "2026-09-13T13:53:03.017Z",
    reported_total: 513,
    captured: 513,
  });
});

it("strips a key it does not know from a row, rather than carrying it inward", () => {
  const parsed = rawCrawlSchema.parse({
    rows: [
      {
        code: "89110",
        name: "מבוא",
        group: "01",
        teachers: "",
        kind: "הרצאה",
        semester: "סמסטר א'",
        day: "",
        hours: "",
        surprise: "should not survive",
      },
    ],
  });

  expect(parsed.rows?.[0]).not.toHaveProperty("surprise");
});

it("refuses a row missing a field the Importer reads", () => {
  const parsed = rawCrawlSchema.safeParse({ rows: [{ code: "89110", name: "מבוא" }] });

  expect(parsed.success).toBe(false);
});

it("accepts a row with no lid, because older dumps have none", () => {
  const parsed = rawCrawlSchema.safeParse({
    rows: [
      {
        code: "89110",
        name: "מבוא",
        group: "01",
        teachers: "",
        kind: "הרצאה",
        semester: "סמסטר א'",
        day: "",
        hours: "",
      },
    ],
  });

  expect(parsed.success).toBe(true);
});
