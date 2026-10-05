import { z } from "zod";
import { semesterSchema } from "../catalog/schema.ts";

/**
 * A Requirements File is the rules of one Program for one or more Cohorts, written by hand from
 * the department's PDF or Excel (ADR-0007). As with the Catalog and the State File, the Zod
 * schemas here are the single source of truth: the types are inferred from them, `file.ts`
 * validates every read through them and exports JSON Schema from them for a maintainer's editor.
 * Unknown keys are stripped rather than carried.
 *
 * **Everything is data and nothing is executed.** A Pool is a list, a course-number prefix
 * compared as a string, or a course-number range compared as numbers. No field is ever turned
 * into a pattern, a function or code.
 *
 * Each record that has a part `file.ts` reads one entry at a time is declared as a *head* plus
 * the full schema that extends it, the way `variantHeadSchema` and `variantSchema` are in
 * `../state/schema.ts`: the reader parses the head, then each entry of the list under it, so one
 * unreadable Requirement costs that Requirement rather than the subtree holding it.
 */
export const CURRENT_REQUIREMENTS_SCHEMA_VERSION = 1;

/** Text a student reads: Hebrew always, English when the maintainer wrote it. */
export const textSchema = z.object({
  he: z.string(),
  en: z.string().optional(),
});

/**
 * An id the maintainer assigns. A Pin names a Requirement by its id — and, since #287, the
 * Requirements File it is an id in (`CONTEXT.md`, Pin) — so ids are written, never derived from a
 * position or a text that can move.
 */
const idSchema = z.string().min(1);

/** A course number as the Catalog spells it, `89-110`. Matched by string comparison only. */
const courseNumberSchema = z.string().min(1);

/** The Semester a Requirements File says a Course is normally given in. */
export const offeringPatternSchema = z.enum(["fall", "spring", "year-long"]);

// --- Pools ------------------------------------------------------------------------------------

const poolHead = { id: idSchema, name: textSchema.optional() };

/**
 * A named set of Courses a Requirement draws from.
 *
 * - `list`: exactly these course numbers.
 * - `prefix`: every course number that starts with `prefix`, compared as strings, so `89-3`
 *   is every 89-3xx and 89-3xxx Course.
 * - `range`: every course number in `department` whose number after the hyphen, read as a whole
 *   number, lies between `from` and `to` inclusive. Numbers rather than strings because
 *   `89-1195` sorts between `89-110` and `89-120` as a string and is far outside `100`–`199` as
 *   a number. A course number whose part after the hyphen is not all digits is in no range.
 */
export const poolSchema = z.discriminatedUnion("kind", [
  z.object({ ...poolHead, kind: z.literal("list"), courses: z.array(courseNumberSchema) }),
  z.object({ ...poolHead, kind: z.literal("prefix"), prefix: z.string().min(1) }),
  z.object({
    ...poolHead,
    kind: z.literal("range"),
    department: z.string().min(1),
    from: z.number().int().min(0),
    to: z.number().int().min(0),
  }),
]);

/** A named set of Courses a Prerequisite can name, such as "all first-year Courses". */
export const courseSetSchema = z.object({
  id: idSchema,
  name: textSchema.optional(),
  courses: z.array(courseNumberSchema),
});

// --- Prerequisites ----------------------------------------------------------------------------

/**
 * What must hold before a Course is taken. `passed` may demand a minimum grade, and
 * `allowConcurrent` says the Prerequisite may be taken in the same Semester. `set` demands every
 * Course of a named Course set, `manual` is anything the vocabulary cannot express, carried as
 * the department's text, and `allOf` / `anyOf` combine the rest.
 *
 * Evaluating Prerequisites is the Plan checks' job (#291); this file only gives them a shape.
 */
const allOfPrerequisiteHead = z.object({ kind: z.literal("allOf") });
const anyOfPrerequisiteHead = z.object({ kind: z.literal("anyOf") });

const leafPrerequisiteSchemas = [
  z.object({
    kind: z.literal("passed"),
    course: courseNumberSchema,
    minGrade: z.number().optional(),
    allowConcurrent: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("set"),
    set: idSchema,
    allowConcurrent: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("manual"), text: textSchema }),
] as const;

/** One Prerequisite node, with any children left unread: what `file.ts` parses first. */
export const prerequisiteNodeSchema = z.discriminatedUnion("kind", [
  ...leafPrerequisiteSchemas,
  allOfPrerequisiteHead.extend({ of: z.array(z.unknown()) }),
  anyOfPrerequisiteHead.extend({ of: z.array(z.unknown()) }),
]);

export type Prerequisite =
  | z.infer<(typeof leafPrerequisiteSchemas)[number]>
  | { kind: "allOf"; of: Prerequisite[] }
  | { kind: "anyOf"; of: Prerequisite[] };

