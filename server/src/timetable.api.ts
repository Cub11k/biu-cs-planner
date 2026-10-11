import { Hono, type Context } from "hono";
import {
  addBlockedTimeTo,
  addCourseToTray,
  addVariant,
  applyPlanDiffTo,
  copyBlockedTimesTo,
  duplicateVariantAs,
  makeVariantPrimary,
  markVariantRegistered,
  pickGroup,
  readExams,
  readRegistration,
  readTimetable,
  removeBlockedTimeAt,
  removeCourseFromTray,
  removeGroupPick,
  removeVariant,
  renameVariantAs,
  replaceBlockedTimeAt,
  unmarkVariantRegistered,
  type TimetableRef,
  type TimetableResult,
} from "@biu-cs-planner/app";
import { blockedTimeSchema, groupPickSchema, semesterSchema } from "@biu-cs-planner/core";
import { z } from "zod";
import {
  answer,
  basedOnSchema,
  bodyAs,
  capped,
  yearSchema,
  type RouteDependencies,
  type Served,
} from "./api.shared.ts";

/**
 * A Pick request names the slot it fills: one Lesson Type of one Offering. Narrower than
 * `groupPickSchema` because removing a Pick says which one without repeating the Group or
 * the snapshot — and a body is parsed by the shape the route actually takes, never by a
 * wider one it would then have to ignore.
 */
const pickSlotSchema = z.object({ courseNumber: z.string(), lessonType: z.string() });

/**
 * A Variant's name: the student's own text, which is what tells two Variants apart (GLOSSARY.md).
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

/**
 * Which Variant of that name, by its position in file order (#322): two Variants may share a name,
 * which is a Warning, and the position is how the second is reached. Optional, and honoured only
 * when the Variant there carries the name, so a client that never sends it addresses by name.
 */
const positionSchema = z.number().int().min(0).max(10_000).optional();

/** A Pick, the Variant it goes into, and the revision the page that sends it was based on. */
const savedPickSchema = z.object({
  ...groupPickSchema.shape,
  variant: variantSchema,
  position: positionSchema,
  basedOn: basedOnSchema,
});

/** The slot to clear, in which Variant, and the revision the page that sends it was based on. */
const savedSlotSchema = z.object({
  ...pickSlotSchema.shape,
  variant: variantSchema,
  position: positionSchema,
  basedOn: basedOnSchema,
});

/** A new Variant: its name, which a student may leave to the first free letter. */
const newVariantSchema = z.object({ name: variantNameSchema.optional(), basedOn: basedOnSchema });

/** A copy of the Variant named — the primary when none is — under a name that may be left out. */
const duplicatedVariantSchema = z.object({
  variant: variantSchema,
  name: variantNameSchema.optional(),
  position: positionSchema,
  basedOn: basedOnSchema,
});

/** A Variant and the name it is to have. */
const renamedVariantSchema = z.object({
  variant: variantNameSchema,
  name: variantNameSchema,
  position: positionSchema,
  basedOn: basedOnSchema,
});

/** The Variant to delete or to make primary: always named, because both act on one tab. */
const namedVariantSchema = z.object({
  variant: variantNameSchema,
  position: positionSchema,
  basedOn: basedOnSchema,
});

/**
 * A Course to add to a Variant's Tray or take out of it, by course number — never by Catalog
 * entry, as the State File references every Course (#283).
 */
const trayCourseSchema = z.object({
  variant: variantSchema,
  courseNumber: z.string().min(1),
  position: positionSchema,
  basedOn: basedOnSchema,
});

/**
 * Which Plan Diff to apply to the Plan (#295): its kind and its Course, which name it within the
 * Variant's Semester, and the Variant it is a divergence of. A `not-offered` Plan Diff has nothing
 * to apply, so it is not a kind this takes — a body naming one is not the shape of an apply.
 */
const appliedPlanDiffSchema = z.object({
  variant: variantSchema,
  position: positionSchema,
  kind: z.enum(["add", "move-here", "drop", "move"]),
  courseNumber: z.string().min(1).max(200),
  basedOn: basedOnSchema,
});

/**
 * Marking a Variant as the one the student registered with (#297): which Variant — always named,
 * as a make-primary is, because it acts on one tab — and whether the student accepted the offer to
 * apply all its Plan Diffs. Required rather than defaulted, so a client that forgot to ask the
 * student cannot have the Plan rewritten by leaving it out (ADR-0008). Accepting carries the
 * `digest` of the Plan Diffs the preview listed, so what is applied is what the student read (#355);
 * declining needs none.
 */
