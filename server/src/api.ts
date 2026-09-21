import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { onlyTheLauncher } from "./guard.ts";
import {
  createWorkspace,
  getOffering,
  importCrawl,
  listOfferings,
  pickGroup,
  readTimetable,
  removeGroupPick,
  workspaceStatus,
  type QueryWarning,
  type TimetableRef,
  type Workspace,
  type WorkspaceChanges,
} from "@biu-cs-planner/app";
import {
  CURRENT_CATALOG_SCHEMA_VERSION,
  groupPickSchema,
  rawCrawlSchema,
  semesterSchema,
} from "@biu-cs-planner/core";
import { z } from "zod";

/**
 * The HTTP API. It exposes domain operations — a year, a Semester, a course number —
 * and never a file path: where a Catalog lives is the Workspace adapter's business, and
 * nothing in a request or a response names it (ADR-0002, docs/design.md).
 *
 * Every route sits behind `onlyTheLauncher`, so a route added here is protected by being
 * added here — the launch token, the Host and Origin checks and the JSON-only rule for
 * writes are not something each new endpoint has to remember (ADR-0004).
 */
export type ApiDependencies = {
  workspace: Workspace;
  /** The launch token this server was started with; see ./token.ts. */
  token: string;
  /**
   * The Workspace's change counter. Only the reading half: starting and stopping the watch
   * belongs to whoever owns the process, not to a request.
   */
  changes: Pick<WorkspaceChanges, "changeCount">;
};

/**
 * The one route that answers without a token: a launcher needs to tell a server that is
 * already running from a port that something else holds, before it has a token to offer.
 * It says only that the app is here and which schema version it speaks.
 */
const HEALTH_PATH = "/api/health";

/** A crawl of a whole department is large; a request far past that is not one. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const yearSchema = z.coerce.number().int().min(1900).max(2200);

/** Every write route is capped, not just the one that carries a crawl. */
const capped = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: "body-too-large" }, 413),
});

/**
 * A Catalog could not be produced. A refusal is a conflict with the state of the
 * Workspace; absence is a plain 404, which would otherwise claim a refused Catalog
 * simply was not there.
 */
const notServed = (warnings: QueryWarning[]): 409 | 404 =>
  warnings.some((w) => w.kind === "workspace-refused") ? 409 : 404;

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

/**
 * A Pick request names the slot it fills: one Lesson Type of one Offering. Narrower than
 * `groupPickSchema` because removing a Pick says which one without repeating the Group or
 * the snapshot — and a body is parsed by the shape the route actually takes, never by a
 * wider one it would then have to ignore.
 */
const pickSlotSchema = z.object({ courseNumber: z.string(), lessonType: z.string() });

/**
 * A request body, read the way the import route reads one: JSON, no dangerous key, then
 * the schema for the shape the route actually takes. It hands back the **name** of what
 * was wrong rather than a response, so the route says `c.json(...)` itself and the
 * contract `web` is typed from still knows what every answer looks like.
 *
 * This is the boundary that keeps `writeStateFile`'s `StateFileUnwritableError`
 * unreachable: a body that is not a Pick never reaches the domain, so no `State` is ever
 * built from one and there is no throw to catch (#80).
 */
async function bodyAs<T>(
  c: Context,
  schema: z.ZodType<T>,
  notTheShape: string,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, error: "body-not-json" };
  }
  if (hasDangerousKey(body)) return { ok: false, error: "unsafe-keys" };

  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, error: notTheShape };

  return { ok: true, value: parsed.data };
}

/**
 * Which Semester of which Academic Year, off the path. A Timetable covers one Semester of
 * one Academic Year (CONTEXT.md), so both name it — and both are parsed before anything
 * downstream sees them, as the Catalog routes parse a year. The name of what was wrong
 * comes back, for the same reason `bodyAs` hands one back.
 */
function timetableRef(
  c: Context,
): { ok: true; at: TimetableRef } | { ok: false; error: "bad-year" | "bad-semester" } {
  const year = yearSchema.safeParse(c.req.param("year"));
  if (!year.success) return { ok: false, error: "bad-year" };

  const semester = semesterSchema.safeParse(c.req.param("semester"));
  if (!semester.success) return { ok: false, error: "bad-semester" };

  return { ok: true, at: { academicYear: year.data, semester: semester.data } };
}

