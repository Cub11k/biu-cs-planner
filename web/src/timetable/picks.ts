/**
 * Asking the API for one Semester's Picks, and telling it about a new one.
 *
 * Beside the components rather than inside one, for the same reason `offerings.ts` is:
 * the request and every answer the API can give are testable against a fake fetch. `web`
 * reaches the domain through the typed client and through nothing else, so the shapes
 * below are read off the contract and never redeclared here (docs/design.md,
 * "Architecture").
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import type { ApiClient } from "./offerings.ts";
import type { Semester } from "./catalog.ts";

type TimetableRoutes = ApiClient["api"]["timetable"][":year"][":semester"];
type ReadRoute = TimetableRoutes["$get"];
type PickRoute = TimetableRoutes["picks"]["$post"];
type UnpickRoute = TimetableRoutes["picks"]["$delete"];

type Answer = InferResponseType<ReadRoute>;

/** The answer that carries Picks; the other carries the Warnings and no Variant. */
type ServedTimetable = Extract<Answer, { picks: unknown }>;

/**
 * A Pick as the API hands it over. `GroupPick` and not `Pick`, because a type named `Pick`
 * shadows TypeScript's built-in `Pick<T, K>` for everything that imports it — the term is
 * still Pick everywhere else (CONTEXT.md).
 */
export type GroupPick = ServedTimetable["picks"][number];

/** A Clash the API found among the Picks: a Warning, never a refusal. */
export type Clash = ServedTimetable["clashes"][number];

/** What one Pick occupies: one Lesson Type of one Offering. */
export type PickSlot = { courseNumber: string; lessonType: string };

/** Why the API would not serve or edit the State File. */
export type StateWarning = Extract<Answer, { reason: unknown }>["warnings"][number];

/** The guard answers before the route does, so its status is not one of the route's. */
const UNAUTHORIZED = 401;

export type TimetableResult =
  | { kind: "served"; variantName: string; picks: GroupPick[]; clashes: Clash[] }
  /**
   * The API would not touch the State File and said why — it could not read it, or the
   * Workspace refused the name. The Warnings travel with it: a refusal nobody can act on
   * is not a refusal.
   */
  | { kind: "refused"; warnings: StateWarning[] }
  /** This page has no launch token, so the server will not talk to it (ADR-0004). */
  | { kind: "unauthorized" }
  /** The request never arrived: the server is not running, or not running here. */
  | { kind: "unreachable" };

export type TimetableQuery = { academicYear: number; semester: Semester };

/**
 * The routes read their parameters with `c.req.param()` rather than through a validator,
 * so the contract types the path and not the body. The body is still what the route parses,
 * so it is sent; typing it in server/src/api.ts would remove these casts, exactly as
 * `offerings.ts` says of its query.
 */
const asRead = (query: TimetableQuery): InferRequestType<ReadRoute> =>
  ({
    param: { year: String(query.academicYear), semester: query.semester },
  }) as InferRequestType<ReadRoute>;

/** Every answer read the same way, so one place decides what each status means. */
async function read(
  answer: Response & { ok: boolean; status: number },
): Promise<TimetableResult> {
  if (!answer.ok) {
    // `status` is widened deliberately: the launch token guard rejects the request before
    // the route runs, so 401 is not among the answers the contract knows about.
    const status: number = answer.status;
    if (status === UNAUTHORIZED) return { kind: "unauthorized" };

    const refused = (await answer.json()) as { warnings?: StateWarning[] };
    return { kind: "refused", warnings: refused.warnings ?? [] };
  }

  const body = (await answer.json()) as ServedTimetable;
  return {
    kind: "served",
    variantName: body.variantName,
    picks: body.picks,
    clashes: body.clashes,
  };
}

/** What the student has picked in this Semester, and the Clashes among those Picks. */
export async function fetchTimetable(
  client: ApiClient,
  query: TimetableQuery,
): Promise<TimetableResult> {
  try {
    return await read(await client.api.timetable[":year"][":semester"].$get(asRead(query)));
  } catch {
    return { kind: "unreachable" };
  }
}

/**
 * Records a Pick, snapshot and all. Picking a second Group for a Lesson Type already
 * picked replaces the first, which is the server's doing and not this module's.
 */
export async function recordPick(
  client: ApiClient,
  query: TimetableQuery,
  pick: GroupPick,
): Promise<TimetableResult> {
  const request = { ...asRead(query), json: pick } as InferRequestType<PickRoute>;
  try {
    return await read(await client.api.timetable[":year"][":semester"].picks.$post(request));
  } catch {
    return { kind: "unreachable" };
  }
}

/** Removes the Pick filling one Lesson Type of one Offering. */
export async function removePick(
  client: ApiClient,
  query: TimetableQuery,
  slot: PickSlot,
): Promise<TimetableResult> {
  const request = { ...asRead(query), json: slot } as InferRequestType<UnpickRoute>;
  try {
    return await read(await client.api.timetable[":year"][":semester"].picks.$delete(request));
  } catch {
    return { kind: "unreachable" };
  }
}