const registeredVariantShape = { variant: variantNameSchema, position: positionSchema, basedOn: basedOnSchema };
const registeredVariantSchema = z.discriminatedUnion("applyDiffs", [
  z.object({ ...registeredVariantShape, applyDiffs: z.literal(false) }),
  z.object({ ...registeredVariantShape, applyDiffs: z.literal(true), digest: z.string().max(100_000) }),
]);

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
  position: positionSchema,
  basedOn: basedOnSchema,
});

/** A position in the Timetable's list of Blocked Times, which is how one is addressed. */
const blockedIndexSchema = z.number().int().min(0);

const replacedBlockedTimeSchema = z.object({
  ...blockedRangeShape,
  index: blockedIndexSchema,
  variant: variantSchema,
  position: positionSchema,
  basedOn: basedOnSchema,
});

const removedBlockedTimeSchema = z.object({
  index: blockedIndexSchema,
  variant: variantSchema,
  position: positionSchema,
  basedOn: basedOnSchema,
});

/** Where a Semester's Blocked Times are copied to: another Semester, of any Academic Year. */
const copiedBlockedTimesSchema = z.object({
  toYear: z.number().int().min(1900).max(2200),
  toSemester: semesterSchema,
  variant: variantSchema,
  position: positionSchema,
  basedOn: basedOnSchema,
});

/**
 * Which Semester of which Academic Year, off the path. A Timetable covers one Semester of
 * one Academic Year (GLOSSARY.md), so both name it — and both are parsed before anything
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
):
  | { ok: true; variant: string | undefined; position: number | undefined }
  | { ok: false; error: "bad-variant" } {
  const variant = variantSchema.safeParse(c.req.query("variant"));
  // `?position=` beside it, for the second of two Variants sharing a name (#322)
  const asked = c.req.query("position");
  // an empty `?position=` is not position 0: `Number("")` is 0, so it is refused as text that
  // is no number would be
  const position = positionSchema.safeParse(
    asked === undefined ? undefined : asked.trim() === "" ? Number.NaN : Number(asked),
  );
  return variant.success && position.success
    ? { ok: true, variant: variant.data, position: position.data }
    : { ok: false, error: "bad-variant" };
}

/**
 * Every Timetable answer, read or write, in one shape: the view and the revision it is, or
 * (through `answer`) the named 409 a refusal has always been. One function, so a Variant route
 * cannot answer in a shape the Pick routes do not — the page reads them all with one reader
 * (`web/src/timetable/picks.ts`).
 *
 * `version` is which revision of the State File these Picks are, and what a save of an edit made
 * on them has to be based on. Absent when there is no file yet, which is the claim a first save
 * carries. It says nothing about where the file is (ADR-0002): it is a hash of its content, and a
 * caller can do nothing with it but hand it back.
 */
function timetableFields(result: Served<TimetableResult>) {
  return { ...result.view, version: result.version, warnings: result.warnings };
}

/**
 * The Timetable routes of one Semester: the week, its exam period, Picks, the Variant tabs, the
 * Tray, Plan Diffs and registration, and Blocked Times.
 */
