import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { onlyTheLauncher } from "./guard.ts";
import {
  createWorkspace,
  DEFAULT_STATE_FILE,
  getOffering,
  importCrawl,
  listOfferings,
  pickGroup,
  readSettings,
  readTimetable,
  removeGroupPick,
  setSettings,
  workspaceStatus,
  type QueryWarning,
  type TimetableRef,
  type Workspace,
  type WorkspaceChanges,
} from "@biu-cs-planner/app";
import { editHistories } from "./history.ts";
import type { HistoryMove } from "./history.ts";
import {
  CURRENT_CATALOG_SCHEMA_VERSION,
  groupPickSchema,
  rawCrawlSchema,
  semesterSchema,
  settingsSchema,
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
 * Which revision of the State File a save was based on: the one the page was showing when
 * the student clicked (docs/design.md, "External edits"). The page holds it because two
 * views of one plan open side by side is a real way of working — and a guard that lived only
 * on the server could not tell the second tab's stale save from the first tab's fresh one.
 *
 * **Absent means the save was based on there being no file**, which is the faithful spelling
 * of the `StateFileVersion | undefined` the domain takes: JSON has no `undefined`, and a
 * `null` synonym for the same claim would be a second way to say one thing. It is therefore
 * optional in the schema and not optional in effect — a client that leaves it out claims
 * there is no file, so it can create one and can never overwrite one. A forgotten revision
 * fails closed, which is the only direction this may fail in.
 *
 * Opaque here, as everywhere: it is compared and handed back, never parsed. No length or
 * shape is asserted beyond its being a string, because what a revision *is* belongs to the
 * Workspace adapter and the API must not grow a second opinion about it.
 */
const basedOnSchema = z.string().optional();

/** A Pick, and the revision the page that sends it was based on. */
const savedPickSchema = z.object({ ...groupPickSchema.shape, basedOn: basedOnSchema });

/** The slot to clear, and the revision the page that sends it was based on. */
const savedSlotSchema = z.object({ ...pickSlotSchema.shape, basedOn: basedOnSchema });

/**
 * A change to the student's preferences: the fields being set, and the revision the page that
 * sends it was based on.
 *
 * **Every field optional**, which is what makes this a PATCH rather than a PUT. A body carries
 * the preferences it means to change and says nothing about the others, so the one control that
 * exists today — the language switch — cannot reset the Exam spacing by not mentioning it. A
 * whole-object write from a page that knows about one preference would do exactly that, with
 * whatever value it happened to have read, or the schema's default if it had read none.
 *
 * Each field's *type* comes from `core`'s own `settingsSchema`, so a value this route accepts
 * cannot be one the State File would then reject. Each is named here rather than derived, and
 * `./api.test.ts` carries a canary that fails when `settingsSchema` gains a field, because the
 * alternative is a preference the file holds that no route can set.
 *
 * **`settingsSchema.partial()` is not what this is, and the difference is a bug.** `.partial()`
 * leaves each field's `.default()` in place, so a body naming only the language parses as that
 * language *and* the default Exam spacing — and this route would silently reset the preference it
 * was not asked about. Measured on zod 4.6.5: `settingsSchema.partial().parse({})` is
 * `{ language: "en", examSpacingDays: 3 }`. Unwrapping the default before making the field
 * optional is what leaves an unmentioned field absent.
 *
 * A body naming no field at all is well formed and changes nothing, which the domain answers as
 * an unchanged save.
 */
export const savedSettingsSchema = z.object({
  language: settingsSchema.shape.language.unwrap().optional(),
  examSpacingDays: settingsSchema.shape.examSpacingDays.unwrap().optional(),
  basedOn: basedOnSchema,
});

/**
 * What an undo or a redo carries, which is the revision the page it was clicked on was
 * showing and nothing else.
 *
 * No year, no Semester, no Variant and no State File. Undo restores the document (ADR-0013),
 * so naming a part of it would be a promise this operation cannot keep — an undo of a Pick
 * made in one Semester is not scoped to the Semester the student happens to be looking at.
 */
const historyStepSchema = z.object({ basedOn: basedOnSchema });

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
  /**
   * The undo and redo stacks, built here and held for as long as this server runs.
   *
   * Not a dependency a caller passes, and deliberately: a server built without a history
   * would still save every edit, and the only sign would be an undo button that never lit
   * up. Nothing about the stacks has a lifecycle outside this process either — unlike the
   * watcher, which is injected because starting and stopping it belongs to whoever owns the
   * process. One history per server is also what makes two tabs share one (ADR-0013):
   * `./token.ts` is one token for all of them and there is no session to key a stack to.
   */
  const history = editHistories(workspace);

  /**
   * The port every editing route hands to the use case, for the State File the API works in.
   * The same name the use cases default to, so the stack is keyed to the file being written
   * and not to a second opinion about which file that is (`app/src/picks.ts`).
   */
  const into = history.of(DEFAULT_STATE_FILE);

  /**
   * One step of undo or redo, answered the way a save is: 200 with what moved, or a named
   * 409. The two routes differ only in which direction they ask for, so they share this.
   */
  async function step(c: Context, move: (basedOn: string | undefined) => Promise<HistoryMove>) {
    const body = await bodyAs(c, historyStepSchema, "not-a-history-step");
    if (!body.ok) return c.json({ error: body.error }, 400);

    const moved = await move(body.value.basedOn);
    if (moved.kind === "refused") {
      // `nothing-to-undo` among the reasons, and a 409 is right for it too: the request is
      // well formed and conflicts with the state of the history. The availability travels
      // with every answer, so a UI that asked for an undo it did not have can correct its
      // buttons from the refusal rather than asking again.
      return c.json(
        {
          reason: moved.reason,
          canUndo: moved.canUndo,
          canRedo: moved.canRedo,
          warnings: moved.warnings,
        },
        409,
      );
    }

    return c.json({
      label: moved.label,
      at: moved.at,
      version: moved.version,
      canUndo: moved.canUndo,
      canRedo: moved.canRedo,
      warnings: moved.warnings,
    });
  }

  const guarded = new Hono();
  guarded.use("/api/*", onlyTheLauncher({ token, openPaths: [HEALTH_PATH] }));

  const api = guarded
    .get(HEALTH_PATH, (c) =>
      c.json({ ok: true, catalogSchemaVersion: CURRENT_CATALOG_SCHEMA_VERSION } as const),
    )

    /**
     * Is this folder a Workspace yet, and what is missing if not?
     *
     * One answer and no refusal arm, which `workspaceStatus` in `app/src/setup.ts` is where the
     * argument for lives: the layout probe behind it reports a part it cannot resolve as
     * *missing* rather than raising, so the hole the POST below had is not open here (#141).
     */
    .get("/api/workspace", async (c) => c.json(await workspaceStatus(workspace)))

    /**
     * Creating the layout is an explicit act, which is why it is a POST and not a side effect
     * of the GET above: nothing is written until the student asks.
     *
     * **A refused create is the same named 409 the other write routes answer with.** Until #141
     * this route was an unnamed 500: `createWorkspace` threw, the route had no arm for it, and
     * Hono's default handler answered with no body of this app's own. It was the only such route
     * anyone had found, and the property "this file has no unnamed 500 path" is load-bearing for
     * #90's and #109's arguments — but that property is an argument made route by route and not
     * something a test asserts over all of them, so this comment claims only its own. The body is
     * the import route's to the character — `{ "reason": "workspace-refused" }` — because it is
     * the same refusal out of the same port, and a page that can read one can read the other.
     *
     * A created Workspace still answers with its status and nothing wrapped around it, so the
     * successful shape on the wire is untouched by the arm above it.
     */
    .post("/api/workspace", capped, async (c) => {
      const created = await createWorkspace(workspace);
      // A conflict with the state of the folder, exactly as an import into one that is not a
      // Workspace is: the request is well formed and the folder will not have it.
      if (created.kind === "refused") return c.json({ reason: created.reason }, 409);

      return c.json(created.status);
    })

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

      // `version` is which revision of the State File these Picks are, and what a save of an
      // edit made on them has to be based on. Absent when there is no file yet, which is the
      // claim a first save carries. It says nothing about where the file is (ADR-0002): it is
      // a hash of its content, and a caller can do nothing with it but hand it back.
      return c.json({ ...result.view, version: result.version, warnings: result.warnings });
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

      const body = await bodyAs(c, savedPickSchema, "not-a-pick");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, ...pick } = body.value;
      const result = await pickGroup(workspace, ref.at, pick, { basedOn, history: into });
      if (result.kind === "refused") {
        // `state-file-changed` among the reasons, and a 409 is what it always was: the
        // student's request is well formed and conflicts with the state of the file, which
        // is what this status is for. The page reloads and says so (#90).
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({ ...result.view, version: result.version, warnings: result.warnings });
    })

    /** Removes the Pick filling one Lesson Type of one Offering. */
    .delete("/api/timetable/:year/:semester/picks", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);

      const body = await bodyAs(c, savedSlotSchema, "not-a-pick-slot");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, ...slot } = body.value;
      const result = await removeGroupPick(workspace, ref.at, slot, { basedOn, history: into });
      if (result.kind === "refused") {
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({ ...result.view, version: result.version, warnings: result.warnings });
    })

    /**
     * Whether there is anything to undo or to redo, for the two buttons.
     *
     * A page asks after a reload, because the history outlives the page: the stacks belong to
     * the State File and live in this process, so a reloaded tab — or a second one — finds the
     * undo it never made still waiting (ADR-0013). Every undo and redo answer carries the same
     * two flags, so this is the first read and not a poll.
     *
     * Answered from memory and never from the disk, which is why `canUndo` can be true for an
     * undo that will then be refused as `history-invalidated`: a State File written from
     * outside is noticed when something reads it, and a read on every one of these would put a
     * disk touch behind a question the page asks on every reload. The student's first sign is
     * then a click that comes back named and harmless, rather than a button that is wrong in
     * the other direction — greyed out over a history that is perfectly good.
     */
    .get("/api/history", (c) => c.json(history.availability(DEFAULT_STATE_FILE)))

    /**
     * Undoes the last edit, and redoes the last undone one.
     *
     * Domain operations, and the paths say so: no file path, no State File name and no
     * Semester (ADR-0002, docs/design.md "API and data rules"). The answer says what moved,
     * so the UI can say it too, and whether either direction is still available.
     *
     * A POST and not a PUT: neither is idempotent — the second undo in a row undoes the edit
     * before, which is the point of a stack.
     *
     * Both carry the revision the page was showing, exactly as a save does, because an undo
     * *is* a save: it goes through the same wrapper and the same external-edit guard
     * (ADR-0013, "the save path is the undo path"). A client that leaves it out claims there
     * is no file, which fails closed the way a forgotten revision on a Pick does.
     */
    .post("/api/history/undo", capped, (c) =>
      step(c, (basedOn) => history.undo(DEFAULT_STATE_FILE, basedOn)),
    )

    .post("/api/history/redo", capped, (c) =>
      step(c, (basedOn) => history.redo(DEFAULT_STATE_FILE, basedOn)),
    )

    /**
     * The student's preferences: the language the UI is in, and the Exam spacing a Warning is
     * raised below (`docs/design.md`, "Workspace"; ADR-0014).
     *
     * Domain operations and no file path, as everywhere: no State File is named, exactly as the
     * history routes name none (ADR-0002). The Warnings travel with the answer and are the
     * reason this is not just the two values — `core/src/state/file.ts` reads the settings one
     * field at a time and raises `settings-unreadable` naming the field it could not read, and a
     * preference silently back at its default is the one a student cannot tell from a preference
     * they never set.
     *
     * `version` is the revision these settings were read from, and what a change made on them
     * has to be based on. Absent when there is no State File yet, which is the claim a first
     * save carries.
     */
    .get("/api/settings", async (c) => {
      const result = await readSettings(workspace);
      if (result.kind === "refused") {
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({ ...result.settings, version: result.version, warnings: result.warnings });
    })

    /**
     * Sets the preferences the body names, and answers with the settings as the file holds them
     * afterwards — the same shape the GET answers, so a page that can read one can read the
     * other.
     *
     * **A PATCH and not a PUT**, because the body is the fields being changed rather than the
     * whole of the settings; `savedSettingsSchema` carries the argument.
     *
     * A refusal is the same named 409 the Pick routes answer with, and `state-file-changed` is
     * among the reasons: writing a preference is writing the State File, so somebody else's edit
     * between the read the page was showing and this save refuses it rather than overwriting
     * their work (#90). Whatever offered the control owes the student an account of that.
     *
     * `into` is passed for the same reason a Pick passes it, and **not** so that a preference can
     * be undone — ADR-0013 keeps settings off the stack and `app/src/edit.ts` enforces that
     * structurally. It is passed because the stack has to hear the revision every save wrote: a
     * settings save it had not heard about would leave it believing the revision before, and the
     * next undo would read a file carrying a revision the stack never wrote and throw the
     * student's whole history away as though something outside the app had been in.
     */
    .patch("/api/settings", capped, async (c) => {
      const body = await bodyAs(c, savedSettingsSchema, "not-settings");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, ...change } = body.value;
      const result = await setSettings(workspace, change, { basedOn, history: into });
      if (result.kind === "refused") {
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({ ...result.settings, version: result.version, warnings: result.warnings });
    });

  return api;
}

/** `web` imports this type only, never the runtime (docs/design.md, "Architecture"). */
export type ApiType = ReturnType<typeof createApi>;