export const prerequisiteSchema: z.ZodType<Prerequisite> = z.discriminatedUnion("kind", [
  ...leafPrerequisiteSchemas,
  allOfPrerequisiteHead.extend({
    get of() {
      return z.array(prerequisiteSchema);
    },
  }),
  anyOfPrerequisiteHead.extend({
    get of() {
      return z.array(prerequisiteSchema);
    },
  }),
]);

// --- Courses ----------------------------------------------------------------------------------

/**
 * What the Requirements File knows about one Course, independent of any Catalog: future years
 * have none, so credits and the Offering Pattern come from here (`docs/design.md`, "Plan").
 * `credits` is optional so that a file missing one still opens; `file.ts` reports it.
 */
export const courseHeadSchema = z.object({
  number: courseNumberSchema,
  name: textSchema.optional(),
  credits: z.number().min(0).optional(),
  offeringPattern: offeringPatternSchema.optional(),
});

export const courseSchema = courseHeadSchema.extend({
  prerequisites: prerequisiteSchema.optional(),
});

/** `from` counts as `to`: an Attempt of the old number is an Attempt of the Course `to` names. */
export const equivalenceSchema = z.object({
  from: courseNumberSchema,
  to: courseNumberSchema,
});

// --- Requirements -----------------------------------------------------------------------------

const requirementHead = { id: idSchema, name: textSchema.optional() };

const allOfHead = z.object({ ...requirementHead, kind: z.literal("allOf") });
const nOfHead = z.object({
  ...requirementHead,
  kind: z.literal("nOf"),
  n: z.number().int().min(0),
});

/**
 * The building blocks without children. Their meaning, which the engine gives them:
 *
 * - `course`: the one Course is completed and counts here.
 * - `credits`: at least `min` credits from Courses in `pool` count here.
 * - `cap`: at most `max` credits from Courses in `pool` count toward the `credits` Requirements
 *   that share its parent, anywhere below that parent. A limit, not a demand, so it is never
 *   what makes its parent unmet.
 * - `exclusive`: of `courses`, only one counts anywhere below its parent. A limit like `cap`.
 * - `manual`: what the vocabulary cannot express, carried as the department's text, satisfied
 *   only by the student's tick.
 * - `total`: at least `min` credits from every Course the student counts, or from the Courses of
 *   `pool` when one is named, such as "120 credits overall". Totals count everything
 *   (`docs/design.md`, "Assignment"): a `total` takes no Course of its own, so it never competes
 *   with its siblings for one, needs no double-counting permission, and is neither reduced by a
 *   `cap` nor by an `exclusive`. A Course counts toward it once, whatever else it counts toward,
 *   and it cannot be Pinned to. Ruled on #328, as option B: a grand total written as a `credits`
 *   Requirement instead competes for Courses like any other `credits` leaf, and reads as unmet
 *   wherever its Courses are already counted elsewhere.
 */
const leafRequirementSchemas = [
  z.object({ ...requirementHead, kind: z.literal("course"), course: courseNumberSchema }),
  z.object({
    ...requirementHead,
    kind: z.literal("credits"),
    min: z.number().min(0),
    pool: idSchema,
  }),
  z.object({ ...requirementHead, kind: z.literal("cap"), max: z.number().min(0), pool: idSchema }),
  z.object({
    ...requirementHead,
    kind: z.literal("exclusive"),
    courses: z.array(courseNumberSchema).min(2),
  }),
  z.object({ ...requirementHead, kind: z.literal("manual"), text: textSchema }),
  z.object({
    ...requirementHead,
    kind: z.literal("total"),
    min: z.number().min(0),
    pool: idSchema.optional(),
  }),
] as const;

/** One Requirement node, with any children left unread: what `file.ts` parses first. */
export const requirementNodeSchema = z.discriminatedUnion("kind", [
  ...leafRequirementSchemas,
  allOfHead.extend({ of: z.array(z.unknown()) }),
  nOfHead.extend({ of: z.array(z.unknown()) }),
]);

type LeafRequirement = z.infer<(typeof leafRequirementSchemas)[number]>;

/** One node in a Program's rule tree. `allOf` needs every child, `nOf` any `n` of them. */
export type Requirement =
  | LeafRequirement
  | (z.infer<typeof allOfHead> & { of: Requirement[] })
  | (z.infer<typeof nOfHead> & { of: Requirement[] });

export const requirementSchema: z.ZodType<Requirement> = z.discriminatedUnion("kind", [
  ...leafRequirementSchemas,
  allOfHead.extend({
    get of() {
      return z.array(requirementSchema);
    },
  }),
  nOfHead.extend({
    get of() {
      return z.array(requirementSchema);
    },
  }),
]);

