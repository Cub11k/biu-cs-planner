import {
  addAttempt,
  attemptWarnings,
  checkPlan,
  effectiveFile,
  moveAttempt,
  removeAttempt,
  updateAttempt,
  type Attempt,
  type AttemptChange,
  type AttemptFacts,
  type AttemptId,
  type AttemptWarning,
  type PlanProgram,
  type PlanWarning,
  type SemesterAt,
  type SolvePin,
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
import { loadRequirementsFiles } from "./requirements.ts";
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
 *
 * **Every answer carries the Plan checks** (#291): `checkPlan` against the Requirements Files of
 * the student's chosen Programs, recomputed from the State File and `requirements/` on every read
 * and never stored. A Program whose file the Workspace does not hold, or cannot read, is left out
 * of them; the Programs route is where that is said (`./programs.ts`). The missing-Requirements
 * lens runs the solver, so it is given a clock (`now`) for its time cap, as Progress is.
 */

export type PlanView = {
  /** Every Attempt, in the order the State File holds them. */
  attempts: Attempt[];
  /** The Warnings over the Attempts that need no Requirements File (`attemptWarnings`). */
  attemptWarnings: AttemptWarning[];
  /** The Plan checks against the chosen Programs' Requirements Files (`checkPlan`). */
  planWarnings: PlanWarning[];
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
  /** The clock the solver's time cap is measured by. `Date.now` when nothing says otherwise. */
  now?: () => number;
};

export type PlanEditOptions = PlanReadOptions & {
  /** The revision the view being edited was read from; see `EditOptions.basedOn`. */
  basedOn: StateFileVersion | undefined;
  history?: EditHistory;
  /** Where a new Attempt's id comes from. A UUID when nothing says otherwise. */
  newId?: () => AttemptId;
};

const uuid = (): AttemptId => globalThis.crypto.randomUUID();

/** The chosen Programs whose Requirements File the Workspace holds and could read, in order. */
async function programsOf(workspace: Workspace, state: State): Promise<PlanProgram[]> {
  if (state.programs.length === 0) return [];
  const loaded = await loadRequirementsFiles(workspace);
  if (loaded.kind === "refused") return [];
  return state.programs.flatMap((choice): PlanProgram[] => {
    const file = loaded.files.find((entry) => entry.listed.name === choice.requirementsFile)?.file;
    if (file === undefined) return [];
    const ticked = state.manualTicks
      .filter((tick) => effectiveFile(state, tick) === choice.requirementsFile)
      .map((tick) => tick.requirementId);
    return [
      {
        requirementsFile: choice.requirementsFile,
        file,
        ...(choice.track === undefined ? {} : { track: choice.track }),
        ticked,
      },
    ];
  });
}

/** The State's Pins as the solver takes them: each in the Program whose file it names. */
function pinsFor(state: State, programs: readonly PlanProgram[]): SolvePin[] {
  return state.pins.flatMap((pin) => {
    const file = effectiveFile(state, pin);
    const index = programs.findIndex((program) => program.requirementsFile === file);
    return index < 0 ? [] : [{ courseNumber: pin.courseNumber, requirementId: pin.requirementId, program: index }];
  });
}

async function planOf(workspace: Workspace, state: State, now: () => number): Promise<PlanView> {
  const programs = await programsOf(workspace, state);
  return {
    attempts: state.attempts,
    attemptWarnings: attemptWarnings(state),
    planWarnings: checkPlan({
      attempts: state.attempts,
      programs,
      ...(state.cohort === undefined ? {} : { cohort: state.cohort }),
      creditLoadLimit: state.settings.creditLoadLimit,
      pins: pinsFor(state, programs),
      limits: { now },
    }),
  };
}

/** The Attempts the State File holds, with their Warnings and the revision they were read from. */
export async function readPlan(workspace: Workspace, options: PlanReadOptions = {}): Promise<PlanResult> {
  const loaded = await readStateFile(workspace, options.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }
  return {
    kind: "served",
    view: await planOf(workspace, loaded.state, options.now ?? Date.now),
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
    view: await planOf(workspace, outcome.state, options.now ?? Date.now),
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
