/**
 * Telling the API which Variant the student registered with (#297): the preview of what "apply all"
 * would do, the mark — with the student's answer to that offer — and the unmark.
 *
 * The mark and the unmark answer with the Timetable and are read by `ask` in `./picks.ts`, as every
 * Timetable edit is. The preview is a read of its own.
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import { readBody } from "../body.ts";
import type { ApiClient } from "./offerings.ts";
import {
  ask,
  asRead,
  positionOf,
  type PlanDiff,
  type StateFileVersion,
  type TimetableQuery,
  type TimetableResult,
} from "./picks.ts";

type TimetableRoutes = ApiClient["api"]["timetable"][":year"][":semester"];
type PreviewRoute = TimetableRoutes["registration"]["$get"];
type RegisteredRoutes = TimetableRoutes["variants"]["registered"];

type ServedPreview = Extract<InferResponseType<PreviewRoute>, { registers: unknown }>;

export type RegistrationPreview =
  | {
      kind: "served";
      /** The Variant the preview is about. */
      variantName: string;
      /** Every Plan Diff of it; `not-offered` ones are listed and never applied. */
      planDiffs: PlanDiff[];
      /** The Courses whose Attempt "apply all" would set to registered. */
      registers: string[];
      /** The revision the preview was read from: what the mark is based on. */
      version: StateFileVersion;
    }
  /** Anything but a preview: the page offers only marking, and says why. */
  | { kind: "unavailable" };

/** What marking the Variant `query` names with "apply all" would do. Writes nothing. */
export async function fetchRegistration(client: ApiClient, query: TimetableQuery): Promise<RegistrationPreview> {
  const request = {
    ...asRead(query),
    ...(query.variant === undefined
      ? {}
      : {
          query: {
            variant: query.variant,
            ...(query.position === undefined ? {} : { position: String(query.position) }),
          },
        }),
  } as InferRequestType<PreviewRoute>;
  let answer: Response & { ok: boolean };
  try {
    answer = await client.api.timetable[":year"][":semester"].registration.$get(request);
  } catch {
    return { kind: "unavailable" };
  }
  if (!answer.ok) return { kind: "unavailable" };
  const served = await readBody(() => answer.json() as Promise<ServedPreview>);
  if (!served.readable || !Array.isArray(served.body.planDiffs) || !Array.isArray(served.body.registers)) {
    return { kind: "unavailable" };
  }
  return {
    kind: "served",
    variantName: served.body.variantName,
    planDiffs: served.body.planDiffs,
    registers: served.body.registers,
    version: served.body.version,
  };
}

/**
 * Marks the Variant `variant` and `query.position` name registered and primary. `applyDiffs` is the
 * student's answer to the offer, always sent: the server takes no default for it (ADR-0008).
 */
export async function markRegistered(
  client: ApiClient,
  query: TimetableQuery,
  variant: string,
  applyDiffs: boolean,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { variant, ...positionOf(query), applyDiffs, basedOn },
  } as InferRequestType<RegisteredRoutes["$post"]>;
  return ask(() => client.api.timetable[":year"][":semester"].variants.registered.$post(request));
}

/** Takes the registered mark off the Variant `variant` and `query.position` name, and nothing else. */
export async function unmarkRegistered(
  client: ApiClient,
  query: TimetableQuery,
  variant: string,
  basedOn: StateFileVersion,
): Promise<TimetableResult> {
  const request = {
    ...asRead(query),
    json: { variant, ...positionOf(query), basedOn },
  } as InferRequestType<RegisteredRoutes["$delete"]>;
  return ask(() => client.api.timetable[":year"][":semester"].variants.registered.$delete(request));
}
