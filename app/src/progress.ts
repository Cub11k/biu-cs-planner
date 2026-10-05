import {
  effectiveFile,
  evaluateProgress,
  pinCourse,
  requirementsAccepting,
  solveAssignment,
  tickManual,
  unpinCourse,
  untickManual,
  type LocalizedText,
  type PinRef,
  type Progress,
  type RequirementRef,
  type RequirementsFile,
  type SolvePin,
  type SolverWarning,
  type State,
  type StateFileVersion,
  type StateFileWarning,
  type StudentCohort,
} from "@biu-cs-planner/core";
import {
  editStateFile,
  readStateFile,
  type EditHistory,
  type EditRefusal,
  type StateEditing,
} from "./edit.ts";
import { DEFAULT_STATE_FILE } from "./picks.ts";
import { programsWarnings, type ProgramsWarning } from "./programs.ts";
import { loadRequirementsFiles, type LoadedRequirements } from "./requirements.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Progress (#288): the student's Attempts evaluated against each chosen Program's Requirements,
 * recomputed from the State File and the Requirements Files on every read — nothing is cached in
 * the State File — and the four edits the Progress screen makes: Pin a Course to a Requirement,
 * unpin it, tick a Manual Requirement, untick it. Each edit is `core`'s pure function plus a label
 * through `editStateFile`, one guarded save and one undo step (ADR-0013), and answers with Progress
 * as it stands afterwards.
 *
 * **One read runs the solver once for every Program together, then the evaluation per Program**,
 * because a double major's Programs compete for a Course: where it counts in one decides whether it
 * may count in the other. The solver is given a clock (`now`), which is what makes its 250 ms cap
 * apply — `core` reads no clock of its own, so without one only its iteration cap would bound a
 * read (#300's amendment). The clock is injected the way `./workspace.memory.ts` injects one.
 *
 * **A Pin and a tick name their Requirements File** (`CONTEXT.md`, Pin): each reaches only the
 * Program whose file it names, and one written before Pins named their file reaches the first
 * Program. A Pin naming a file that is not among the student's Programs is a Warning here.
 */

/** A Pin as the screen marks it: the Course and the Requirement, in this Program. */
export type ProgramPin = { courseNumber: string; requirementId: string };

/** One attempted Course and the Requirements of this Program it can count toward, by id. */
export type PinCandidates = { courseNumber: string; requirementIds: string[] };

/** One chosen Program, evaluated, or the reason it could not be. */
export type ProgramProgress =
  | {
      requirementsFile: string;
      track?: string;
      status: "evaluated";
      program: { id: string; name: LocalizedText };
      progress: Progress;
      /** This Program's Pins, which the screen marks as the student's choice. */
      pins: ProgramPin[];
      /** Where each attempted Course could be pinned, as the engine computes it. */
      candidates: PinCandidates[];
    }
  /**
   * The file is not in the Workspace, is not a Requirements File, or would not be read. Nothing is
   * evaluated for it, and the Programs Warnings say which.
   */
  | {
      requirementsFile: string;
      track?: string;
      status: "missing" | "not-requirements" | "refused";
    };

export type ProgressWarningAbout =
  /** A Pin naming a Requirements File that is none of the student's Programs: it reaches nothing. */
  | { kind: "pin-file-not-chosen"; courseNumber: string; requirementId: string; requirementsFile: string }
  /** A tick naming a Requirements File that is none of the student's Programs, likewise. */
  | { kind: "tick-file-not-chosen"; requirementId: string; requirementsFile: string };

export type ProgressView = {
  /**
   * The student's Cohort, so the screen that shows their Programs can show and change it beside
   * them (#331) from the one read and the one revision, rather than a second read that could
   * answer from another revision.
   */
  cohort: StudentCohort | undefined;
  /** Each chosen Program, in the order the student chose them. Empty when none is chosen. */
  programs: ProgramProgress[];
  /** The solver hit its time or iteration cap, so the Assignment may not be the best one. */
  stoppedEarly: boolean;
  /** The solver's Warnings: a Pin it could not honour, a Track a file does not have. */
  solverWarnings: SolverWarning[];
  /** A Programs entry naming a file the Workspace does not hold, or a Track it does not define. */
  programWarnings: ProgramsWarning[];
  pinWarnings: ProgressWarningAbout[];
};

export type ProgressResult =
  /** `version` is the revision Progress was read from, and what a Pin or a tick is based on. */
  | {
      kind: "served";
      view: ProgressView;
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

export type ProgressReadOptions = {
  /** Defaults to `DEFAULT_STATE_FILE`; a State File is named, never a path. */
  stateFile?: string;
  /** The clock the solver's time cap is measured by. `Date.now` when nothing says otherwise. */
  now?: () => number;
};

export type ProgressEditOptions = ProgressReadOptions & {
  /** The revision the view being edited was read from; see `EditOptions.basedOn`. */
  basedOn: StateFileVersion | undefined;
  history?: EditHistory;
};

/** Progress for a State, against the Requirements Files `requirements/` holds right now. */
async function progressOf(
  workspace: Workspace,
  state: State,
  now: () => number,
): Promise<ProgressView> {
  const loaded = await loadRequirementsFiles(workspace);
  const programWarnings = programsWarnings(state, loaded);
  const byName = new Map<string, LoadedRequirements>(
    loaded.kind === "served" ? loaded.files.map((entry) => [entry.listed.name, entry]) : [],
  );

  // The Programs that can be evaluated, each with its index among them — which is what the
  // solver's Pins name — and, for each Program the student chose, where it landed.
  const solvable: { requirementsFile: string; track?: string; file: RequirementsFile }[] = [];
  const placed = state.programs.map((choice) => {
    const named = {
      requirementsFile: choice.requirementsFile,
      ...(choice.track === undefined ? {} : { track: choice.track }),
    };
    const entry = byName.get(choice.requirementsFile);
    if (entry === undefined) return { ...named, status: "missing" as const };
    if (entry.file === undefined) {
      return {
        ...named,
        status: entry.listed.status === "refused" ? ("refused" as const) : ("not-requirements" as const),
      };
    }
    solvable.push({ ...named, file: entry.file });
    return solvable.length - 1;
  });

  const pinWarnings: ProgressWarningAbout[] = [];
  const solverPins: SolvePin[] = [];
  for (const pin of state.pins) {
    const file = effectiveFile(state, pin);
    const index = solvable.findIndex((program) => program.requirementsFile === file);
    if (index >= 0) {
      solverPins.push({ courseNumber: pin.courseNumber, requirementId: pin.requirementId, program: index });
    } else if (file !== undefined && !state.programs.some((p) => p.requirementsFile === file)) {
      pinWarnings.push({
        kind: "pin-file-not-chosen",
        courseNumber: pin.courseNumber,
        requirementId: pin.requirementId,
        requirementsFile: file,
      });
    }
  }

  for (const tick of state.manualTicks) {
    const file = effectiveFile(state, tick);
    if (file !== undefined && !state.programs.some((p) => p.requirementsFile === file)) {
      pinWarnings.push({ kind: "tick-file-not-chosen", requirementId: tick.requirementId, requirementsFile: file });
    }
  }

  const solution =
    solvable.length === 0
      ? { assignments: [], stoppedEarly: false, warnings: [] }
      : solveAssignment({
          programs: solvable.map(({ file, track }) => (track === undefined ? { file } : { file, track })),
          attempts: state.attempts,
          pins: solverPins,
          limits: { now },
        });

  const attempted = [...new Set(state.attempts.map((attempt) => attempt.courseNumber))].sort();
  const evaluated = (index: number): ProgramProgress => {
    const { requirementsFile, track, file } = solvable[index]!;
    const mine = <T extends { requirementsFile?: string | undefined }>(held: T): boolean =>
      effectiveFile(state, held) === requirementsFile;
    return {
      requirementsFile,
      ...(track === undefined ? {} : { track }),
      status: "evaluated",
      program: { id: file.program.id, name: file.program.name },
      progress: evaluateProgress({
        file,
        ...(track === undefined ? {} : { track }),
        attempts: state.attempts,
        assignment: solution.assignments[index]!,
        ticked: state.manualTicks.filter(mine).map((tick) => tick.requirementId),
      }),
      pins: state.pins
        .filter(mine)
        .map((pin) => ({ courseNumber: pin.courseNumber, requirementId: pin.requirementId })),
      candidates: attempted.map((courseNumber) => ({
        courseNumber,
        requirementIds: requirementsAccepting(file, track, courseNumber),
      })),
    };
  };
  const programs = placed.map((slot) => (typeof slot === "number" ? evaluated(slot) : slot));

  return {
    cohort: state.cohort,
    programs,
    stoppedEarly: solution.stoppedEarly,
    solverWarnings: solution.warnings,
    programWarnings,
    pinWarnings,
  };
}

/** Progress for the State File's chosen Programs, recomputed now. */
export async function readProgress(
  workspace: Workspace,
  options: ProgressReadOptions = {},
): Promise<ProgressResult> {
  const loaded = await readStateFile(workspace, options.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }
  return {
    kind: "served",
    view: await progressOf(workspace, loaded.state, options.now ?? Date.now),
    version: loaded.version,
    warnings: loaded.warnings,
  };
}

async function edit(
  workspace: Workspace,
  editing: StateEditing,
  options: ProgressEditOptions,
): Promise<ProgressResult> {
  const outcome = await editStateFile(workspace, options.stateFile ?? DEFAULT_STATE_FILE, editing, {
    basedOn: options.basedOn,
    ...(options.history ? { history: options.history } : {}),
  });
  if (outcome.kind === "refused") {
    return { kind: "refused", reason: outcome.reason, warnings: outcome.warnings };
  }
  return {
    kind: "served",
    view: await progressOf(workspace, outcome.state, options.now ?? Date.now),
    version: outcome.version,
    warnings: outcome.warnings,
  };
}

/** Pins a Course to a Requirement, replacing the Pin it had in that Program. */
export async function pinCourseTo(
  workspace: Workspace,
  pin: PinRef,
  options: ProgressEditOptions,
): Promise<ProgressResult> {
  return edit(workspace, { label: "pin-course", apply: (state) => pinCourse(state, pin) }, options);
}

/** Removes a Pin, so the solver decides where the Course counts again. */
export async function unpinCourseFrom(
  workspace: Workspace,
  pin: PinRef,
  options: ProgressEditOptions,
): Promise<ProgressResult> {
  return edit(workspace, { label: "unpin-course", apply: (state) => unpinCourse(state, pin) }, options);
}

/** Ticks a Manual Requirement the student has met. */
export async function tickManualRequirement(
  workspace: Workspace,
  tick: RequirementRef,
  options: ProgressEditOptions,
): Promise<ProgressResult> {
  return edit(workspace, { label: "tick-manual", apply: (state) => tickManual(state, tick) }, options);
}

/** Unticks a Manual Requirement. */
export async function untickManualRequirement(
  workspace: Workspace,
  tick: RequirementRef,
  options: ProgressEditOptions,
): Promise<ProgressResult> {
  return edit(
    workspace,
    { label: "untick-manual", apply: (state) => untickManual(state, tick) },
    options,
  );
}
