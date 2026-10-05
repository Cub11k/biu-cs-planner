import {
  markRegistered,
  registrationPreview,
  unmarkRegistered,
  type AttemptId,
  type PlanDiff,
  type StateFileVersion,
  type StateFileWarning,
} from "@biu-cs-planner/core";
import { readStateFile, type EditRefusal } from "./edit.ts";
import {
  DEFAULT_STATE_FILE,
  editTimetable,
  variantEditedIn,
  variantShownIn,
  type TimetableRef,
  type TimetableResult,
} from "./picks.ts";
import type { PlanDiffOptions } from "./planDiffs.ts";
import { loadPlanDiffSources, planDiffContext } from "./planDiffSources.ts";
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
      /** The revision the preview was read from, and what the mark has to be based on. */
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

/** What marking the Variant `at` names with "apply all" would do. Writes nothing. */
export async function readRegistration(workspace: Workspace, at: TimetableRef): Promise<RegistrationResult> {
  const loaded = await readStateFile(workspace, at.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };

  const shown = variantShownIn(loaded.state, at);
  const sources = await loadPlanDiffSources(workspace, at.academicYear, {
    wantRequirements: loaded.state.programs.length > 0,
  });
  const preview = registrationPreview(loaded.state, shown, planDiffContext(loaded.state, sources));
  return {
    kind: "served",
    variantName: shown.variant,
    variantPosition: shown.position,
    planDiffs: preview.planDiffs,
    registers: preview.registers,
    version: loaded.version,
    warnings: loaded.warnings,
  };
}

const uuid = (): AttemptId => globalThis.crypto.randomUUID();

/**
 * Marks the Variant `at` names as registered and primary. With `applyDiffs`, in the same edit, every
 * actionable Plan Diff is applied and the Semester's planned Attempts of its Courses become
 * registered; without it the Plan is not touched.
 */
export async function markVariantRegistered(
  workspace: Workspace,
  at: TimetableRef,
  choice: { applyDiffs: boolean },
  options: PlanDiffOptions,
): Promise<TimetableResult> {
  // the Catalog and the Requirements Files are read only for the offer the student accepted
  const sources = choice.applyDiffs ? await loadPlanDiffSources(workspace, at.academicYear) : undefined;
  const newId = options.newId ?? uuid;
  return editTimetable(
    workspace,
    at,
    {
      label: REGISTRATION_LABEL.mark,
      apply: (state) =>
        markRegistered(state, variantEditedIn(state, at), {
          applyDiffs: choice.applyDiffs,
          context: sources === undefined ? { offerings: undefined } : planDiffContext(state, sources),
          newId,
        }),
    },
    options,
  );
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
