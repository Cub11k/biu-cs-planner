import type { AttemptId, State } from "../state/schema.ts";
import { updateAttempt } from "../state/attempts.ts";
import { variantAt, type VariantRef } from "../state/picks.ts";
import { clearRegisteredVariant, setRegisteredVariant } from "../state/variants.ts";
import { applyPlanDiff, canonicalizer, isActionable, planDiffs, type PlanDiff, type PlanDiffContext } from "./diffs.ts";

/**
 * Marking a Variant as the one the student registered with (#297), and the offer that comes with
 * it: apply every Plan Diff of that Variant at once, and say in the Plan what was registered for.
 * Nothing touches the Plan without the student accepting that offer (ADR-0008).
 */

export type MarkRegisteredOptions = {
  /** Whether to bring the Plan along: every actionable Plan Diff, then registered statuses. */
  applyDiffs: boolean;
  context: PlanDiffContext;
  newId: () => AttemptId;
};

/**
 * Marks a Variant as the one the student registered with (#297): registered and primary, both
 * cleared on its siblings (`setRegisteredVariant`).
 *
 * With `applyDiffs`, in the same edit, it applies every actionable Plan Diff of that Variant and
 * then sets to registered each planned Attempt in the Semester of a Course the Variant holds — the
 * Plan saying what the student registered for. A `not-offered` Course is left exactly as it was.
 * Without it the Plan is not touched. One `state -> state` function, so it is one save and one
 * undo step, all or nothing (ADR-0013).
 */
export function markRegistered(state: State, at: VariantRef, options: MarkRegisteredOptions): State {
  const marked = setRegisteredVariant(state, at);
  if (!options.applyDiffs) return marked;

  const diffs = planDiffs(marked, at, options.context);
  const applied = diffs.filter(isActionable).reduce((next, diff) => applyPlanDiff(next, diff, options.newId), marked);

  const canonical = canonicalizer(options.context.equivalences ?? []);
  const variant = variantAt(applied, at);
  const held = new Set(
    [...(variant?.tray ?? []), ...(variant?.picks.map((pick) => pick.courseNumber) ?? [])].map(canonical),
  );
  const untouched = new Set(diffs.flatMap((diff) => (diff.kind === "not-offered" ? diff.attemptIds : [])));

  return applied.attempts
    .filter(
      (attempt) =>
        attempt.status === "planned" &&
        attempt.academicYear === at.academicYear &&
        attempt.semester === at.semester &&
        !untouched.has(attempt.id) &&
        held.has(canonical(attempt.courseNumber)),
    )
    .reduce((next, attempt) => updateAttempt(next, attempt.id, { status: "registered" }), applied);
}

/** Takes the registered mark off a Variant and touches nothing else (`clearRegisteredVariant`). */
export const unmarkRegistered = clearRegisteredVariant;

/** What marking a Variant registered with "apply all" would do, for the student to see first. */
export type RegistrationPreview = {
  /** Every Plan Diff of the Variant, `not-offered` among them, listed and never applied. */
  planDiffs: PlanDiff[];
  /** The Courses whose Attempt in the Semester would become registered, in Plan order. */
  registers: string[];
};

/**
 * What `markRegistered` with `applyDiffs` would do to this State, computed by doing it and
 * comparing: the Plan Diffs it applies, and the Attempts it sets to registered — the ones it adds
 * included, which have no id until it runs.
 */
export function registrationPreview(state: State, at: VariantRef, context: PlanDiffContext): RegistrationPreview {
  const diffs = planDiffs(state, at, context);
  let made = 0;
  const after = markRegistered(state, at, { applyDiffs: true, context, newId: () => `preview-${made++}` });
  const before = new Map(state.attempts.map((attempt) => [attempt.id, attempt.status]));
  return {
    planDiffs: diffs,
    registers: after.attempts
      .filter((attempt) => attempt.status === "registered" && before.get(attempt.id) !== "registered")
      .map((attempt) => attempt.courseNumber),
  };
}
