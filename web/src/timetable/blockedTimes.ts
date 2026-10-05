/**
 * Telling the API about Blocked Times (#282): add, replace, remove, and copy a Semester's to
 * another Semester.
 *
 * Read the way every Timetable edit is read (`ask` in `./picks.ts`) and guarded the way every one
 * is. A Blocked Time is named by its position in the list the view on screen carries, which the
 * revision guard makes safe: the server refuses the save if the file moved since that view.
 */
import type { InferRequestType } from "hono/client";
import type { Day, Semester } from "./catalog.ts";
import type { ApiClient } from "./offerings.ts";
import {
  ask,
  asRead,
  variantOf,
  type StateFileVersion,
  type TimetableQuery,
  type TimetableResult,
} from "./picks.ts";

type BlockedRoute = ApiClient["api"]["timetable"][":year"][":semester"]["blocked-times"];

/** A Blocked Time as the student typed it. A range ending before it starts wraps past midnight. */
export type BlockedRange = { day: Day; start: string; end: string; label: string };

export async function addBlockedTime(
  client: ApiClient,
  query: TimetableQuery,
  range: BlockedRange,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { ...range, ...variantOf(query), basedOn },
  } as InferRequestType<BlockedRoute["$post"]>;
  return ask(() => client.api.timetable[":year"][":semester"]["blocked-times"].$post(request));
}

export async function replaceBlockedTime(
  client: ApiClient,
  query: TimetableQuery,
  index: number,
  range: BlockedRange,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { ...range, index, ...variantOf(query), basedOn },
  } as InferRequestType<BlockedRoute["$put"]>;
  return ask(() => client.api.timetable[":year"][":semester"]["blocked-times"].$put(request));
}

export async function removeBlockedTime(
  client: ApiClient,
  query: TimetableQuery,
  index: number,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { index, ...variantOf(query), basedOn },
  } as InferRequestType<BlockedRoute["$delete"]>;
  return ask(() => client.api.timetable[":year"][":semester"]["blocked-times"].$delete(request));
}

/** Copies every Blocked Time of the Semester shown to another Semester, adding to its own. */
export async function copyBlockedTimes(
  client: ApiClient,
  query: TimetableQuery,
  to: { academicYear: number; semester: Semester },
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { toYear: to.academicYear, toSemester: to.semester, ...variantOf(query), basedOn },
  } as InferRequestType<BlockedRoute["copy"]["$post"]>;
  return ask(() => client.api.timetable[":year"][":semester"]["blocked-times"].copy.$post(request));
}
