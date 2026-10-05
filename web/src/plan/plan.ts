/**
 * Asking the API for the Plan and sending the Plan screen's edits (#292): adding an Attempt,
 * changing its status or grade, moving it to another Semester, removing it, and New Plan from
 * Suggested Layout (#293). Beside it, the two reads the screen draws with but never edits through:
 * the student's Cohort, which is where the columns start, and the Courses' names and credits.
 *
 * Beside the screen rather than inside it, as `../progress/progress.ts` is, so every answer the API
 * can give is testable against a fake fetch. The shapes are read off the contract and never
 * redeclared here: `web` reaches the domain through the typed client alone (CLAUDE.md).
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import { readBody, UNAUTHORIZED } from "../body.ts";
import type { ApiClient } from "../changes.ts";

type PlanRoutes = ApiClient["api"]["plan"];
type ReadRoute = PlanRoutes["$get"];
type AddRoute = PlanRoutes["attempts"]["$post"];
type AttemptRoutes = PlanRoutes["attempts"][":id"];
type UpdateRoute = AttemptRoutes["$patch"];
type MoveRoute = AttemptRoutes["semester"]["$put"];
type RemoveRoute = AttemptRoutes["$delete"];
type LayoutRoute = PlanRoutes["suggested-layout"]["$post"];
type ProgramsRoute = ApiClient["api"]["programs"]["$get"];
type CoursesRoute = ApiClient["api"]["courses"]["$get"];

type Answer = InferResponseType<ReadRoute>;
type ServedPlan = Extract<Answer, { attempts: unknown }>;
type LayoutAnswer = InferResponseType<LayoutRoute>;
type ServedLayout = Extract<LayoutAnswer, { summary: unknown }>;

/** One Attempt, named by its id. */
export type Attempt = ServedPlan["attempts"][number];
export type Status = Attempt["status"];
export type Grade = NonNullable<Attempt["grade"]>;
export type Semester = Attempt["semester"];
/** A Warning over the Attempts that needs no Requirements File. */
export type AttemptWarning = ServedPlan["attemptWarnings"][number];
/** A Plan check against a chosen Program's Requirements File. */
export type PlanWarning = ServedPlan["planWarnings"][number];
/** What reading the State File raised: an entry left out, a Cohort that could not be read. */
export type StateWarning = ServedPlan["warnings"][number];
/** What New Plan from Suggested Layout created and skipped. */
export type LayoutSummary = ServedLayout["summary"];

/** Why the API would not serve or edit the Plan: the State File's refusals. */
export type PlanRefusal = Extract<Answer, { reason: unknown }>["reason"];

/** What New Plan from Suggested Layout needs and does not have, so it made nothing (#293). */
export const LAYOUT_UNAVAILABLE = [
  "cohort-not-chosen",
  "program-not-chosen",
  "requirements-file-unavailable",
  "no-suggested-layout",
] as const;
export type LayoutUnavailable = (typeof LAYOUT_UNAVAILABLE)[number];

/** The revision the Plan was read from, and what an edit is based on. */
export type PlanVersion = ServedPlan["version"];

export type PlanResult =
  | {
      kind: "served";
      attempts: Attempt[];
      attemptWarnings: AttemptWarning[];
      planWarnings: PlanWarning[];
      stateWarnings: StateWarning[];
      version: PlanVersion;
      /** New Plan from Suggested Layout's account of what it did, on its own answer only. */
      summary?: LayoutSummary;
    }
  | { kind: "refused"; reason: PlanRefusal | undefined }
  /** New Plan from Suggested Layout could not run, and why; nothing was written (#293). */
  | { kind: "unavailable"; reason: LayoutUnavailable }
  /** This page has no launch token, so the server will not talk to it (ADR-0004). */
  | { kind: "unauthorized" }
  /** An answer arrived whose body this page cannot read; nothing is known about the file. */
  | { kind: "unreadable-answer" }
  /** The request never arrived. */
  | { kind: "unreachable" };

type Sent = Response & { ok: boolean; status: number };

const isUnavailable = (reason: unknown): reason is LayoutUnavailable =>
  (LAYOUT_UNAVAILABLE as readonly unknown[]).includes(reason);

async function read(answer: Sent): Promise<PlanResult> {
  if (!answer.ok) {
    // widened: the launch token guard answers before the route does (`../body.ts`)
    const status: number = answer.status;
    if (status === UNAUTHORIZED) return { kind: "unauthorized" };
    const refused = await readBody(() => answer.json() as Promise<{ reason?: unknown }>);
    if (!refused.readable) return { kind: "unreadable-answer" };
    const reason = refused.body.reason;
    // by `reason`, never the status: a stale revision is a 409 as well (#293)
    if (isUnavailable(reason)) return { kind: "unavailable", reason };
    return { kind: "refused", reason: reason as PlanRefusal | undefined };
  }
  const served = await readBody(() => answer.json() as Promise<ServedPlan & { summary?: LayoutSummary }>);
  if (!served.readable) return { kind: "unreadable-answer" };
  const body = served.body;
  return {
    kind: "served",
    attempts: body.attempts,
    attemptWarnings: body.attemptWarnings ?? [],
    planWarnings: body.planWarnings ?? [],
    stateWarnings: body.warnings ?? [],
    version: body.version,
    ...(body.summary === undefined ? {} : { summary: body.summary }),
  };
}

