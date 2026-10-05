import {
  applyPlanDiff,
  findPlanDiff,
  isActionable,
  planDiffs,
  type AttemptId,
  type PlanDiffKey,
  type StateFileVersion,
  type StateFileWarning,
} from "@biu-cs-planner/core";
import {
  DEFAULT_STATE_FILE,
  editTimetable,
  variantEditedIn,
  type PickOptions,
  type TimetableRef,
  type TimetableResult,
} from "./picks.ts";
import { loadPlanDiffSourcesForEdit, planDiffContext } from "./planDiffSources.ts";
import type { Workspace } from "./workspace.ts";

/**
 * "Apply to Plan" for one Plan Diff (#295; ADR-0008): the use case behind the click on a Tray badge
 * or a side-panel entry.
 *
 * `core`'s pure edit plus a label, through `editTimetable` and so `editStateFile` — one guarded save
 * and one undo step — and it changes only the Plan's Attempts. The answer is the Timetable
 * afterwards, as every Timetable edit's is, so the Tray and the Plan Diffs left are on screen in the
 * same answer.
 *
 * **The Plan Diff is named by its kind and Course** (`PlanDiffKey`) and found again on the State the
 * edit is applied to, inside the guarded writer: an apply never trusts a description of the Plan the
 * page held. One that is no longer there — the Catalog changed, or the page sent a key it never
 * read — is refused as `plan-diff-stale` and writes nothing. A refusal and not a Warning, because
 * there is nothing to apply.
 */

/** The label an apply hands the guarded writer, which names the kind of Plan Diff it applied. */
export const APPLY_PLAN_DIFF_LABEL = {
  add: "apply-plan-diff-add",
  "move-here": "apply-plan-diff-move-here",
  drop: "apply-plan-diff-drop",
  move: "apply-plan-diff-move",
} as const;

/**
 * The kinds that have an "apply to Plan": every kind but `not-offered`. A `move` whose target already
 * holds the Course has none either, and an apply naming one is refused as stale like any other key
 * the file does not have an actionable Plan Diff for.
 */
export type ActionableKind = keyof typeof APPLY_PLAN_DIFF_LABEL;

export type PlanDiffOptions = PickOptions & {
  /** Where a new Attempt's id comes from. A UUID when nothing says otherwise. */
  newId?: () => AttemptId;
};

export type ApplyPlanDiffResult =
  | TimetableResult
  /** No such Plan Diff on the file as it stands; nothing was written. `version` is still the file's. */
  | { kind: "plan-diff-stale"; version: StateFileVersion | undefined; warnings: StateFileWarning[] };

const uuid = (): AttemptId => globalThis.crypto.randomUUID();

/** Applies the Plan Diff `key` names, of the Variant `at` names, to the Plan. */
export async function applyPlanDiffTo(
  workspace: Workspace,
  at: TimetableRef,
  key: PlanDiffKey & { kind: ActionableKind },
  options: PlanDiffOptions,
): Promise<ApplyPlanDiffResult> {
  const sources = await loadPlanDiffSourcesForEdit(
    workspace,
    at.stateFile ?? DEFAULT_STATE_FILE,
    at.academicYear,
    options.basedOn,
  );
  const newId = options.newId ?? uuid;
  let stale = false;

  const result = await editTimetable(
    workspace,
    at,
    {
      label: APPLY_PLAN_DIFF_LABEL[key.kind],
      apply: (state) => {
        const shown = variantEditedIn(state, at);
        const diff = findPlanDiff(planDiffs(state, shown, planDiffContext(state, sources)), key);
        if (diff === undefined || !isActionable(diff)) {
          stale = true;
          return state;
        }
        return applyPlanDiff(state, diff, newId);
      },
    },
    options,
  );

  if (stale && result.kind === "served") {
    return { kind: "plan-diff-stale", version: result.version, warnings: result.warnings };
  }
  return result;
}
