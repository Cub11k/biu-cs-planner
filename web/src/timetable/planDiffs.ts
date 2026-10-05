/**
 * Telling the API to apply one Plan Diff to the Plan (#296; ADR-0008). The Plan Diffs themselves
 * arrive with every Timetable answer (`planDiffs` in `./picks.ts`); this sends one back by its kind
 * and Course, guarded by the revision the view was read from as every Timetable edit is, and the
 * answer is the Timetable afterwards.
 */
import type { InferRequestType } from "hono/client";
import { readBody } from "../body.ts";
import type { ApiClient } from "./offerings.ts";
import {
  ask,
  asRead,
  variantOf,
  type PlanDiff,
  type StateFileVersion,
  type TimetableQuery,
  type TimetableResult,
} from "./picks.ts";

type ApplyRoute = ApiClient["api"]["timetable"][":year"][":semester"]["plan-diffs"]["apply"]["$post"];

/**
 * A Plan Diff that has an "apply to Plan": every kind but `not-offered`, and every `move` but one
 * whose target Semester already holds the Course (#355), which is reported with nothing to apply.
 */
export type ActionablePlanDiff = Exclude<PlanDiff, { kind: "not-offered" } | { targetHolds: true }>;

export const isActionable = (diff: PlanDiff): diff is ActionablePlanDiff =>
  diff.kind !== "not-offered" && !(diff.kind === "move" && diff.targetHolds === true);

const CONFLICT = 409;

/**
 * Every answer a Timetable edit can have, and one more: the file as it stands has no such Plan Diff
 * any more — the Plan or the Catalog moved since the page read it — so nothing was written. Its own
 * arm, because the page says so in a sentence of its own and reads the Timetable again.
 */
export type PlanDiffAnswer = TimetableResult | { kind: "plan-diff-stale" };

/** Applies one Plan Diff of the Variant `query` names to the Plan. */
export async function applyPlanDiff(
  client: ApiClient,
  query: TimetableQuery,
  diff: ActionablePlanDiff,
  basedOn: StateFileVersion,
): Promise<PlanDiffAnswer> {
  const request = {
    ...asRead(query),
    json: { ...variantOf(query), kind: diff.kind, courseNumber: diff.courseNumber, basedOn },
  } as InferRequestType<ApplyRoute>;
  let answer: Response & { ok: boolean; status: number };
  try {
    answer = await client.api.timetable[":year"][":semester"]["plan-diffs"].apply.$post(request);
  } catch {
    return { kind: "unreachable" };
  }
  if (answer.status === CONFLICT) {
    // read off a copy, so every other refusal is still read by the one reader the screen knows
    const peek = await readBody(() => answer.clone().json() as Promise<{ reason?: unknown }>);
    if (peek.readable && peek.body.reason === "plan-diff-stale") return { kind: "plan-diff-stale" };
  }
  return ask(() => Promise.resolve(answer));
}
