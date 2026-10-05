import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { onlyTheLauncher } from "./guard.ts";
import {
  createWorkspace,
  DEFAULT_STATE_FILE,
  getOffering,
  importCrawl,
  importRequirementsFile,
  listBackups,
  listRequirementsFiles,
  listOfferings,
  addAttemptTo,
  addBlockedTimeTo,
  addCourseToTray,
  addVariant,
  chooseCohort,
  choosePrograms,
  copyBlockedTimesTo,
  duplicateVariantAs,
  makeVariantPrimary,
  moveAttemptTo,
  pickGroup,
  pinCourseTo,
  readExams,
  readPlan,
  readPrograms,
  readProgress,
  readSettings,
  readTimetable,
  removeAttemptFrom,
  removeBlockedTimeAt,
  removeCourseFromTray,
  removeGroupPick,
  removeVariant,
  renameVariantAs,
  replaceBlockedTimeAt,
  restoreBackup,
  setSettings,
  tickManualRequirement,
  unpinCourseFrom,
  untickManualRequirement,
  updateAttemptOf,
  workspaceStatus,
  type PlanResult,
  type ProgramsResult,
  type ProgressResult,
  type QueryWarning,
  type TimetableRef,
  type TimetableResult,
  type Workspace,
  type WorkspaceChanges,
} from "@biu-cs-planner/app";
import { editHistories } from "./history.ts";
import type { HistoryMove } from "./history.ts";
import {
  attemptIdSchema,
  blockedTimeSchema,
  CURRENT_CATALOG_SCHEMA_VERSION,
  gradeSchema,
  groupPickSchema,
  programSchema,
  rawCrawlSchema,
  semesterSchema,
  settingsSchema,
  statusSchema,
  studentCohortSchema,
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

/**
 * A Variant's name: the student's own text, which is what tells two Variants apart (CONTEXT.md).
 *
 * Bounded as a shape and nothing more — a name is some text, and a tab with no text is not a name
 * anyone can click — the way `pickedMeetingSchema`'s pattern says which strings a time is. A name
 * **another Variant already has is not refused here**: that is a domain check, and every domain
 * check is a Warning the edit goes through with (`variantWarnings` in `core/src/state/variants.ts`).
 */
const variantNameSchema = z.string().min(1).max(200).regex(/\S/); // a literal pattern (ADR-0007): a name has something in it

/**
 * Which Variant an edit inside one is about. Absent means the primary, which is what a client
 * that has never heard of Variants has always been editing.
 */
const variantSchema = variantNameSchema.optional();

/** A Pick, the Variant it goes into, and the revision the page that sends it was based on. */
const savedPickSchema = z.object({
  ...groupPickSchema.shape,
  variant: variantSchema,
  basedOn: basedOnSchema,
});

/** The slot to clear, in which Variant, and the revision the page that sends it was based on. */
const savedSlotSchema = z.object({
  ...pickSlotSchema.shape,
  variant: variantSchema,
  basedOn: basedOnSchema,
});

/** A new Variant: its name, which a student may leave to the first free letter. */
const newVariantSchema = z.object({ name: variantNameSchema.optional(), basedOn: basedOnSchema });

/** A copy of the Variant named — the primary when none is — under a name that may be left out. */
const duplicatedVariantSchema = z.object({
  variant: variantSchema,
  name: variantNameSchema.optional(),
  basedOn: basedOnSchema,
});

/** A Variant and the name it is to have. */
const renamedVariantSchema = z.object({
  variant: variantNameSchema,
  name: variantNameSchema,
  basedOn: basedOnSchema,
});

/** The Variant to delete or to make primary: always named, because both act on one tab. */
const namedVariantSchema = z.object({ variant: variantNameSchema, basedOn: basedOnSchema });

/**
 * A Course to add to a Variant's Tray or take out of it, by course number — never by Catalog
 * entry, as the State File references every Course (#283).
 */
const trayCourseSchema = z.object({
  variant: variantSchema,
  courseNumber: z.string().min(1),
  basedOn: basedOnSchema,
});

/**
 * A Blocked Time as a student types it (#282): a Day, a start, an end and a label. The shapes
 * come from `core`'s own `blockedTimeSchema`, so a time this route accepts is one the State File
 * can hold; the Semester is left out because it is the Timetable's, named by the path. An end
 * before the start is accepted — it is a range that wraps past midnight, and `core` splits it —
 * and so is an end equal to the start, which is kept and comes back as a Warning.
 *
 * `variant` decides only which Variant the answer shows: Blocked Times belong to the Semester.
 */
const blockedRangeShape = {
  day: blockedTimeSchema.shape.day,
  start: blockedTimeSchema.shape.start,
  end: blockedTimeSchema.shape.end,
  label: blockedTimeSchema.shape.label.max(200),
};

const newBlockedTimeSchema = z.object({
  ...blockedRangeShape,
  variant: variantSchema,
  basedOn: basedOnSchema,
});

/** A position in the Timetable's list of Blocked Times, which is how one is addressed. */
const blockedIndexSchema = z.number().int().min(0);

const replacedBlockedTimeSchema = z.object({
  ...blockedRangeShape,
  index: blockedIndexSchema,
  variant: variantSchema,
  basedOn: basedOnSchema,
});

const removedBlockedTimeSchema = z.object({
  index: blockedIndexSchema,
  variant: variantSchema,
  basedOn: basedOnSchema,
});

/** Where a Semester's Blocked Times are copied to: another Semester, of any Academic Year. */
const copiedBlockedTimesSchema = z.object({
  toYear: z.number().int().min(1900).max(2200),
  toSemester: semesterSchema,
  variant: variantSchema,
  basedOn: basedOnSchema,
});

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
  creditLoadLimit: settingsSchema.shape.creditLoadLimit.unwrap().optional(),
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
 * Which snapshot to put back, and the revision the restore is based on.
 *
 * **A moment and not a path** (ADR-0002; docs/design.md, "API and data rules", rule 1): a
 * snapshot is named by when it was taken, which is the only thing that tells two of one State
 * File's apart, and where it lives is the Workspace adapter's business. A safe integer and
 * nothing else, so there is nothing in it an adapter could resolve.
 *
 * `basedOn` is carried exactly as a Pick and an undo carry it, because a restore **is** a save:
 * it goes through the same wrapper and the same external-edit guard (ADR-0013, "the save path
 * is the undo path"). A client that leaves it out claims there is no State File, which fails
 * closed.
 */
const restoreSchema = z.object({
  takenAt: z.number().int().safe(),
  basedOn: basedOnSchema,
});

/**
 * A Requirements File to import (#287): the name it is to have in `requirements/` and the file
 * itself. The name is some text and nothing more here — whether it is a name and not a path is the
 * Workspace port's rule (`requireRequirementsFileName`), which refuses it before any path is built,
 * so the API does not grow a second opinion about it. The file is anything JSON: what it holds is
 * `core`'s reader's question, and one that is not a Requirements File is refused by name.
 */
const requirementsImportSchema = z.object({
  name: z.string().min(1).max(200),
  file: z.unknown(),
});

/**
 * The student's Programs, as a whole list (#287): one for a single major, two for a double major.
 * Each entry's shape is `core`'s own `programSchema`, so a value this route accepts is one the
 * State File can hold.
 */
const savedProgramsSchema = z.object({
  programs: z.array(programSchema).max(8),
  basedOn: basedOnSchema,
});

/**
 * The Cohort to set, or `null` to clear it: JSON has no `undefined`, and a body that left the
 * field out would be indistinguishable from one that forgot it.
 */
const savedCohortSchema = z.object({
  cohort: studentCohortSchema.nullable(),
  basedOn: basedOnSchema,
});

/**
 * Every answer about the Cohort and Programs, read or write, in one shape: the view and the
 * revision it is, or the named 409 a refusal has always been. `cohort` is `null` when there is
 * none, so the page reads one field that is always there.
 */
function programsAnswer(c: Context, result: ProgramsResult) {
  if (result.kind === "refused") {
    return c.json({ reason: result.reason, warnings: result.warnings }, 409);
  }
  return c.json({
    cohort: result.view.cohort ?? null,
    programs: result.view.programs,
    programWarnings: result.view.programWarnings,
    version: result.version,
    warnings: result.warnings,
  });
}

/**
 * Which Manual Requirement a tick is about (#288): its id and the Requirements File it is an id in
 * — always the file, since an id is unique only within one (`CONTEXT.md`, Pin) — and the revision
 * the page was based on.
 */
const savedTickSchema = z.object({
  requirementsFile: z.string().min(1).max(200),
  requirementId: z.string().min(1).max(200),
  basedOn: basedOnSchema,
});

/** A Pin: a Course, and the Requirement of one Requirements File it counts toward. */
const savedPinSchema = z.object({
  courseNumber: z.string().min(1).max(200),
  requirementsFile: z.string().min(1).max(200),
  requirementId: z.string().min(1).max(200),
  basedOn: basedOnSchema,
});

/**
 * Every Progress answer, read or write, in one shape: the evaluated Programs and the revision they
 * were read from, or the named 409 a refusal has always been.
 */
function progressAnswer(c: Context, result: ProgressResult) {
  if (result.kind === "refused") {
    return c.json({ reason: result.reason, warnings: result.warnings }, 409);
  }
  return c.json({ ...result.view, version: result.version, warnings: result.warnings });
}

/**
 * An Attempt to add (#290): a Course, the Semester of an Academic Year, a status and an optional
 * grade, each in the State File's own vocabulary, so a malformed status is refused here as the
 * shape of the request it is, before the domain sees it. A grade outside 0–100 is a shape this
 * accepts: it is a Warning with the Attempts, never a refusal (CLAUDE.md).
 */
const semesterPlaceShape = {
  // a number in the body, never coerced from text as a year in a path is
  academicYear: z.number().int().min(1900).max(2200),
  semester: semesterSchema,
};
const addedAttemptSchema = z.object({
  courseNumber: z.string().min(1).max(200),
  ...semesterPlaceShape,
  status: statusSchema,
  grade: gradeSchema.optional(),
  basedOn: basedOnSchema,
});

/**
 * A change to an Attempt's result: the status, the grade, or both. `grade: null` clears the grade,
 * since JSON has no `undefined` and a field left out means "leave it alone".
 */
const changedAttemptSchema = z.object({
  status: statusSchema.optional(),
  grade: gradeSchema.nullable().optional(),
  basedOn: basedOnSchema,
});

/** Where an Attempt moves to: another Semester, of the same Academic Year or another. */
const movedAttemptSchema = z.object({ ...semesterPlaceShape, basedOn: basedOnSchema });

/** Removing an Attempt carries nothing but the revision it was based on. */
const removedAttemptSchema = z.object({ basedOn: basedOnSchema });

/**
 * Every Plan answer, read or write, in one shape: the Attempts with their Warnings and the revision
 * they were read from, or the named 409 a refusal has always been.
 */
function planAnswer(c: Context, result: PlanResult & { added?: string }) {
  if (result.kind === "refused") {
    return c.json({ reason: result.reason, warnings: result.warnings }, 409);
  }
  return c.json({
    ...result.view,
    ...(result.added === undefined ? {} : { added: result.added }),
    version: result.version,
    warnings: result.warnings,
  });
}

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

/**
 * Which Variant a read is about, off the query: `?variant=` names one, and its absence means the
 * primary (`app/src/picks.ts`, `variantShownIn`).
 */
function variantQuery(
  c: Context,
): { ok: true; variant: string | undefined } | { ok: false; error: "bad-variant" } {
  const variant = variantSchema.safeParse(c.req.query("variant"));
  return variant.success ? { ok: true, variant: variant.data } : { ok: false, error: "bad-variant" };
}

/**
 * Every Timetable answer, read or write, in one shape: the view and the revision it is, or the
 * named 409 a refusal has always been. One function, so a Variant route cannot answer in a
 * shape the Pick routes do not — the page reads them all with one reader (`web/src/timetable/picks.ts`).
 */
function timetableAnswer(c: Context, result: TimetableResult) {
  if (result.kind === "refused") {
    // `state-file-changed` among the reasons: a 409, because the request is well formed and
    // conflicts with the state of the file (#90)
    return c.json({ reason: result.reason, warnings: result.warnings }, 409);
  }
  return c.json({ ...result.view, version: result.version, warnings: result.warnings });
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
     * argument for lives: the Workspace Layout probe behind it reports a part it cannot resolve as
     * *missing* rather than raising, so the hole the POST below had is not open here (#141).
     */
    .get("/api/workspace", async (c) => c.json(await workspaceStatus(workspace)))

    /**
     * Creating the Workspace Layout is an explicit act, which is why it is a POST and not a side
     * effect of the GET above: nothing is written until the student asks.
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

    /**
     * The Requirements Files the Workspace holds (#287), each by its name within `requirements/`
     * and never by a path: its Program, its Cohorts and its Tracks, so a student can tell which
     * one is theirs, and the Warnings its reading raised. A file that is not a Requirements File
     * is listed by name with the Warnings saying why, and one the Workspace would not read with
     * `app`'s own sentence (`app/src/refusal.ts`).
     *
     * Recomputed on every request, so a file dropped into the folder or taken out of it is seen
     * on the next read — which the change count is what prompts the page to make.
     *
     * A `requirements/` that is there and cannot be listed is the named 409 every Workspace
     * refusal is, and never an empty list.
     */
    .get("/api/requirements", async (c) => {
      const result = await listRequirementsFiles(workspace);
      if (result.kind === "refused") return c.json({ reason: result.reason }, 409);
      return c.json({ files: result.files });
    })

    /**
     * Imports a Requirements File under a name, as the Catalog import stores a Raw Crawl: into a
     * folder the student has accepted as a Workspace, and never as a side effect. A file that is
     * not a Requirements File is refused with the Warnings saying why; one with problems is stored
     * and its Warnings come back with it. A name already taken is replaced, and `replaced` says so.
     */
    .post("/api/requirements/import", capped, async (c) => {
      const body = await bodyAs(c, requirementsImportSchema, "not-a-requirements-import");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const result = await importRequirementsFile(workspace, body.value.name, body.value.file);
      if (!result.stored) {
        return c.json(
          result.warnings
            ? { reason: result.reason, warnings: result.warnings }
            : { reason: result.reason },
          409,
        );
      }
      return c.json({ listed: result.listed, replaced: result.replaced });
    })

    /**
     * The student's Cohort and Programs (#287), and the Warnings for a Programs entry naming a file
     * the Workspace does not hold or a Track that file does not define. No State File and no path
     * is named, as the settings routes name none (ADR-0002). `version` is the revision this was
     * read from, and what a change has to be based on.
     */
    .get("/api/programs", async (c) => programsAnswer(c, await readPrograms(workspace)))

    /**
     * Sets the whole list of Programs. A save like any other: it carries its revision, is refused
     * `state-file-changed` when the file moved since, and is one undo step because `into` hears
     * it (ADR-0013). A Program the Workspace cannot honour is stored and comes back as a Warning.
     */
    .put("/api/programs", capped, async (c) => {
      const body = await bodyAs(c, savedProgramsSchema, "not-programs");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, programs } = body.value;
      return programsAnswer(
        c,
        await choosePrograms(workspace, programs, { basedOn, history: into }),
      );
    })

    /** Sets the Cohort, or clears it with `null`: a save, one undo step, as the Programs are. */
    .put("/api/cohort", capped, async (c) => {
      const body = await bodyAs(c, savedCohortSchema, "not-a-cohort");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, cohort } = body.value;
      return programsAnswer(
        c,
        await chooseCohort(workspace, cohort ?? undefined, { basedOn, history: into }),
      );
    })

    /**
     * Progress (#288): each chosen Program's Requirement tree, evaluated in both lenses, with the
     * Courses counting toward each node, the student's Pins, where each attempted Course could be
     * pinned, whether the solver stopped early, and the Warnings. Recomputed from the State File
     * and the Requirements Files on every request; nothing is cached. No path is named.
     */
    .get("/api/progress", async (c) => progressAnswer(c, await readProgress(workspace)))

    /**
     * Pins a Course to a Requirement of one Program, replacing the Pin it had there, and unpins
     * one. A save each, carrying its revision and refused `state-file-changed` when the file moved
     * since; one undo step each because `into` hears it (ADR-0013). A Pin the engine cannot honour
     * is stored and comes back as a Warning.
     */
    .post("/api/progress/pins", capped, async (c) => {
      const body = await bodyAs(c, savedPinSchema, "not-a-pin");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...pin } = body.value;
      return progressAnswer(c, await pinCourseTo(workspace, pin, { basedOn, history: into }));
    })

    .delete("/api/progress/pins", capped, async (c) => {
      const body = await bodyAs(c, savedPinSchema, "not-a-pin");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...pin } = body.value;
      return progressAnswer(c, await unpinCourseFrom(workspace, pin, { basedOn, history: into }));
    })

    /** Ticks a Manual Requirement, and unticks one: a save each, one undo step each. */
    .post("/api/progress/ticks", capped, async (c) => {
      const body = await bodyAs(c, savedTickSchema, "not-a-tick");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...tick } = body.value;
      return progressAnswer(
        c,
        await tickManualRequirement(workspace, tick, { basedOn, history: into }),
      );
    })

    .delete("/api/progress/ticks", capped, async (c) => {
      const body = await bodyAs(c, savedTickSchema, "not-a-tick");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...tick } = body.value;
      return progressAnswer(
        c,
        await untickManualRequirement(workspace, tick, { basedOn, history: into }),
      );
    })

    /**
     * The Plan (#290): every Attempt with its id, the Warnings over them, and the revision they
     * were read from. One domain read, so every screen sees the same Plan. No path is named.
     */
    .get("/api/plan", async (c) => planAnswer(c, await readPlan(workspace)))

    /**
     * Adds an Attempt, and answers with the Plan and the new Attempt's id in `added`. A save like
     * any other: it carries its revision, is refused `state-file-changed` when the file moved
     * since, and is one undo step because `into` hears it (ADR-0013). The same holds for the three
     * routes below, which name the Attempt by its id in the path — an id, never a file.
     */
    .post("/api/plan/attempts", capped, async (c) => {
      const body = await bodyAs(c, addedAttemptSchema, "not-an-attempt");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, grade, ...fields } = body.value;
      return planAnswer(
        c,
        await addAttemptTo(workspace, { ...fields, ...(grade === undefined ? {} : { grade }) }, {
          basedOn,
          history: into,
        }),
      );
    })

    /** Changes an Attempt's status, its grade, or both. */
    .patch("/api/plan/attempts/:id", capped, async (c) => {
      const id = attemptIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "bad-attempt-id" }, 400);
      const body = await bodyAs(c, changedAttemptSchema, "not-an-attempt-change");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...change } = body.value;
      return planAnswer(c, await updateAttemptOf(workspace, id.data, change, { basedOn, history: into }));
    })

    /** Moves an Attempt to another Semester. */
    .put("/api/plan/attempts/:id/semester", capped, async (c) => {
      const id = attemptIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "bad-attempt-id" }, 400);
      const body = await bodyAs(c, movedAttemptSchema, "not-a-semester");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...to } = body.value;
      return planAnswer(c, await moveAttemptTo(workspace, id.data, to, { basedOn, history: into }));
    })

    /** Removes an Attempt. */
    .delete("/api/plan/attempts/:id", capped, async (c) => {
      const id = attemptIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "bad-attempt-id" }, 400);
      const body = await bodyAs(c, removedAttemptSchema, "not-a-removal");
      if (!body.ok) return c.json({ error: body.error }, 400);
      return planAnswer(c, await removeAttemptFrom(workspace, id.data, { basedOn: body.value.basedOn, history: into }));
    })

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
     * Workspace adapter's (ADR-0002). `?variant=` names the Variant, and without it the answer
     * is about the primary one (#281); every Variant of the Timetable comes back as `variants`,
     * for the tabs.
     */
    .get("/api/timetable/:year/:semester", async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const variant = variantQuery(c);
      if (!variant.ok) return c.json({ error: variant.error }, 400);

      const result = await readTimetable(workspace, { ...ref.at, variant: variant.variant });
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
     * One Semester's exam period: the sittings in date order, the Exam Clashes among them and
     * the spacing Warnings — at the threshold **this student stored** (#164).
     *
     * `docs/design.md` has said "fewer than 3 days apart (adjustable in settings)" since the
     * design was written, and until this route the adjustment changed nothing a student could
     * see: `examSpacingDays` was readable and writable (#115) and no caller passed it to
     * `checkExams`. `app/src/exams.ts` is that caller and this is where its answer comes out.
     *
     * **A route beside the week rather than a field on it.** An Exam belongs to the Offering and
     * is shared by all its Groups (CONTEXT.md), so this answer needs the Catalog as well as the
     * State File, while a Pick needs neither — and `TimetableView` is what every write route
     * answers with, so folding the exam period in would put a Catalog read behind every Pick and
     * every undo. The exam rail is its own panel in the side pane (`docs/design.md`, "Screens"),
     * and this is its own read of its own two files.
     *
     * Domain operations and no file path, as everywhere: a year and a Semester name it, and which
     * Catalog or State File holds the answer is the Workspace adapter's business (ADR-0002).
     *
     * Three lists of Warnings and not one, because they are about three things: the Exam Clashes
     * and spacing live under `exams`, where they are the domain's own answer; `warnings` is about
     * the State File the Picks and the threshold came from; `catalogWarnings` is about the
     * Catalog the Exams came from. The State File's and the Catalog's `kind`s overlap — a
     * `file-unreadable` is each file's way of being unreadable — so merging them would lose which
     * file a student has to go and look at.
     *
     * A refusal is the named 409 the week answers with, and for the same reason: the Picks and
     * the threshold are in the State File, so a State File that cannot be read leaves no question
     * to answer. A Catalog that cannot be served is **not** a refusal — it is an exam period
     * nobody has published, which comes back as a Warning and a rail that admits it is partial.
     */
    .get("/api/timetable/:year/:semester/exams", async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      // the same `?variant=` the week takes, so the rail can follow the tab the week shows
      const variant = variantQuery(c);
      if (!variant.ok) return c.json({ error: variant.error }, 400);

      const result = await readExams(workspace, { ...ref.at, variant: variant.variant });
      if (result.kind === "refused") {
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({
        // named as the week's answer names it, so a page can see that the rail it draws and the
        // grid beside it are about one Variant
        variantName: result.variantName,
        exams: result.exams,
        // what "too close" means here, so whatever draws the rail says the student's own number
        // rather than repeating a default it would be free to get wrong
        spacingDays: result.spacingDays,
        version: result.version,
        warnings: result.warnings,
        catalogWarnings: result.catalogWarnings,
      });
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

      const { basedOn, variant, ...pick } = body.value;
      const result = await pickGroup(workspace, { ...ref.at, variant }, pick, {
        basedOn,
        history: into,
      });
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

      const { basedOn, variant, ...slot } = body.value;
      const result = await removeGroupPick(workspace, { ...ref.at, variant }, slot, {
        basedOn,
        history: into,
      });
      if (result.kind === "refused") {
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({ ...result.view, version: result.version, warnings: result.warnings });
    })

    /**
     * The Variant tabs (#281): create, duplicate, rename, delete and make primary.
     *
     * Domain operations on the Timetable of one Semester, and a Variant is named by its name — the
     * student's own text, in the body rather than the path, so no name ever has to survive being a
     * URL segment. No route takes a file path (ADR-0002).
     *
     * Each is a save exactly as a Pick is: it carries the revision the page was based on, is
     * refused `state-file-changed` when the file moved since, answers with the new revision, and
     * is one undo step because `into` hears it (ADR-0013). Each answers with the Timetable about
     * the Variant the student should look at next — the one just made, renamed or made primary,
     * and the primary after a delete. A name another Variant has is written, and the collision
     * comes back in `variantWarnings`.
     */
    .post("/api/timetable/:year/:semester/variants", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, newVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, name } = body.value;
      return timetableAnswer(
        c,
        await addVariant(workspace, ref.at, name === undefined ? {} : { name }, {
          basedOn,
          history: into,
        }),
      );
    })

    .post("/api/timetable/:year/:semester/variants/duplicate", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, duplicatedVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, name } = body.value;
      return timetableAnswer(
        c,
        await duplicateVariantAs(
          workspace,
          { ...ref.at, variant },
          name === undefined ? {} : { name },
          { basedOn, history: into },
        ),
      );
    })

    .post("/api/timetable/:year/:semester/variants/rename", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, renamedVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, name } = body.value;
      return timetableAnswer(
        c,
        await renameVariantAs(workspace, { ...ref.at, variant }, name, { basedOn, history: into }),
      );
    })

    .post("/api/timetable/:year/:semester/variants/primary", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, namedVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant } = body.value;
      return timetableAnswer(
        c,
        await makeVariantPrimary(workspace, { ...ref.at, variant }, { basedOn, history: into }),
      );
    })

    /**
     * The Tray (#283): add a Course to the Tray of the Variant named — the primary when none is —
     * and take one out. Taking one out takes its Picks in that Variant with it, in the same save,
     * so it is one undo step. Every Timetable answer carries the Tray as derived, chips and all.
     */
    .post("/api/timetable/:year/:semester/tray", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, trayCourseSchema, "not-a-tray-course");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, courseNumber } = body.value;
      return timetableAnswer(
        c,
        await addCourseToTray(workspace, { ...ref.at, variant }, courseNumber, {
          basedOn,
          history: into,
        }),
      );
    })

    .delete("/api/timetable/:year/:semester/tray", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, trayCourseSchema, "not-a-tray-course");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, courseNumber } = body.value;
      return timetableAnswer(
        c,
        await removeCourseFromTray(workspace, { ...ref.at, variant }, courseNumber, {
          basedOn,
          history: into,
        }),
      );
    })

    /**
     * Blocked Times (#282): add, replace, remove, and copy to another Semester. Domain
     * operations on the Timetable of one Semester; a Blocked Time is addressed by its position
     * in the list the Timetable answer carries, which is safe because the save is refused when
     * the file moved since that answer (#90). Each is one undo step, and each answers with the
     * Timetable — Blocked Times, the Clashes with them, and any Warning — about the Variant named.
     */
    .post("/api/timetable/:year/:semester/blocked-times", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, newBlockedTimeSchema, "not-a-blocked-time");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, ...range } = body.value;
      return timetableAnswer(
        c,
        await addBlockedTimeTo(workspace, { ...ref.at, variant }, range, {
          basedOn,
          history: into,
        }),
      );
    })

    .put("/api/timetable/:year/:semester/blocked-times", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, replacedBlockedTimeSchema, "not-a-blocked-time");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, index, ...range } = body.value;
      return timetableAnswer(
        c,
        await replaceBlockedTimeAt(workspace, { ...ref.at, variant }, index, range, {
          basedOn,
          history: into,
        }),
      );
    })

    .delete("/api/timetable/:year/:semester/blocked-times", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, removedBlockedTimeSchema, "not-a-blocked-time");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, index } = body.value;
      return timetableAnswer(
        c,
        await removeBlockedTimeAt(workspace, { ...ref.at, variant }, index, {
          basedOn,
          history: into,
        }),
      );
    })

    .post("/api/timetable/:year/:semester/blocked-times/copy", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, copiedBlockedTimesSchema, "not-a-blocked-time-copy");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, toYear, toSemester } = body.value;
      return timetableAnswer(
        c,
        await copyBlockedTimesTo(
          workspace,
          { ...ref.at, variant },
          { academicYear: toYear, semester: toSemester },
          { basedOn, history: into },
        ),
      );
    })

    .delete("/api/timetable/:year/:semester/variants", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, namedVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant } = body.value;
      return timetableAnswer(
        c,
        await removeVariant(workspace, { ...ref.at, variant }, { basedOn, history: into }),
      );
    })

    /**
     * The snapshots of the student's State File, newest first — the listing behind "backups and
     * restore" on the Workspace screen (docs/design.md, "Screens").
     *
     * Each is one moment and nothing else, which is all that tells two apart and all a restore
     * needs: no file name, no path, no size (ADR-0002). No State File is named in the path
     * either, exactly as the history and settings routes name none.
     *
     * A refusal is the same named 409 every other Workspace route answers with, and it means
     * exactly one thing: `.backups/` is there and cannot be listed. It is **not** "the folder
     * is not a Workspace yet" — that is an empty list, which the test below pins — and it is
     * never "no backups", which is an empty list too and a perfectly good answer.
     */
    .get("/api/backups", async (c) => {
      const result = await listBackups(workspace);
      if (result.kind === "refused") return c.json({ reason: result.reason }, 409);

      return c.json({ snapshots: result.snapshots });
    })

    /**
     * Puts one snapshot back into the State File.
     *
     * A POST and not a PUT: it is not idempotent in any useful sense, because the restore is
     * itself a save that takes its own snapshot of what it replaced, so restoring twice leaves
     * a different folder behind the second time.
     *
     * **The UI half is not wired.** The Workspace screen does not exist yet — only the
     * Timetable does — so nothing calls this route today and nothing renders its refusals; #67
     * builds the use case and the route and says so rather than building a screen it was not
     * asked for. A page that reuses the Timetable's wording for these reasons would be wrong
     * about them: `workspace-refused` there is worded as Picks that could not be read.
     *
     * `into` is passed because a restore is undoable and because the stacks have to hear the
     * revision every save wrote (ADR-0013). `unchanged` is a 200 and not a refusal: restoring
     * the snapshot the file already holds is a request that was honoured and simply moved
     * nothing.
     */
    .post("/api/backups/restore", capped, async (c) => {
      const body = await bodyAs(c, restoreSchema, "not-a-restore");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const result = await restoreBackup(workspace, {
        takenAt: body.value.takenAt,
        basedOn: body.value.basedOn,
        history: into,
      });
      if (result.kind === "refused") {
        // `backup-not-found` among the reasons, and a 409 rather than a 404: the request is
        // well formed and conflicts with the state of the folder, which is what every other
        // refusal out of this port answers with. A stale listing is the ordinary way to get
        // here, and the page's answer to it is to list again — the same thing it does for
        // `state-file-changed`.
        return c.json({ reason: result.reason, warnings: result.warnings }, 409);
      }

      return c.json({
        kind: result.kind,
        takenAt: result.takenAt,
        version: result.version,
        warnings: result.warnings,
      });
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
