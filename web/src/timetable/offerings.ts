/**
 * Asking the API for one Semester's Offerings — the only place this screen reaches the
 * domain, and it does it through the typed client (docs/design.md, "Architecture").
 *
 * It sits beside the components rather than inside one so that the request, and every
 * answer the API can give, can be tested against a fake fetch.
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import type { createApiClient } from "../api.ts";
import { askApi } from "../body.ts";
import type { Offering, Semester } from "./catalog.ts";

export type ApiClient = ReturnType<typeof createApiClient>;

type OfferingsRoute = ApiClient["api"]["catalog"][":year"]["offerings"]["$get"];

type Answer = InferResponseType<OfferingsRoute>;

/** The answer that carries the Offerings; the others carry the Warnings or the guard's refusal. */
type ServedCatalog = Extract<Answer, { offerings: unknown }>;

/**
 * Why no Catalog was served, when one was looked for: none for the year, or a file that is not a
 * Catalog this build reads. A Workspace that would not touch the file is not one of these (#149).
 */
export type CatalogWarning = Extract<Answer, { warnings: unknown }>["warnings"][number];

export type OfferingsResult =
  | { kind: "served"; offerings: Offering[] }
  /**
   * The API served no Catalog and said why: no Catalog for the year, a file it could not read
   * as one, a schema version it does not speak. Not a refusal (#149): the Catalog was looked
   * for, and the Warnings travel with the answer, because a Warning nobody can read is none.
   */
  | { kind: "not-served"; warnings: CatalogWarning[] }
  /**
   * The Workspace would not touch the Catalog file at all (#149): a refusal, which the API answers
   * apart from the Warnings above, because there was no Catalog for a Warning to be about.
   */
  | { kind: "refused" }
  /** This page has no launch token, so the server will not talk to it (ADR-0004). */
  | { kind: "unauthorized" }
  /**
   * The answer arrived and its body is not one this page can read — Vite's HTML 500 when the
   * server is not running behind the dev proxy, hono's plain-text 404 for a path a newer
   * bundle asks for (`readBody` in ../body.ts). Its own arm and not `not-served` with no
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

  return askApi(() => client.api.catalog[":year"].offerings.$get(request), {
    // `Answer` named whole, so the refusal and the Warnings arm are both in it. Nothing is read
    // off it but `kind` and `"warnings" in body`, and `ServedCatalog` has no `warnings`, so the
    // served arm in the union cannot make this branch claim a Warning that is not there.
    refused: (body: Answer): OfferingsResult => {
      if ("kind" in body && body.kind === "refused") return { kind: "refused" };
      return { kind: "not-served", warnings: "warnings" in body ? body.warnings : [] };
    },
    // the sidebar loops over the Offerings, so an answer without them is not a Catalog (#275)
    served: (body: ServedCatalog): OfferingsResult | undefined =>
      Array.isArray(body.offerings) ? { kind: "served", offerings: body.offerings } : undefined,
  });
}
