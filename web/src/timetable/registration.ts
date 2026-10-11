/**
 * Telling the API which Variant the student registered with (#297): the preview of what "apply all"
 * would do, the mark — with the student's answer to that offer — and the unmark.
 *
 * The mark and the unmark answer with the Timetable and are read by `ask` in `./picks.ts`, as every
 * Timetable edit is. The preview is a read of its own.
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import { askApi, askFor } from "../body.ts";
import type { ApiClient } from "./offerings.ts";
import {
  ask,
  asRead,
  timetable,
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
      /** The digest of `planDiffs`, which "apply all" sends back so it applies this list or nothing (#355). */
      digest: string;
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
  const preview = await askFor(
    () => client.api.timetable[":year"][":semester"].registration.$get(request),
    (body: ServedPreview): RegistrationPreview | undefined =>
      Array.isArray(body.planDiffs) && Array.isArray(body.registers) && typeof body.digest === "string"
        ? {
            kind: "served",
            variantName: body.variantName,
            planDiffs: body.planDiffs,
            registers: body.registers,
            digest: body.digest,
            version: body.version,
          }
        : undefined,
  );
  return preview ?? { kind: "unavailable" };
}

/**
 * The student's answer to the offer: only mark, or apply all — with the digest of the preview they
 * read, so the server applies that list or refuses (#355).
 */
export type RegistrationChoice = { applyDiffs: false } | { applyDiffs: true; digest: string };

/**
 * Every answer a Timetable edit can have, and two more, each with nothing written: the Plan Diffs
 * are not the list the preview showed (the Catalog moved since), or the file holds no Variant by
 * that name. The page says the first in the stale sentence a single apply uses, and the second as
 * a stale view; it reads the Timetable again after either.
 */
export type MarkAnswer = TimetableResult | { kind: "plan-diff-stale" } | { kind: "variant-not-found" };

const CONFLICT = 409;
const NOT_FOUND = 404;

/**
 * Marks the Variant `variant` and `query.position` name registered and primary. `choice` is the
 * student's answer to the offer, always sent: the server takes no default for it (ADR-0008).
 */
export async function markRegistered(
  client: ApiClient,
  query: TimetableQuery,
  variant: string,
  choice: RegistrationChoice,
  basedOn: StateFileVersion,
): Promise<MarkAnswer> {
  const request = {
    ...asRead(query),
    json: { variant, ...positionOf(query), ...choice, basedOn },
  } as InferRequestType<RegisteredRoutes["$post"]>;
  return askApi(() => client.api.timetable[":year"][":semester"].variants.registered.$post(request), {
    refused: (body, status): MarkAnswer => {
      if (status === CONFLICT || status === NOT_FOUND) {
        if (body.reason === "plan-diff-stale") return { kind: "plan-diff-stale" };
        if (body.reason === "variant-not-found") return { kind: "variant-not-found" };
      }
      return timetable.refused(body, status);
    },
    served: timetable.served,
  });
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
