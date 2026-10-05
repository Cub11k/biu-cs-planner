/**
 * Telling the API about the Tray (#283): a Course added to the Variant shown, and one taken out
 * — with its Picks there, which is the server's doing and one undo step.
 *
 * Read the way every Timetable edit is read (`ask` in `./picks.ts`), and guarded the way every
 * one is: the revision the view was read from travels with the request.
 */
import type { InferRequestType } from "hono/client";
import type { ApiClient } from "./offerings.ts";
import {
  ask,
  asRead,
  variantOf,
  type StateFileVersion,
  type TimetableQuery,
  type TimetableResult,
} from "./picks.ts";

type TrayRoute = ApiClient["api"]["timetable"][":year"][":semester"]["tray"];

/** Adds a Course to the Tray of the Variant `query` names. */
export async function addToTray(
  client: ApiClient,
  query: TimetableQuery,
  courseNumber: string,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { ...variantOf(query), courseNumber, basedOn },
  } as InferRequestType<TrayRoute["$post"]>;
  return ask(() => client.api.timetable[":year"][":semester"].tray.$post(request));
}

/** Takes a Course out of the Tray of the Variant `query` names, with its Picks there. */
export async function removeFromTray(
  client: ApiClient,
  query: TimetableQuery,
  courseNumber: string,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { ...variantOf(query), courseNumber, basedOn },
  } as InferRequestType<TrayRoute["$delete"]>;
  return ask(() => client.api.timetable[":year"][":semester"].tray.$delete(request));
}