export function createApi({ workspace, token, changes }: ApiDependencies) {
  const guarded = new Hono();
  guarded.use("/api/*", onlyTheLauncher({ token, openPaths: [HEALTH_PATH] }));

  const api = guarded
    .get(HEALTH_PATH, (c) =>
      c.json({ ok: true, catalogSchemaVersion: CURRENT_CATALOG_SCHEMA_VERSION } as const),
    )

    // Is this folder a Workspace yet, and what is missing if not?
    .get("/api/workspace", async (c) => c.json(await workspaceStatus(workspace)))

    // Creating the layout is an explicit act, which is why it is a POST and not a
    // side effect of the GET above: nothing is written until the student asks.
    .post("/api/workspace", capped, async (c) => c.json(await createWorkspace(workspace)))

    /**
     * How the page hears that the Workspace changed under it (docs/design.md, "Storage").
     * One integer, moved once per settled burst of filesystem events; `web` remembers the
     * last one it saw and reloads what it is showing when this one differs. A count, not a
     * version: it restarts at 0 with the server, and nothing may compare a file against it.
     *
     * **Why a number a page asks for, rather than the server pushing one.** `web` reaches
     * the domain only through this API and the typed client (CLAUDE.md, ADR-0002), and it
     * must gain no second source of truth — so whatever carries the notification has to be
     * a route on this contract. Of the three ways to do that:
     *
     *   polling  one `GET` on the same typed client, the same launch token in the same
     *            `Authorization` header, the same guard, and nothing held open. Costs one
     *            request every couple of seconds on loopback, which reads an integer that
     *            is already in memory and touches no disk: the watcher, not the poll, is
     *            what looks at the folder.
     *   SSE      `EventSource` cannot send an `Authorization` header, so the launch token
     *            would have to move into the query string — logged, and in the Referer —
     *            which is the arrangement ADR-0004 turned down. Reading a stream through
     *            `fetch` instead keeps the header but holds a response open for the life of
     *            the page, which is a connection the server has to be able to drop before
     *            Ctrl-C can end it.
     *   websocket an upgrade needs a per-runtime adapter (`@hono/node-ws` and the `ws`
     *            dependency on Node, Bun's and Deno's own elsewhere). That is a Node-only
     *            API in the one place the design says to avoid one and a runtime dependency
     *            in a server that is meant to bundle with none (docs/design.md, "CLI and
     *            distribution", "Supply chain"), and a browser `WebSocket` cannot send the
     *            header either.
     *
     * A localhost app that reloads a hand-dropped Catalog does not need sub-second news, so
     * the cheapest mechanism that keeps the one edge and the one token wins. Pushing can be
     * added behind this same counter later without `web` learning anything new.
     */
    .get("/api/workspace/changes", (c) => c.json({ changeCount: changes.changeCount() }))

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

    .get("/api/catalog/:year/offerings", async (c) => {
      const year = yearSchema.safeParse(c.req.param("year"));
      const semester = semesterSchema.safeParse(c.req.query("semester"));
      if (!year.success || !semester.success) return c.json({ error: "bad-query" }, 400);

      const result = await listOfferings(workspace, {
        academicYear: year.data,
        semester: semester.data,
      });
      if (!result.offerings) return c.json({ warnings: result.warnings }, notServed(result.warnings));

      return c.json({ offerings: result.offerings, warnings: result.warnings });
    })

    .get("/api/catalog/:year/offerings/:courseNumber", async (c) => {
      const year = yearSchema.safeParse(c.req.param("year"));
      if (!year.success) return c.json({ error: "bad-year" }, 400);

      const result = await getOffering(workspace, {
        academicYear: year.data,
        courseNumber: c.req.param("courseNumber"),
      });
      if (!result.offering) return c.json({ warnings: result.warnings }, notServed(result.warnings));

      return c.json({ offering: result.offering, warnings: result.warnings });
    })

    /**
     * The Picks a student has made in one Semester, and the Clashes among them.
     *
     * Domain operations, never file paths: a year, a Semester and a course number name
     * everything here, and which State File holds them is the app's business and the
     * Workspace adapter's (ADR-0002). The Variant is the current State File's default one
     * until there is a screen for naming Variants.
     */
    .get("/api/timetable/:year/:semester", async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);

      const result = await readTimetable(workspace, ref.at);
      if (result.kind === "refused") {
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({ ...result.view, warnings: result.warnings });
    })

    /**
     * Records a Pick: one Group for one Lesson Type of an Offering, with the snapshot of
     * that Group's Meetings as the page saw them. Picking a second Group for a Lesson Type
     * already picked replaces the first, so this is one route and not two.
     *
     * A Pick that Clashes is recorded and the Clash comes back in the answer. Nothing is
     * refused: every domain check is a Warning and an edit always goes through.
     */
    .post("/api/timetable/:year/:semester/picks", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);

      const body = await bodyAs(c, groupPickSchema, "not-a-pick");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const result = await pickGroup(workspace, ref.at, body.value);
      if (result.kind === "refused") {
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({ ...result.view, warnings: result.warnings });
    })

    /** Removes the Pick filling one Lesson Type of one Offering. */
    .delete("/api/timetable/:year/:semester/picks", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);

      const body = await bodyAs(c, pickSlotSchema, "not-a-pick-slot");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const result = await removeGroupPick(workspace, ref.at, body.value);
      if (result.kind === "refused") {
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({ ...result.view, warnings: result.warnings });
    });

  return api;
}

/** `web` imports this type only, never the runtime (docs/design.md, "Architecture"). */
export type ApiType = ReturnType<typeof createApi>;
