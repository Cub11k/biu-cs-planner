import {
  markRegistered,
  planDiffs,
  planDiffsDigest,
  registrationPreview,
  unmarkRegistered,
  variantAt,
  variantPosition,
  type AttemptId,
  type PlanDiff,
  type State,
  type StateFileVersion,
  type StateFileWarning,
  type VariantRef,
} from "@biu-cs-planner/core";
import { readStateFile, type EditRefusal } from "./edit.ts";
import {
  DEFAULT_STATE_FILE,
  editTimetable,
  variantEditedIn,
  type TimetableRef,
  type TimetableResult,
} from "./picks.ts";
import type { PlanDiffOptions } from "./planDiffs.ts";
import { loadPlanDiffSources, loadPlanDiffSourcesForEdit, planDiffContext } from "./planDiffSources.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Marking the Variant a student registered with (#297): the preview of what "apply all" would do,
 * the mark with or without it, and taking the mark off.
 *
 * Each edit is `core`'s pure function plus a label through `editTimetable`, so marking with "apply
 * all" — the flags, every actionable Plan Diff and the registered statuses — is **one save and one
 * undo step, all or nothing** (ADR-0013), refused whole when the file moved since the page read it.
 * Nothing touches the Plan unless `applyDiffs` says the student accepted (ADR-0008), and unmarking
 * never reverses what a mark did to the Plan: undo is how that is reversed.
 *
 * **"Apply all" applies the list the student read, or nothing** (#355). The revision guard covers
 * the State File, not the Catalog, so the preview carries a digest of its Plan Diffs and the mark
 * carries it back; a list that is not the same when the mark is applied — a crawl landed between
 * the two — is refused as `plan-diff-stale`, exactly as one apply whose Plan Diff is gone is.
 *
 * **The preview and the mark are about the same Variant, by one rule** (#355): the one named,
 * verbatim, or the primary when none is named (`variantEditedIn`), and **a name the file does not
 * hold is refused** as `variant-not-found` by both, never read as the primary by one and as a new
 * Variant by the other. A mark is about one tab the student pressed, so it is never moved onto
 * another; and nothing here creates a Variant, so there is nothing for a missing one to mean.
 */

/** The labels the guarded writer is handed. */
export const REGISTRATION_LABEL = {
  mark: "mark-variant-registered",
  unmark: "unmark-variant-registered",
} as const;

export type RegistrationResult =
  | {
      kind: "served";
      /** The Variant the preview is about, as the Timetable read names it. */
      variantName: string;
      variantPosition: number | undefined;
      /** Every Plan Diff of that Variant; the `not-offered` ones are listed and never applied. */
      planDiffs: PlanDiff[];
      /** The Courses whose Attempt in the Semester "apply all" would set to registered. */
      registers: string[];
      /** The digest of `planDiffs`, which "apply all" has to send back (#355). */
      digest: string;
      /** The revision the preview was read from, and what the mark has to be based on. */
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] }
  /** The file holds no Variant by that name (or no Variant at all), so there is nothing to preview. */
  | VariantNotFound;

/** No Variant by the name asked for: nothing was read about one, and nothing was written. */
export type VariantNotFound = {
  kind: "variant-not-found";
  version: StateFileVersion | undefined;
  warnings: StateFileWarning[];
};

/**
 * Which Variant the preview and the mark are about, or `undefined` when the file holds none by that
 * name: one rule for both (#355).
 */
function registrationTarget(state: State, at: TimetableRef): VariantRef | undefined {
  const target = variantEditedIn(state, at);
  return variantAt(state, target) === undefined ? undefined : target;
}

/** What marking the Variant `at` names with "apply all" would do. Writes nothing. */
export async function readRegistration(workspace: Workspace, at: TimetableRef): Promise<RegistrationResult> {
  const loaded = await readStateFile(workspace, at.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };

  const target = registrationTarget(loaded.state, at);
  if (target === undefined) return { kind: "variant-not-found", version: loaded.version, warnings: loaded.warnings };
  const sources = await loadPlanDiffSources(workspace, at.academicYear, {
    wantRequirements: loaded.state.programs.length > 0,
  });
  const preview = registrationPreview(loaded.state, target, planDiffContext(loaded.state, sources));
  return {
    kind: "served",
    variantName: target.variant,
    variantPosition: variantPosition(loaded.state, target),
    planDiffs: preview.planDiffs,
    registers: preview.registers,
    digest: preview.digest,
    version: loaded.version,
    warnings: loaded.warnings,
  };
}

const uuid = (): AttemptId => globalThis.crypto.randomUUID();

/**
 * The student's answer to the offer: only mark, or apply all — and then the digest of the list they
 * were shown, without which there is nothing to say what "all" was.
 */
export type RegistrationChoice = { applyDiffs: false } | { applyDiffs: true; digest: string };

export type MarkRegisteredResult =
  | TimetableResult
  /** The Plan Diffs are not the list the preview showed; nothing was written (#355). */
  | { kind: "plan-diff-stale"; version: StateFileVersion | undefined; warnings: StateFileWarning[] }
  | VariantNotFound;

/**
 * Marks the Variant `at` names as registered and primary. With `applyDiffs`, in the same edit, every
 * actionable Plan Diff is applied and the Semester's planned Attempts of its Courses become
 * registered; without it the Plan is not touched.
 */
export async function markVariantRegistered(
  workspace: Workspace,
  at: TimetableRef,
  choice: RegistrationChoice,
  options: PlanDiffOptions,
): Promise<MarkRegisteredResult> {
  // the Catalog and the Requirements Files are read only for the offer the student accepted
  const sources = choice.applyDiffs
    ? await loadPlanDiffSourcesForEdit(workspace, at.stateFile ?? DEFAULT_STATE_FILE, at.academicYear, options.basedOn)
    : undefined;
  const newId = options.newId ?? uuid;
  let refusal: "plan-diff-stale" | "variant-not-found" | undefined;
  const result = await editTimetable(
    workspace,
    at,
    {
      label: REGISTRATION_LABEL.mark,
      apply: (state) => {
        const target = registrationTarget(state, at);
        if (target === undefined) {
          refusal = "variant-not-found";
          return state;
        }
        const context = sources === undefined ? { offerings: undefined } : planDiffContext(state, sources);
        // computed on the State the edit is applied to, with the Catalog as it is now
        if (choice.applyDiffs && planDiffsDigest(planDiffs(state, target, context)) !== choice.digest) {
          refusal = "plan-diff-stale";
          return state;
        }
        return markRegistered(state, target, { applyDiffs: choice.applyDiffs, context, newId });
      },
    },
    options,
  );

  if (refusal !== undefined && result.kind === "served") {
    return { kind: refusal, version: result.version, warnings: result.warnings };
  }
  return result;
}

/** Takes the registered mark off the Variant `at` names, and nothing else. */
export async function unmarkVariantRegistered(
  workspace: Workspace,
  at: TimetableRef,
  options: PlanDiffOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    { label: REGISTRATION_LABEL.unmark, apply: (state) => unmarkRegistered(state, variantEditedIn(state, at)) },
    options,
  );
}
