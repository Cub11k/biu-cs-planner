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

/** What the API would not do, in one word: the reason it sends with a refusal. */
export type StateRefusal = Extract<Answer, { reason: unknown }>["reason"];

/** Why the API would not serve or edit the State File. */
export type StateWarning = Extract<Answer, { reason: unknown }>["warnings"][number];

/**
 * Which revision of the State File a view is, and what a save made on that view has to be
 * based on (docs/design.md, "External edits"). Opaque: the page holds it and hands it back,
 * and nothing here may take it apart or compare it for anything but equality.
 *
 * The page holds it rather than the server keeping it because two views of one plan open side
 * by side is a real way of working — the workflow this app replaces — and a server-side memory
 * of "the bytes I last served" cannot tell the second tab's stale save from the first tab's
 * fresh one. `undefined` is the claim that there is no State File yet.
 */
export type StateFileVersion = ServedTimetable["version"];

/** The guard answers before the route does, so its status is not one of the route's. */
const UNAUTHORIZED = 401;

export type TimetableResult =
  | {
      kind: "served";
      variantName: string;
      picks: GroupPick[];
      clashes: Clash[];
      /** What this view is, so an edit made on it can say what it was based on. */
      version: StateFileVersion;
    }
  /**
   * The API would not touch the State File and said why — the folder is not a Workspace
   * yet, the file could not be read, or the Workspace refused the name. The reason and
   * the Warnings both travel with it: a refusal nobody can act on is not a refusal, and
   * the three ask the student for three different things.
   */
  | { kind: "refused"; reason: StateRefusal | undefined; warnings: StateWarning[] }
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

    const refused = (await answer.json()) as {
      reason?: StateRefusal;
      warnings?: StateWarning[];
    };
    return { kind: "refused", reason: refused.reason, warnings: refused.warnings ?? [] };
  }

  const body = (await answer.json()) as ServedTimetable;
  return {
    kind: "served",
    variantName: body.variantName,
    picks: body.picks,
    clashes: body.clashes,
    version: body.version,
  };
}

/**
 * Sends one request, and reads the answer **outside** the catch: only the request failing
 * is the server not being there. An answer this module then cannot make sense of is a
 * contract problem, and calling it "unreachable" would send the student to look at a
 * server that answered them.
 */
async function ask(
  send: () => Promise<Response & { ok: boolean; status: number }>,
): Promise<TimetableResult> {
  let answer: Response & { ok: boolean; status: number };
  try {
    answer = await send();
  } catch {
    return { kind: "unreachable" };
  }
  return read(answer);
}

/** What the student has picked in this Semester, and the Clashes among those Picks. */
export async function fetchTimetable(
  client: ApiClient,
  query: TimetableQuery,
): Promise<TimetableResult> {
  return ask(() => client.api.timetable[":year"][":semester"].$get(asRead(query)));
}

/**
 * Records a Pick, snapshot and all. Picking a second Group for a Lesson Type already
 * picked replaces the first, which is the server's doing and not this module's.
 *
 * `basedOn` is the revision the view being edited was read from, and it is a parameter rather
 * than something this module remembers: the page decides which view a click was made on, and
 * a module that kept "the last version I saw" would happily save a second tab's click onto a
 * revision the first tab replaced. Leaving it out is not available, because a save that does
 * not say what it was based on is the hole #90 was filed for; `undefined` is the claim that
 * there is no State File yet, and the server refuses it when there is one.
 */
export async function recordPick(
  client: ApiClient,
  query: TimetableQuery,
  pick: GroupPick,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { ...pick, basedOn },
  } as InferRequestType<PickRoute>;
  return ask(() => client.api.timetable[":year"][":semester"].picks.$post(request));
}

/** Removes the Pick filling one Lesson Type of one Offering, guarded as recording one is. */
export async function removePick(
  client: ApiClient,
  query: TimetableQuery,
  slot: PickSlot,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { ...slot, basedOn },
  } as InferRequestType<UnpickRoute>;
  return ask(() => client.api.timetable[":year"][":semester"].picks.$delete(request));
}