/** Sends one request; only the request failing is the server not being there. */
async function ask(send: () => Promise<Sent>): Promise<PlanResult> {
  let answer: Sent;
  try {
    answer = await send();
  } catch {
    return { kind: "unreachable" };
  }
  return read(answer);
}

/** The Plan: every Attempt, with the Warnings over them. */
export function fetchPlan(client: ApiClient): Promise<PlanResult> {
  return ask(() => client.api.plan.$get());
}

/** A Semester of an Academic Year, as an Attempt names one. */
export type SemesterAt = { academicYear: number; semester: Semester };

/** What a new Attempt is: a Course, where, and its status; a grade when it has one. */
export type NewAttempt = SemesterAt & { courseNumber: string; status: Status; grade?: Grade };

export function addAttempt(client: ApiClient, attempt: NewAttempt, basedOn: PlanVersion): Promise<PlanResult> {
  const request = { json: { ...attempt, basedOn } } as InferRequestType<AddRoute>;
  return ask(() => client.api.plan.attempts.$post(request));
}

/** A change to an Attempt's result: a field left out is left alone, and `grade: null` clears it. */
export type AttemptChange = { status?: Status; grade?: Grade | null };

/**
 * The routes read the Attempt's id with `c.req.param()` and the body through `bodyAs`, so the
 * contract types the path and not the body, as `../timetable/picks.ts` says of its routes. The body
 * is still what the route parses, so it is sent.
 */
const naming = (id: string) => ({ param: { id } });

export function updateAttempt(
  client: ApiClient,
  id: string,
  change: AttemptChange,
  basedOn: PlanVersion,
): Promise<PlanResult> {
  const request = { ...naming(id), json: { ...change, basedOn } } as unknown as InferRequestType<UpdateRoute>;
  return ask(() => client.api.plan.attempts[":id"].$patch(request));
}

export function moveAttempt(client: ApiClient, id: string, to: SemesterAt, basedOn: PlanVersion): Promise<PlanResult> {
  const request = { ...naming(id), json: { ...to, basedOn } } as unknown as InferRequestType<MoveRoute>;
  return ask(() => client.api.plan.attempts[":id"].semester.$put(request));
}

export function removeAttempt(client: ApiClient, id: string, basedOn: PlanVersion): Promise<PlanResult> {
  const request = { ...naming(id), json: { basedOn } } as unknown as InferRequestType<RemoveRoute>;
  return ask(() => client.api.plan.attempts[":id"].$delete(request));
}

/**
 * New Plan from Suggested Layout (#293), from the layout of the student's first Program: planned
 * Attempts for the Courses they do not have yet, one save and one undo step.
 */
export function planFromSuggestedLayout(client: ApiClient, basedOn: PlanVersion): Promise<PlanResult> {
  const request = { json: { basedOn } } as InferRequestType<LayoutRoute>;
  return ask(() => client.api.plan["suggested-layout"].$post(request));
}

/** The Academic Year and Semester the student started in, or `null` when none is chosen. */
export type Cohort = SemesterAt | null;

/**
 * The student's Cohort, or `undefined` when it could not be had. A read the screen shapes its
 * columns by and never edits through: the Cohort is set on the Progress screen (#331).
 */
export async function fetchCohort(client: ApiClient): Promise<Cohort | undefined> {
  let answer: Sent;
  try {
    answer = await client.api.programs.$get();
  } catch {
    return undefined;
  }
  if (!answer.ok) return undefined;
  const served = await readBody(
    () => answer.json() as Promise<Extract<InferResponseType<ProgramsRoute>, { programs: unknown }>>,
  );
  return served.readable ? (served.body.cohort ?? null) : undefined;
}

/** One Course's name and credits, as far as the Workspace knows them. */
export type CourseFacts = InferResponseType<CoursesRoute>["courses"][number];

/** Every Course the Workspace knows, or an empty list when they could not be had. */
export async function fetchCourses(client: ApiClient): Promise<CourseFacts[]> {
  let answer: Sent;
  try {
    answer = await client.api.courses.$get();
  } catch {
    return [];
  }
  if (!answer.ok) return [];
  const served = await readBody(() => answer.json() as Promise<InferResponseType<CoursesRoute>>);
  return served.readable && Array.isArray(served.body.courses) ? served.body.courses : [];
}
