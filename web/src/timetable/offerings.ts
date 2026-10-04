/**
 * Asking the API for one Semester's Offerings — the only place this screen reaches the
 * domain, and it does it through the typed client (docs/design.md, "Architecture").
 *
 * It sits beside the components rather than inside one so that the request, and every
 * answer the API can give, can be tested against a fake fetch.
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import { readBody, type createApiClient } from "../api.ts";
import type { Offering, Semester } from "./catalog.ts";

export type ApiClient = ReturnType<typeof createApiClient>;

type OfferingsRoute = ApiClient["api"]["catalog"][":year"]["offerings"]["$get"];

type Answer = InferResponseType<OfferingsRoute>;

/** The answer that carries the Offerings; the others carry the Warnings or the guard's refusal. */
type ServedCatalog = Extract<Answer, { offerings: unknown }>;

/** Why no Catalog was served. The API sends these with every answer that has none. */
export type CatalogWarning = Extract<Answer, { warnings: unknown }>["warnings"][number];

/** The guard answers before the route does, so its status is not one of the route's. */
const UNAUTHORIZED = 401;

export type OfferingsResult =
  | { kind: "served"; offerings: Offering[] }
  /**
   * The API would not serve a Catalog and said why: no Catalog for the year, a file it
   * could not read, a schema version it does not speak, a Workspace that refused it.
   * The Warnings travel with it, because a refusal nobody can act on is not a refusal.
   */
  | { kind: "refused"; warnings: CatalogWarning[] }
  /** This page has no launch token, so the server will not talk to it (ADR-0004). */
  | { kind: "unauthorized" }
  /**
   * The answer arrived and its body is not one this page can read — Vite's HTML 500 when the
   * server is not running behind the dev proxy, hono's plain-text 404 for a path a newer
   * bundle asks for (`readBody` in ../api.ts). Its own arm and not `refused` with no
   * Warnings, because that is the shape `isAbsence` reads as "this year has no Catalog yet" —
   * an affirmative claim about the student's folder that nothing here knows (#171).
   */
  | { kind: "unreadable-answer" }
  /** The request never arrived: the server is not running, or not running here. */
  | { kind: "unreachable" };

export async function fetchOfferings(
  client: ApiClient,
  query: { academicYear: number; semester: Semester },
): Promise<OfferingsResult> {
  // The route reads `semester` with `c.req.query()` rather than through a validator, so
  // the contract types the path parameter and not the query. The query is still required
  // by the route, so it is sent; typing it in server/src/api.ts would remove this cast.
  const request = {
    param: { year: String(query.academicYear) },
    query: { semester: query.semester },
  } as InferRequestType<OfferingsRoute>;

  let answer: Awaited<ReturnType<OfferingsRoute>>;
  try {
    answer = await client.api.catalog[":year"].offerings.$get(request);
  } catch {
    return { kind: "unreachable" };
  }

  if (!answer.ok) {
    // `status` is widened deliberately: the launch token guard rejects the request before
    // the route runs, so 401 is not among the answers the contract knows about.
    const status: number = answer.status;
    if (status === UNAUTHORIZED) return { kind: "unauthorized" };

    // `Answer` named explicitly, because `json()` on an answer narrowed to `!ok` is a union of
    // signatures and inference off one of them would pick a single arm of the body's type. It is
    // the same union the direct `await answer.json()` gave before, so `"warnings" in body` still
    // tells a Catalog refusal from the guard's `{ error }`.
    const refused = await readBody<Answer>(() => answer.json());
    if (!refused.readable) return { kind: "unreadable-answer" };
    const body = refused.body;
    return { kind: "refused", warnings: "warnings" in body ? body.warnings : [] };
  }

  const served = await readBody<ServedCatalog>(() => answer.json());
  if (!served.readable) return { kind: "unreadable-answer" };
  return { kind: "served", offerings: served.body.offerings };
}
