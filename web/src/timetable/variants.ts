/**
 * Telling the API about the Variant tabs: create, duplicate, rename, delete, make primary (#281).
 *
 * Beside `picks.ts` and read the same way — every one of these answers with the Timetable, so
 * `ask` turns each answer into the one `TimetableResult` the screen already knows how to show.
 * Each takes the revision the view it was made on was read from, for the reason `recordPick`
 * gives: a save that does not say what it was based on is the hole #90 was filed for.
 */
import type { InferRequestType } from "hono/client";
import type { ApiClient } from "./offerings.ts";
import {
  ask,
  asRead,
  positionOf,
  variantOf,
  type StateFileVersion,
  type TimetableQuery,
  type TimetableResult,
} from "./picks.ts";

type VariantRoutes = ApiClient["api"]["timetable"][":year"][":semester"]["variants"];

/** A new, empty Variant. Without a name the server gives it the first free letter. */
export async function createVariant(
  client: ApiClient,
  query: TimetableQuery,
  name: string | undefined,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { ...(name === undefined ? {} : { name }), basedOn },
  } as InferRequestType<VariantRoutes["$post"]>;
  return ask(() => client.api.timetable[":year"][":semester"].variants.$post(request));
}

/** A copy of the Variant `query` names, Picks and all, under the first free letter. */
export async function duplicateVariant(
  client: ApiClient,
  query: TimetableQuery,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { ...variantOf(query), basedOn },
  } as InferRequestType<VariantRoutes["duplicate"]["$post"]>;
  return ask(() => client.api.timetable[":year"][":semester"].variants.duplicate.$post(request));
}

/** The Variant `variant` names — of two that share it, the one at `query.position` — renamed. */
export async function renameVariant(
  client: ApiClient,
  query: TimetableQuery,
  variant: string,
  name: string,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { variant, name, ...positionOf(query), basedOn },
  } as InferRequestType<VariantRoutes["rename"]["$post"]>;
  return ask(() => client.api.timetable[":year"][":semester"].variants.rename.$post(request));
}

/** The Variant `variant` and `query.position` name, made the primary one. */
export async function setPrimaryVariant(
  client: ApiClient,
  query: TimetableQuery,
  variant: string,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { variant, ...positionOf(query), basedOn },
  } as InferRequestType<VariantRoutes["primary"]["$post"]>;
  return ask(() => client.api.timetable[":year"][":semester"].variants.primary.$post(request));
}

/**
 * The Variant `variant` and `query.position` name, deleted. The answer is about the primary that
 * is left.
 */
export async function deleteVariant(
  client: ApiClient,
  query: TimetableQuery,
  variant: string,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { variant, ...positionOf(query), basedOn },
  } as InferRequestType<VariantRoutes["$delete"]>;
  return ask(() => client.api.timetable[":year"][":semester"].variants.$delete(request));
}
