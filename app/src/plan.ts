import {
  addAttempt,
  attemptWarnings,
  checkPlan,
  effectiveFile,
  fromSuggestedLayout,
  suggestedLayoutOf,
  moveAttempt,
  removeAttempt,
  semesterCredits,
  updateAttempt,
  type Attempt,
  type AttemptChange,
  type AttemptFacts,
  type AttemptId,
  type AttemptWarning,
  type LayoutSummary,
  type PlanProgram,
  type PlanWarning,
  type SemesterAt,
  type SemesterCredits,
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
import { requirementsFiles, type ProgramsWarning } from "./programs.ts";
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
 * of them; the Programs route is where that is said (`./programs.ts`), and the Plan answer marks only
 * a `requirements/` that could not be listed at all (#357). The missing-Requirements
 * lens runs the solver, so it is given a clock (`now`) for its time cap, as Progress is. Beside them,
 * each Semester's credit total from the same Programs (#352), so no screen adds credits up itself.
 */

export type PlanView = {
  /** Every Attempt, in the order the State File holds them. */
  attempts: Attempt[];
  /** The Warnings over the Attempts that need no Requirements File (`attemptWarnings`). */
  attemptWarnings: AttemptWarning[];
  /** The Plan checks against the chosen Programs' Requirements Files (`checkPlan`). */
  planWarnings: PlanWarning[];
  /**
   * What each Semester adds up to in credits, against the same Programs (`semesterCredits`, #352):
   * the totals the credit-load check judges, so the screen shows the number its Warning is about.
   * A Semester holding no counted Attempt is not listed.
   */
  semesterCredits: SemesterCredits[];
  /**
   * `requirements-unlisted` when the student has a Program and `requirements/` could not be listed
   * — after a landed save, a read that failed in any way (#344) — so the checks and totals above ran
   * against no Program, and the page can say so. The marker the Programs and Progress answers carry
   * (`./programs.ts`), and only it: which single file is missing or unreadable is the Programs
   * route's to say (#357).
   */
  programWarnings: Extract<ProgramsWarning, { kind: "requirements-unlisted" }>[];
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

/**
 * The chosen Programs whose Requirements File the Workspace holds and could read, in order — and
 * whether `requirements/` could not be listed at all, which leaves every Program out and is said
 * rather than passed off as a Plan with nothing to check (#357).
 */
async function programsOf(
  workspace: Workspace,
  state: State,
  afterSave: boolean,
): Promise<{ programs: PlanProgram[]; unlisted: boolean }> {
  if (state.programs.length === 0) return { programs: [], unlisted: false };
  // after a landed save a failed read is a listing that would not be made, never a 500 (#344)
  const loaded = await requirementsFiles(workspace, afterSave);
  if (loaded.kind === "refused") return { programs: [], unlisted: true };
  const programs = state.programs.flatMap((choice): PlanProgram[] => {
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
  return { programs, unlisted: false };
}

/** The State's Pins as the solver takes them: each in the Program whose file it names. */
function pinsFor(state: State, programs: readonly PlanProgram[]): SolvePin[] {
  return state.pins.flatMap((pin) => {
    const file = effectiveFile(state, pin);
    const index = programs.findIndex((program) => program.requirementsFile === file);
    return index < 0 ? [] : [{ courseNumber: pin.courseNumber, requirementId: pin.requirementId, program: index }];
  });
}

async function planOf(workspace: Workspace, state: State, now: () => number, afterSave = false): Promise<PlanView> {
  const { programs, unlisted } = await programsOf(workspace, state, afterSave);
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
    semesterCredits: semesterCredits({ attempts: state.attempts, programs }),
    programWarnings: unlisted ? [{ kind: "requirements-unlisted" }] : [],
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
    view: await planOf(workspace, outcome.state, options.now ?? Date.now, true),
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

/**
 * Why New Plan from Suggested Layout made nothing, and what it needs instead (#293). It never
 * guesses: no Cohort means no Semester to place a study year in, and no Program means no layout.
 *
 * - `cohort-not-chosen`: the State File has no Cohort.
 * - `program-not-chosen`: the student has no Program, or the one asked for is not among theirs.
 * - `requirements-file-unavailable`: the Workspace does not hold that Program's file, or cannot read it.
 * - `no-suggested-layout`: the file, with the student's Track, has no Suggested Layout.
 */
export type LayoutUnavailable =
  | "cohort-not-chosen"
  | "program-not-chosen"
  | "requirements-file-unavailable"
  | "no-suggested-layout";

export type LayoutResult =
  | (Extract<PlanResult, { kind: "served" }> & { summary: LayoutSummary })
  | { kind: "unavailable"; reason: LayoutUnavailable; version: StateFileVersion | undefined }
  | Extract<PlanResult, { kind: "refused" }>;

/**
 * New Plan from Suggested Layout (#293): planned Attempts for every Course of the layout of one of
 * the student's Programs — the one `requirementsFile` names, or the first — placed relative to their
 * Cohort, skipping every Course they already have an Attempt of. One guarded save and **one undo
 * step**, which removes everything it created; a run that creates nothing writes nothing.
 *
 * What it needs is decided on the State the edit is applied to, inside the guarded writer, so a
 * Cohort chosen in another tab a moment ago is the Cohort used — or the edit is refused as based on
 * a revision the file no longer holds.
 */
export async function planFromSuggestedLayout(
  workspace: Workspace,
  choice: { requirementsFile?: string | undefined },
  options: PlanEditOptions,
): Promise<LayoutResult> {
  const loaded = await loadRequirementsFiles(workspace);
  const newId = options.newId ?? uuid;
  let unavailable: LayoutUnavailable | undefined;
  let summary: LayoutSummary = { created: [], skipped: [] };

  const outcome = await editStateFile(
    workspace,
    options.stateFile ?? DEFAULT_STATE_FILE,
    {
      label: "plan-from-suggested-layout",
      apply: (state) => {
        const program =
          choice.requirementsFile === undefined
            ? state.programs[0]
            : state.programs.find((p) => p.requirementsFile === choice.requirementsFile);
        const file =
          program === undefined || loaded.kind === "refused"
            ? undefined
            : loaded.files.find((entry) => entry.listed.name === program.requirementsFile)?.file;
        if (state.cohort === undefined) unavailable = "cohort-not-chosen";
        else if (program === undefined) unavailable = "program-not-chosen";
        else if (file === undefined) unavailable = "requirements-file-unavailable";
        else if (suggestedLayoutOf(file, program.track).length === 0) unavailable = "no-suggested-layout";
        if (unavailable !== undefined || state.cohort === undefined || file === undefined) return state;

        const made = fromSuggestedLayout(state, file, program?.track, state.cohort, newId);
        summary = made.summary;
        return made.state;
      },
    },
    { basedOn: options.basedOn, ...(options.history ? { history: options.history } : {}) },
  );

  if (outcome.kind === "refused") {
    return { kind: "refused", reason: outcome.reason, warnings: outcome.warnings };
  }
  if (unavailable !== undefined) return { kind: "unavailable", reason: unavailable, version: outcome.version };
  return {
    kind: "served",
    view: await planOf(workspace, outcome.state, options.now ?? Date.now, true),
    version: outcome.version,
    warnings: outcome.warnings,
    summary,
  };
}