export function timetableRoutes({ workspace, into }: RouteDependencies) {
  return new Hono()
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

      const result = await readTimetable(workspace, {
        ...ref.at,
        variant: variant.variant,
        position: variant.position,
      });
      return answer(c, result, timetableFields);
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
     * is shared by all its Groups (GLOSSARY.md), so this answer needs the Catalog as well as the
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
     * to answer. A Catalog that cannot be served is **not** a refusal of the rail — it is an exam
     * period nobody has published, which comes back as a Warning and a rail that admits it is
     * partial. A Catalog the Workspace would not touch is the Catalog query's own refusal arm
     * (#149), and rides inside the 200 as `catalogRefused`, apart from `catalogWarnings`; it is
     * `null` whenever the Catalog was read or looked for.
     */
    .get("/api/timetable/:year/:semester/exams", async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      // the same `?variant=` the week takes, so the rail can follow the tab the week shows
      const variant = variantQuery(c);
      if (!variant.ok) return c.json({ error: variant.error }, 400);

      const result = await readExams(workspace, {
        ...ref.at,
        variant: variant.variant,
        position: variant.position,
      });
      return answer(c, result, (read) => ({
        // named as the week's answer names it, so a page can see that the rail it draws and the
        // grid beside it are about one Variant
        variantName: read.variantName,
        exams: read.exams,
        // what "too close" means here, so whatever draws the rail says the student's own number
        // rather than repeating a default it would be free to get wrong
        spacingDays: read.spacingDays,
        version: read.version,
        warnings: read.warnings,
        catalogWarnings: read.catalogWarnings,
        catalogRefused: read.catalogRefused,
      }));
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

      const { basedOn, variant, position, ...pick } = body.value;
      const result = await pickGroup(workspace, { ...ref.at, variant, position }, pick, {
        basedOn,
        history: into,
      });
      return answer(c, result, timetableFields);
    })

    /** Removes the Pick filling one Lesson Type of one Offering. */
    .delete("/api/timetable/:year/:semester/picks", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);

      const body = await bodyAs(c, savedSlotSchema, "not-a-pick-slot");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position, ...slot } = body.value;
      const result = await removeGroupPick(workspace, { ...ref.at, variant, position }, slot, {
        basedOn,
        history: into,
      });
      return answer(c, result, timetableFields);
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
      return answer(
        c,
        await addVariant(workspace, ref.at, name === undefined ? {} : { name }, {
          basedOn,
          history: into,
        }),
        timetableFields,
      );
    })

    .post("/api/timetable/:year/:semester/variants/duplicate", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, duplicatedVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position, name } = body.value;
      return answer(
        c,
        await duplicateVariantAs(
          workspace,
          { ...ref.at, variant, position },
          name === undefined ? {} : { name },
          { basedOn, history: into },
        ),
        timetableFields,
      );
    })

    .post("/api/timetable/:year/:semester/variants/rename", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, renamedVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position, name } = body.value;
      return answer(
        c,
        await renameVariantAs(workspace, { ...ref.at, variant, position }, name, {
          basedOn,
          history: into,
        }),
        timetableFields,
      );
    })

    .post("/api/timetable/:year/:semester/variants/primary", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, namedVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position } = body.value;
      return answer(
        c,
        await makeVariantPrimary(workspace, { ...ref.at, variant, position }, {
          basedOn,
          history: into,
        }),
        timetableFields,
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

      const { basedOn, variant, position, courseNumber } = body.value;
      return answer(
        c,
        await addCourseToTray(workspace, { ...ref.at, variant, position }, courseNumber, {
          basedOn,
          history: into,
        }),
        timetableFields,
      );
    })

    .delete("/api/timetable/:year/:semester/tray", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, trayCourseSchema, "not-a-tray-course");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position, courseNumber } = body.value;
      return answer(
        c,
        await removeCourseFromTray(workspace, { ...ref.at, variant, position }, courseNumber, {
          basedOn,
          history: into,
        }),
        timetableFields,
      );
    })

    /**
     * "Apply to Plan" for one Plan Diff of the Variant named (#295; ADR-0008): one save, one undo
     * step, and only the Plan's Attempts change — never the Timetable. Answered with the Timetable
     * afterwards, whose Plan Diffs no longer hold the one applied. A Plan Diff the file as it stands
     * no longer has is refused `plan-diff-stale` with the revision the file still holds, and
     * nothing is written; a stale revision is the usual `state-file-changed`.
     */
    .post("/api/timetable/:year/:semester/plan-diffs/apply", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, appliedPlanDiffSchema, "not-a-plan-diff");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position, kind, courseNumber } = body.value;
      const result = await applyPlanDiffTo(
        workspace,
        { ...ref.at, variant, position },
        { kind, courseNumber },
        { basedOn, history: into },
      );
      if (result.kind === "plan-diff-stale") {
        return c.json({ reason: result.kind, version: result.version, warnings: result.warnings }, 409);
      }
      return answer(c, result, timetableFields);
    })

    /**
     * What marking the Variant named registered with "apply all" would do (#297), for the student
     * to see before accepting: its Plan Diffs, `not-offered` ones among them, and the Courses whose
     * Attempt would become registered. A read: nothing is written. `version` is what the mark has
     * to be based on, and `digest` what "apply all" has to send back (#355).
     *
     * A Variant name the file does not hold is a 404 `variant-not-found`, as the mark's is (#355).
     * A 404 rather than the 409 `backup-not-found` is, because a stale tab does not get here: a
     * Variant another writer deleted moved the file, and the mark is refused `state-file-changed`
     * first. What reaches this names a Variant the file never had.
     */
    .get("/api/timetable/:year/:semester/registration", async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const variant = variantQuery(c);
      if (!variant.ok) return c.json({ error: variant.error }, 400);

      const result = await readRegistration(workspace, {
        ...ref.at,
        variant: variant.variant,
        position: variant.position,
      });
      if (result.kind === "variant-not-found") {
        return c.json({ reason: result.kind, version: result.version, warnings: result.warnings }, 404);
      }
      return answer(c, result, (read) => ({
        variantName: read.variantName,
        variantPosition: read.variantPosition,
        planDiffs: read.planDiffs,
        registers: read.registers,
        digest: read.digest,
        version: read.version,
        warnings: read.warnings,
      }));
    })

    /**
     * Marks a Variant registered and primary (#297), and with `applyDiffs` applies all its Plan
     * Diffs and registers its Courses' planned Attempts in the same edit: one save, one undo step,
     * all or nothing. Answered with the Timetable, whose tab now carries the mark.
     *
     * "Apply all" whose `digest` is not that of the Plan Diffs as they are now — the Catalog moved
     * since the preview — is refused `plan-diff-stale` and writes nothing, as one stale apply is
     * (#355). A Variant name the file does not hold is a 404 `variant-not-found`, as the preview's is.
     */
    .post("/api/timetable/:year/:semester/variants/registered", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, registeredVariantSchema, "not-a-registration");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position, ...choice } = body.value;
      const result = await markVariantRegistered(workspace, { ...ref.at, variant, position }, choice, {
        basedOn,
        history: into,
      });
      if (result.kind === "plan-diff-stale") {
        return c.json({ reason: result.kind, version: result.version, warnings: result.warnings }, 409);
      }
      if (result.kind === "variant-not-found") {
        return c.json({ reason: result.kind, version: result.version, warnings: result.warnings }, 404);
      }
      return answer(c, result, timetableFields);
    })

    /** Takes the registered mark off a Variant, and nothing else: the Plan is left as it is. */
    .delete("/api/timetable/:year/:semester/variants/registered", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, namedVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position } = body.value;
      return answer(
        c,
        await unmarkVariantRegistered(workspace, { ...ref.at, variant, position }, { basedOn, history: into }),
        timetableFields,
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

      const { basedOn, variant, position, ...range } = body.value;
      return answer(
        c,
        await addBlockedTimeTo(workspace, { ...ref.at, variant, position }, range, {
          basedOn,
          history: into,
        }),
        timetableFields,
      );
    })

    .put("/api/timetable/:year/:semester/blocked-times", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, replacedBlockedTimeSchema, "not-a-blocked-time");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position, index, ...range } = body.value;
      return answer(
        c,
        await replaceBlockedTimeAt(workspace, { ...ref.at, variant, position }, index, range, {
          basedOn,
          history: into,
        }),
        timetableFields,
      );
    })

    .delete("/api/timetable/:year/:semester/blocked-times", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, removedBlockedTimeSchema, "not-a-blocked-time");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position, index } = body.value;
      return answer(
        c,
        await removeBlockedTimeAt(workspace, { ...ref.at, variant, position }, index, {
          basedOn,
          history: into,
        }),
        timetableFields,
      );
    })

    .post("/api/timetable/:year/:semester/blocked-times/copy", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, copiedBlockedTimesSchema, "not-a-blocked-time-copy");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position, toYear, toSemester } = body.value;
      return answer(
        c,
        await copyBlockedTimesTo(
          workspace,
          { ...ref.at, variant, position },
          { academicYear: toYear, semester: toSemester },
          { basedOn, history: into },
        ),
        timetableFields,
      );
    })

    .delete("/api/timetable/:year/:semester/variants", capped, async (c) => {
      const ref = timetableRef(c);
      if (!ref.ok) return c.json({ error: ref.error }, 400);
      const body = await bodyAs(c, namedVariantSchema, "not-a-variant");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, variant, position } = body.value;
      return answer(
        c,
        await removeVariant(workspace, { ...ref.at, variant, position }, { basedOn, history: into }),
        timetableFields,
      );
    });
}
