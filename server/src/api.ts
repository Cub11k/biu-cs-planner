import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  createWorkspace,
  getOffering,
  importCrawl,
  listOfferings,
  workspaceStatus,
  type Workspace,
} from "@biu-cs-planner/app";
import {
  CURRENT_CATALOG_SCHEMA_VERSION,
  rawCrawlSchema,
  semesterSchema,
} from "@biu-cs-planner/core";
import { z } from "zod";

/**
 * The HTTP API. It exposes domain operations — a year, a Semester, a course number —
 * and never a file path: where a Catalog lives is the Workspace adapter's business, and
 * nothing in a request or a response names it (ADR-0002, docs/design.md).
 */
export type ApiDependencies = { workspace: Workspace };

/** A crawl of a whole department is large; a request far past that is not one. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const yearSchema = z.coerce.number().int().min(1900).max(2200);

/**
 * `__proto__` and `constructor` are rejected outright rather than stripped, so a body
 * carrying them is refused instead of quietly half-accepted (docs/design.md, rule 2).
 * JSON.parse makes `__proto__` an own property, so it is visible to this walk.
 */
function hasDangerousKey(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasDangerousKey(v, depth + 1));
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return true;
    if (hasDangerousKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

export function createApi({ workspace }: ApiDependencies) {
  const api = new Hono()
    .get("/api/health", (c) =>
      c.json({ ok: true, catalogSchemaVersion: CURRENT_CATALOG_SCHEMA_VERSION } as const),
    )

    // Is this folder a Workspace yet, and what is missing if not?
    .get("/api/workspace", async (c) => c.json(await workspaceStatus(workspace)))

    // Creating the layout is an explicit act, which is why it is a POST and not a
    // side effect of the GET above: nothing is written until the student asks.
    .post("/api/workspace", async (c) => c.json(await createWorkspace(workspace)))

    .post(
      "/api/catalog/:year/import",
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json({ error: "body-too-large" }, 413),
      }),
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
        if (!result.stored) return c.json({ reason: result.reason }, 409);

        return c.json({ summary: result.summary, warnings: result.warnings });
      },
    )

    .get("/api/catalog/:year/offerings", async (c) => {
      const year = yearSchema.safeParse(c.req.param("year"));
      const semester = semesterSchema.safeParse(c.req.query("semester"));
      if (!year.success || !semester.success) return c.json({ error: "bad-query" }, 400);

      const result = await listOfferings(workspace, {
        academicYear: year.data,
        semester: semester.data,
      });
      if (!result.offerings) return c.json({ warnings: result.warnings }, 404);

      return c.json({ offerings: result.offerings, warnings: result.warnings });
    })

    .get("/api/catalog/:year/offerings/:courseNumber", async (c) => {
      const year = yearSchema.safeParse(c.req.param("year"));
      if (!year.success) return c.json({ error: "bad-year" }, 400);

      const result = await getOffering(workspace, {
        academicYear: year.data,
        courseNumber: c.req.param("courseNumber"),
      });
      if (!result.offering) return c.json({ warnings: result.warnings }, 404);

      return c.json({ offering: result.offering, warnings: result.warnings });
    });

  return api;
}

/** `web` imports this type only, never the runtime (docs/design.md, "Architecture"). */
export type ApiType = ReturnType<typeof createApi>;
