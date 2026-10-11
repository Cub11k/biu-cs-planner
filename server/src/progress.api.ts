import { Hono, type Context } from "hono";
import {
  chooseCohort,
  choosePrograms,
  importRequirementsFile,
  listRequirementsFiles,
  pinCourseTo,
  readPrograms,
  readProgress,
  tickManualRequirement,
  unpinCourseFrom,
  untickManualRequirement,
  type ProgramsResult,
  type ProgressResult,
} from "@biu-cs-planner/app";
import { programSchema, studentCohortSchema } from "@biu-cs-planner/core";
import { z } from "zod";
import {
  answer,
  basedOnSchema,
  bodyAs,
  capped,
  hasDangerousKey,
  type RouteDependencies,
  type Served,
} from "./api.shared.ts";

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
 * revision it is, or (through `answer`) the named 409 a refusal has always been. `cohort` is
 * `null` when there is none, so the page reads one field that is always there.
 */
function programsFields(result: Served<ProgramsResult>) {
  return {
    cohort: result.view.cohort ?? null,
    programs: result.view.programs,
    programWarnings: result.view.programWarnings,
    version: result.version,
    warnings: result.warnings,
  };
}

/**
 * Which Manual Requirement a tick is about (#288): its id and the Requirements File it is an id in
 * — always the file, since an id is unique only within one (`GLOSSARY.md`, Pin) — and the revision
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
 * "What if I switched Track" (#289): the Programs a Progress read evaluates in place of the stored
 * ones, carried in `?whatIf=` as the JSON of the same list `PUT /api/programs` takes. A read with it
 * is still a read — `GET`, no `basedOn`, and nothing saved or put on the undo stacks — which is why
 * it is a query on this route and not a body on a route that writes.
 *
 * The text is parsed as JSON and checked like a body (no dangerous key, then the schema), never
 * evaluated (CLAUDE.md), and what was wrong is named the way `bodyAs` names it. No `whatIf` at all
 * is no what-if.
 */
function whatIfOf(
  c: Context,
): { ok: true; value: z.infer<typeof savedProgramsSchema>["programs"] | undefined } | { ok: false; error: string } {
  const text = c.req.query("whatIf");
  if (text === undefined) return { ok: true, value: undefined };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "body-not-json" };
  }
  if (hasDangerousKey(value)) return { ok: false, error: "unsafe-keys" };
  const parsed = savedProgramsSchema.shape.programs.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: "not-programs" };
}

/**
 * Every Progress answer, read or write, in one shape: the evaluated Programs and the revision they
 * were read from, or (through `answer`) the named 409 a refusal has always been. `cohort` is `null`
 * when there is none, as `programsFields` gives it, so the page reads one field that is always there.
 */
function progressFields(result: Served<ProgressResult>) {
  return {
    ...result.view,
    cohort: result.view.cohort ?? null,
    version: result.version,
    warnings: result.warnings,
  };
}


/**
 * The Progress and requirements routes: the Requirements Files, the student's Cohort and Programs,
 * Progress with its what-if, Pins and ticks.
 */
export function progressRoutes({ workspace, into }: RouteDependencies) {
  return new Hono()
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
    .get("/api/programs", async (c) => answer(c, await readPrograms(workspace), programsFields))

    /**
     * Sets the whole list of Programs. A save like any other: it carries its revision, is refused
     * `state-file-changed` when the file moved since, and is one undo step because `into` hears
     * it (ADR-0013). A Program the Workspace cannot honour is stored and comes back as a Warning.
     */
    .put("/api/programs", capped, async (c) => {
      const body = await bodyAs(c, savedProgramsSchema, "not-programs");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, programs } = body.value;
      return answer(
        c,
        await choosePrograms(workspace, programs, { basedOn, history: into }),
        programsFields,
      );
    })

    /** Sets the Cohort, or clears it with `null`: a save, one undo step, as the Programs are. */
    .put("/api/cohort", capped, async (c) => {
      const body = await bodyAs(c, savedCohortSchema, "not-a-cohort");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, cohort } = body.value;
      return answer(
        c,
        await chooseCohort(workspace, cohort ?? undefined, { basedOn, history: into }),
        programsFields,
      );
    })

    /**
     * Progress (#288): each chosen Program's Requirement tree, evaluated in both lenses, with the
     * Courses counting toward each node, the student's Pins, where each attempted Course could be
     * pinned, whether the solver stopped early, and the Warnings. Recomputed from the State File
     * and the Requirements Files on every request; nothing is cached. No path is named.
     *
     * With `?whatIf=`, the same answer for other Programs (#289), evaluated and never saved; see
     * `whatIfOf`. `version` is still the file's, which is what adopting the what-if is based on.
     */
    .get("/api/progress", async (c) => {
      const whatIf = whatIfOf(c);
      if (!whatIf.ok) return c.json({ error: whatIf.error }, 400);
      return answer(
        c,
        await readProgress(workspace, whatIf.value === undefined ? {} : { whatIf: whatIf.value }),
        progressFields,
      );
    })

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
      return answer(c, await pinCourseTo(workspace, pin, { basedOn, history: into }), progressFields);
    })

    .delete("/api/progress/pins", capped, async (c) => {
      const body = await bodyAs(c, savedPinSchema, "not-a-pin");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...pin } = body.value;
      return answer(c, await unpinCourseFrom(workspace, pin, { basedOn, history: into }), progressFields);
    })

    /** Ticks a Manual Requirement, and unticks one: a save each, one undo step each. */
    .post("/api/progress/ticks", capped, async (c) => {
      const body = await bodyAs(c, savedTickSchema, "not-a-tick");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...tick } = body.value;
      return answer(
        c,
        await tickManualRequirement(workspace, tick, { basedOn, history: into }),
        progressFields,
      );
    })

    .delete("/api/progress/ticks", capped, async (c) => {
      const body = await bodyAs(c, savedTickSchema, "not-a-tick");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...tick } = body.value;
      return answer(
        c,
        await untickManualRequirement(workspace, tick, { basedOn, history: into }),
        progressFields,
      );
    });
}
