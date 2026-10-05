import {
  addAttempt,
  attemptWarnings,
  moveAttempt,
  removeAttempt,
  updateAttempt,
  type Attempt,
  type AttemptChange,
  type AttemptFacts,
  type AttemptId,
  type AttemptWarning,
  type SemesterAt,
  type State,
  type StateFileVersion,
  type StateFileWarning,
} from "@biu-cs-planner/core";
import {
  editStateFile,
  readStateFile,
  type EditHistory,
  type EditRefusal,
  type StateEditing,
} from "./edit.ts";
import { DEFAULT_STATE_FILE } from "./picks.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The Plan (#290): the student's Attempts, read in one domain read, and the four edits that make
 * them a plan — add, update, move, remove. The Plan is nothing but these Attempts (ADR-0009).
 *
 * Each edit is `core`'s pure function plus a label through `editStateFile`: one guarded save and
 * one undo step (ADR-0013), refused only when the file changed underneath (#90). Nothing a student
 * enters is refused; what looks wrong comes back as a Warning with the Attempts.
 *
 * **An Attempt is named by its id.** New ids come from `newId`, a UUID unless a caller injects a
 * source, which is what lets a test say which id an add hands out.
 */

export type PlanView = {
  /** Every Attempt, in the order the State File holds them. */
  attempts: Attempt[];
  /** The Warnings over the Attempts that need no Requirements File (`attemptWarnings`). */
  attemptWarnings: AttemptWarning[];
};

export type PlanResult =
  /** `version` is the revision the view was read from, and what an edit has to be based on. */
  | {
      kind: "served";
      view: PlanView;
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

export type PlanReadOptions = {
  /** Defaults to `DEFAULT_STATE_FILE`; a State File is named, never a path. */
  stateFile?: string;
};

export type PlanEditOptions = PlanReadOptions & {
  /** The revision the view being edited was read from; see `EditOptions.basedOn`. */
  basedOn: StateFileVersion | undefined;
  history?: EditHistory;
  /** Where a new Attempt's id comes from. A UUID when nothing says otherwise. */
  newId?: () => AttemptId;
};

const uuid = (): AttemptId => globalThis.crypto.randomUUID();

async function planOf(state: State): Promise<PlanView> {
  return { attempts: state.attempts, attemptWarnings: attemptWarnings(state) };
}

/** The Attempts the State File holds, with their Warnings and the revision they were read from. */
export async function readPlan(workspace: Workspace, options: PlanReadOptions = {}): Promise<PlanResult> {
  const loaded = await readStateFile(workspace, options.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }
  return {
    kind: "served",
    view: await planOf(loaded.state),
    version: loaded.version,
    warnings: loaded.warnings,
  };
}

async function edit(
  workspace: Workspace,
  editing: StateEditing,
  options: PlanEditOptions,
): Promise<PlanResult> {
  const outcome = await editStateFile(workspace, options.stateFile ?? DEFAULT_STATE_FILE, editing, {
    basedOn: options.basedOn,
    ...(options.history ? { history: options.history } : {}),
  });
  if (outcome.kind === "refused") {
    return { kind: "refused", reason: outcome.reason, warnings: outcome.warnings };
  }
  return {
    kind: "served",
    view: await planOf(outcome.state),
    version: outcome.version,
    warnings: outcome.warnings,
  };
}

/**
 * Adds an Attempt: a passed Course with its grade, a planned one, an exemption, a retake. The
 * answer names the new Attempt's id in `added`, beside the Plan as it now stands.
 */
export async function addAttemptTo(
  workspace: Workspace,
  fields: AttemptFacts,
  options: PlanEditOptions,
): Promise<PlanResult & { added?: AttemptId }> {
  const id = (options.newId ?? uuid)();
  const result = await edit(
    workspace,
    { label: "add-attempt", apply: (state) => addAttempt(state, fields, () => id) },
    options,
  );
  return result.kind === "served" ? { ...result, added: id } : result;
}

/** Changes an Attempt's status, its grade, or both; `grade: null` clears the grade. */
export async function updateAttemptOf(
  workspace: Workspace,
  id: AttemptId,
  change: AttemptChange,
  options: PlanEditOptions,
): Promise<PlanResult> {
  return edit(
    workspace,
    { label: "update-attempt", apply: (state) => updateAttempt(state, id, change) },
    options,
  );
}

/** Moves an Attempt to another Semester. */
export async function moveAttemptTo(
  workspace: Workspace,
  id: AttemptId,
  to: SemesterAt,
  options: PlanEditOptions,
): Promise<PlanResult> {
  return edit(
    workspace,
    { label: "move-attempt", apply: (state) => moveAttempt(state, id, to) },
    options,
  );
}

/** Removes an Attempt. */
export async function removeAttemptFrom(
  workspace: Workspace,
  id: AttemptId,
  options: PlanEditOptions,
): Promise<PlanResult> {
  return edit(
    workspace,
    { label: "remove-attempt", apply: (state) => removeAttempt(state, id) },
    options,
  );
}
