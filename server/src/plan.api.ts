import { Hono } from "hono";
import {
  addAttemptTo,
  moveAttemptTo,
  planFromSuggestedLayout,
  readPlan,
  removeAttemptFrom,
  updateAttemptOf,
  type PlanResult,
} from "@biu-cs-planner/app";
import { attemptIdSchema, gradeSchema, semesterSchema, statusSchema } from "@biu-cs-planner/core";
import { z } from "zod";
import { answer, basedOnSchema, bodyAs, capped, type RouteDependencies, type Served } from "./api.shared.ts";

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
 * New Plan from Suggested Layout (#293): which of the student's Programs' layout to follow, by its
 * Requirements File's name — the first Program when none is named — and the revision it is based on.
 */
const fromLayoutSchema = z.object({
  requirementsFile: z.string().min(1).max(200).optional(),
  basedOn: basedOnSchema,
});

/**
 * Every Plan answer, read or write, in one shape: the Attempts with their Warnings and the revision
 * they were read from, or (through `answer`) the named 409 a refusal has always been.
 */
function planFields(result: Served<PlanResult> & { added?: string }) {
  return {
    ...result.view,
    ...(result.added === undefined ? {} : { added: result.added }),
    version: result.version,
    warnings: result.warnings,
  };
}

/** The Plan routes: the Attempts, editing one, and a Plan made from a Suggested Layout. */
export function planRoutes({ workspace, into }: RouteDependencies) {
  return new Hono()
    /**
     * The Plan (#290): every Attempt with its id, the Warnings over them, and the revision they
     * were read from. One domain read, so every screen sees the same Plan. No path is named.
     */
    .get("/api/plan", async (c) => answer(c, await readPlan(workspace), planFields))

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
      return answer(
        c,
        await addAttemptTo(workspace, { ...fields, ...(grade === undefined ? {} : { grade }) }, {
          basedOn,
          history: into,
        }),
        planFields,
      );
    })

    /** Changes an Attempt's status, its grade, or both. */
    .patch("/api/plan/attempts/:id", capped, async (c) => {
      const id = attemptIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "bad-attempt-id" }, 400);
      const body = await bodyAs(c, changedAttemptSchema, "not-an-attempt-change");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...change } = body.value;
      return answer(c, await updateAttemptOf(workspace, id.data, change, { basedOn, history: into }), planFields);
    })

    /** Moves an Attempt to another Semester. */
    .put("/api/plan/attempts/:id/semester", capped, async (c) => {
      const id = attemptIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "bad-attempt-id" }, 400);
      const body = await bodyAs(c, movedAttemptSchema, "not-a-semester");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, ...to } = body.value;
      return answer(c, await moveAttemptTo(workspace, id.data, to, { basedOn, history: into }), planFields);
    })

    /** Removes an Attempt. */
    .delete("/api/plan/attempts/:id", capped, async (c) => {
      const id = attemptIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "bad-attempt-id" }, 400);
      const body = await bodyAs(c, removedAttemptSchema, "not-a-removal");
      if (!body.ok) return c.json({ error: body.error }, 400);
      return answer(c, await removeAttemptFrom(workspace, id.data, { basedOn: body.value.basedOn, history: into }), planFields);
    })

    /**
     * New Plan from Suggested Layout (#293): planned Attempts for the layout's Courses, placed
     * relative to the Cohort, skipping Courses the student already has. One save and one undo step,
     * answered with the Plan and a `summary` of what was created and skipped. When it cannot run —
     * no Cohort, no Program, no file, no layout — it writes nothing and answers a named 409 saying
     * which, with the revision the file still holds; a stale revision is the usual 409.
     */
    .post("/api/plan/suggested-layout", capped, async (c) => {
      const body = await bodyAs(c, fromLayoutSchema, "not-a-layout-request");
      if (!body.ok) return c.json({ error: body.error }, 400);
      const { basedOn, requirementsFile } = body.value;
      const result = await planFromSuggestedLayout(workspace, { requirementsFile }, { basedOn, history: into });
      if (result.kind === "unavailable") {
        return c.json({ reason: result.reason, version: result.version }, 409);
      }
      return answer(c, result, (made) => ({
        ...made.view,
        summary: made.summary,
        version: made.version,
        warnings: made.warnings,
      }));
    });
}