/**
 * A named set of extra Requirements a Program offers on top of its base rule set, such as the AI
 * track. Its Requirements sit beside the base ones, as siblings, when the Track is chosen.
 */
export const trackHeadSchema = z.object({ id: idSchema, name: textSchema });

export const trackSchema = trackHeadSchema.extend({
  requirements: z.array(requirementSchema).default([]),
  /**
   * The Track's own entries of the Suggested Layout, placed beside the base rule set's when the
   * Track is chosen (#293), as its Requirements are. `layoutEntrySchema` is declared below.
   */
  get suggestedLayout() {
    return z.array(layoutEntrySchema).default([]);
  },
});

// --- Policies, overlap, layout ----------------------------------------------------------------

/**
 * BIU's rules where they are not yet confirmed (`docs/design.md`, "Open facts").
 *
 * - `passingGrade`: a numeric grade below it is not a pass, whatever the status says.
 * - `gradeAttempt`: which passing Attempt's grade counts when a Course was passed more than once,
 *   as ADR-0009 frames it for minimum-grade Prerequisites: `best` or `latest` *passing* Attempt.
 *   It never decides whether the Course was passed: any passing Attempt completes it, so a pass
 *   followed by a failed retake is still a pass under either policy (ruled on #327). The default
 *   is `best`.
 */
export const policiesSchema = z.object({
  passingGrade: z.number().default(60),
  gradeAttempt: z.enum(["best", "latest"]).default("best"),
});

/**
 * Where a Course may count more than once. By default a Course counts once among sibling
 * Requirements (`docs/design.md`, "Assignment"), so it counts toward at most one Requirement of
 * a Program and toward one Program of a double major.
 *
 * - `within`: a Course may count toward Requirements below two or more of `requirements` at
 *   once, limited to the Courses of `pool` when one is named.
 * - `acrossPrograms`: a Course counted in this Program may also count in the other Program of a
 *   double major, limited to `pool` when one is named. Both Programs' files have to allow it.
 */
export const doubleCountingSchema = z.object({
  within: z
    .array(
      z.object({
        requirements: z.array(idSchema).min(2),
        pool: idSchema.optional(),
      }),
    )
    .default([]),
  acrossPrograms: z.object({ pool: idSchema.optional() }).optional(),
});

/** A study year and Semester relative to the Cohort: year 1 Fall is the Cohort's first. */
const studyPointSchema = z.object({
  studyYear: z.number().int().min(1),
  semester: semesterSchema,
});

/** The department's recommended placement of Courses, by study year and Semester. */
export const layoutEntrySchema = studyPointSchema.extend({
  courses: z.array(courseNumberSchema),
});

/** These Courses must be passed by the end of `by`. Plan checks warn when a Plan misses it. */
export const deadlineSchema = z.object({
  name: textSchema.optional(),
  by: studyPointSchema,
  courses: z.array(courseNumberSchema),
});

/** The Academic Year and Semester a Cohort started in. */
export const cohortSchema = z.object({
  academicYear: z.number().int(),
  semester: semesterSchema,
});

// --- The file ---------------------------------------------------------------------------------

/**
 * What a Requirements File cannot be read without: its version and the Program it is for.
 * Anything else that is missing or unreadable costs only itself.
 */
export const requirementsFileHeadSchema = z.object({
  schemaVersion: z.number(),
  program: z.object({ id: idSchema, name: textSchema }),
});

export const requirementsFileSchema = requirementsFileHeadSchema.extend({
  cohorts: z.array(cohortSchema).default([]),
  policies: policiesSchema.prefault({}),
  pools: z.array(poolSchema).default([]),
  courseSets: z.array(courseSetSchema).default([]),
  courses: z.array(courseSchema).default([]),
  equivalences: z.array(equivalenceSchema).default([]),
  requirements: z.array(requirementSchema).default([]),
  tracks: z.array(trackSchema).default([]),
  doubleCounting: doubleCountingSchema.prefault({}),
  suggestedLayout: z.array(layoutEntrySchema).default([]),
  deadlines: z.array(deadlineSchema).default([]),
});

export type LocalizedText = z.infer<typeof textSchema>;
export type OfferingPattern = z.infer<typeof offeringPatternSchema>;
export type Pool = z.infer<typeof poolSchema>;
export type CourseSet = z.infer<typeof courseSetSchema>;
export type RequirementsCourse = z.infer<typeof courseSchema>;
export type Equivalence = z.infer<typeof equivalenceSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Policies = z.infer<typeof policiesSchema>;
export type DoubleCounting = z.infer<typeof doubleCountingSchema>;
export type LayoutEntry = z.infer<typeof layoutEntrySchema>;
export type Deadline = z.infer<typeof deadlineSchema>;
export type Cohort = z.infer<typeof cohortSchema>;
export type RequirementsFile = z.infer<typeof requirementsFileSchema>;
