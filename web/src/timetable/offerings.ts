/**
 * Asking the API for one Semester's Offerings — the only place this screen reaches the
 * domain, and it does it through the typed client (docs/design.md, "Architecture").
 *
 * It sits beside the components rather than inside one so that the request, and every
 * answer the API can give, can be tested against a fake fetch.
 */
import type { InferRequestType } from "hono/client";
import type { createApiClient } from "../api.ts";
import type { Offering, Semester } from "./catalog.ts";

export type ApiClient = ReturnType<typeof createApiClient>;

type OfferingsRoute = ApiClient["api"]["catalog"][":year"]["offerings"]["$get"];

export type OfferingsResult =
  | { kind: "served"; offerings: Offering[] }
  /** No Catalog for this Academic Year yet, or the Workspace would not read the file. */
  | { kind: "missing" }
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

  // Every other answer carries Warnings and no Catalog, which this screen has nowhere to
  // show yet; it says only that there is nothing to lay out.
  if (!answer.ok) return { kind: "missing" };

  const body = await answer.json();
  return { kind: "served", offerings: body.offerings };
}
