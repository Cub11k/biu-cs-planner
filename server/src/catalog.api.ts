import { Hono, type Context } from "hono";
import {
  getOffering,
  importCrawl,
  listOfferings,
  readCourses,
  type CatalogRefused,
  type QueryWarning,
  type Workspace,
} from "@biu-cs-planner/app";
import { rawCrawlSchema, semesterSchema } from "@biu-cs-planner/core";
import { capped, hasDangerousKey, yearSchema } from "./api.shared.ts";

/**
 * A Catalog query's answer when it has no Catalog to serve. A refusal is a conflict with the
 * state of the Workspace, a 409 carrying its own arm and no Warnings (#149); a Catalog that is
 * not there or could not be read as one is a plain 404 with the Warnings that say which, which
 * would otherwise claim a refused Catalog simply was not there.
 */
function catalogNotServed(c: Context, result: CatalogRefused | { kind: "read"; warnings: QueryWarning[] }) {
  if (result.kind === "refused") {
    return c.json({ kind: result.kind, reason: result.reason, sentence: result.sentence }, 409);
  }
  return c.json({ warnings: result.warnings }, 404);
}

/**
 * The Catalog routes: importing a year's Raw Crawl, the Offerings of a Semester and of one
 * Course, and the Courses the Plan screen names on its cards.
 */
export function catalogRoutes(workspace: Workspace) {
  return new Hono()
    .post(
      "/api/catalog/:year/import",
      capped,
      async (c) => {
        const year = yearSchema.safeParse(c.req.param("year"));
        if (!year.success) return c.json({ error: "bad-year" }, 400);

        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: "body-not-json" }, 400);
        }
        if (hasDangerousKey(body)) return c.json({ error: "unsafe-keys" }, 400);

        const crawl = rawCrawlSchema.safeParse(body);
        if (!crawl.success) return c.json({ error: "not-a-raw-crawl" }, 400);

        const result = await importCrawl(workspace, crawl.data, {
          academicYear: year.data,
        });
        if (!result.stored) {
          // the reason alone leaves the student nothing to act on, so the Warnings
          // explaining what is wrong with the stored file travel with it
          return c.json(
            result.fileWarnings
              ? { reason: result.reason, warnings: result.fileWarnings }
              : { reason: result.reason },
            409,
          );
        }

        return c.json({ summary: result.summary, warnings: result.warnings });
      },
    )

    /**
     * The Courses the Plan screen draws on its cards (#292): each one's name and credits, from the
     * Requirements Files first and a name they lack from the most recent Catalog (`readCourses`).
     * A read and never a refusal — what cannot be read is only a Course less known. No path is named.
     */
    .get("/api/courses", async (c) => c.json(await readCourses(workspace)))

    .get("/api/catalog/:year/offerings", async (c) => {
      const year = yearSchema.safeParse(c.req.param("year"));
      const semester = semesterSchema.safeParse(c.req.query("semester"));
      if (!year.success || !semester.success) return c.json({ error: "bad-query" }, 400);

      const result = await listOfferings(workspace, {
        academicYear: year.data,
        semester: semester.data,
      });
      if (result.kind === "refused" || !result.offerings) return catalogNotServed(c, result);

      return c.json({ offerings: result.offerings, warnings: result.warnings });
    })

    .get("/api/catalog/:year/offerings/:courseNumber", async (c) => {
      const year = yearSchema.safeParse(c.req.param("year"));
      if (!year.success) return c.json({ error: "bad-year" }, 400);

      const result = await getOffering(workspace, {
        academicYear: year.data,
        courseNumber: c.req.param("courseNumber"),
      });
      if (result.kind === "refused" || !result.offering) return catalogNotServed(c, result);

      return c.json({ offering: result.offering, warnings: result.warnings });
    });
}
