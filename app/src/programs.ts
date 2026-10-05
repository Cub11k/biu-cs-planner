import {
  programWarnings,
  setCohort,
  setPrograms,
  type ListedRequirementsFile,
  type Program,
  type ProgramWarning,
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
import { loadRequirementsFiles, type RequirementsListing } from "./requirements.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The student's Cohort and Programs (#287): read them, and set either. Each set is `core`'s pure
 * edit plus a label through `editStateFile` — one guarded save and one undo step each (ADR-0013) —
 * and nothing here refuses a choice: a Program naming a file the Workspace does not hold, or a
 * Track that file does not define, is stored and comes back as a Warning.
 */

/**
 * A Warning about the student's Programs: `core`'s, given what the Workspace holds, or that the
 * Workspace would not list `requirements/` at all — in which case nothing can be said about any
 * one Program, and saying every file was missing would be false.
 */
export type ProgramsWarning = ProgramWarning | { kind: "requirements-unlisted" };

export type ProgramsView = {
  cohort: StudentCohort | undefined;
  programs: Program[];
  programWarnings: ProgramsWarning[];
};

export type ProgramsResult =
  /** `version` is the revision the view was read from, and what a change has to be based on. */
  | {
      kind: "served";
      view: ProgramsView;
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

export type ProgramsOptions = {
  /** The revision the view being edited was read from; see `EditOptions.basedOn`. */
  basedOn: StateFileVersion | undefined;
  /** Defaults to `DEFAULT_STATE_FILE`; a State File is named, never a path. */
  stateFile?: string;
  history?: EditHistory;
};

/** The Warnings for a State's Programs, against a reading of `requirements/`. */
export function programsWarnings(state: State, loaded: RequirementsListing): ProgramsWarning[] {
  if (state.programs.length === 0) return [];
  if (loaded.kind === "refused") return [{ kind: "requirements-unlisted" }];
  const listing: ListedRequirementsFile[] = loaded.files.map(({ listed }) =>
    listed.status === "read"
      ? { name: listed.name, tracks: listed.tracks.map((track) => track.id) }
      : { name: listed.name },
  );
  return programWarnings(state, listing);
}

/**
 * `requirements/` as `loadRequirementsFiles` reads it — except that, **after a save has landed, a
 * read that fails in any way is read as a folder that would not be listed** (#344, the shape #324
 * gave the Timetable's Catalog read). `loadRequirementsFiles` answers a refusal itself and lets
 * anything else propagate, which on a read is a 500 that changed nothing. Built after a save, the
 * same throw answered 500 for an edit that had been written, and the page told the student it
 * failed. So the answer carries the new revision, and the listing it could not make is marked —
 * `requirements-unlisted` among the Programs Warnings — rather than left out or made up.
 */
export async function requirementsFiles(workspace: Workspace, afterSave: boolean): Promise<RequirementsListing> {
  if (!afterSave) return loadRequirementsFiles(workspace);
  try {
    return await loadRequirementsFiles(workspace);
  } catch {
    return { kind: "refused", reason: "workspace-refused" };
  }
}

/** The Warnings for a State's Programs, against what `requirements/` holds right now. */
async function warningsFor(workspace: Workspace, state: State, afterSave: boolean): Promise<ProgramsWarning[]> {
  if (state.programs.length === 0) return [];
  return programsWarnings(state, await requirementsFiles(workspace, afterSave));
}

async function viewOf(workspace: Workspace, state: State, afterSave = false): Promise<ProgramsView> {
  return {
    cohort: state.cohort,
    programs: state.programs,
    programWarnings: await warningsFor(workspace, state, afterSave),
  };
}

/** The Cohort and Programs the State File holds, and the Warnings about them. */
export async function readPrograms(
  workspace: Workspace,
  options: { stateFile?: string } = {},
): Promise<ProgramsResult> {
  const loaded = await readStateFile(workspace, options.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }
  return {
    kind: "served",
    view: await viewOf(workspace, loaded.state),
    version: loaded.version,
    warnings: loaded.warnings,
  };
}

async function edit(
  workspace: Workspace,
  editing: StateEditing,
  options: ProgramsOptions,
): Promise<ProgramsResult> {
  const outcome = await editStateFile(workspace, options.stateFile ?? DEFAULT_STATE_FILE, editing, {
    basedOn: options.basedOn,
    ...(options.history ? { history: options.history } : {}),
  });
  if (outcome.kind === "refused") {
    return { kind: "refused", reason: outcome.reason, warnings: outcome.warnings };
  }
  return {
    kind: "served",
    // the save has landed, so nothing read from here on may answer as if it had not (#344)
    view: await viewOf(workspace, outcome.state, true),
    version: outcome.version,
    warnings: outcome.warnings,
  };
}

/** Sets the Cohort, or clears it when given none. */
export async function chooseCohort(
  workspace: Workspace,
  cohort: StudentCohort | undefined,
  options: ProgramsOptions,
): Promise<ProgramsResult> {
  return edit(workspace, { label: "set-cohort", apply: (state) => setCohort(state, cohort) }, options);
}

/** Sets the whole list of Programs: one for a single major, two for a double major. */
export async function choosePrograms(
  workspace: Workspace,
  programs: readonly Program[],
  options: ProgramsOptions,
): Promise<ProgramsResult> {
  return edit(
    workspace,
    { label: "set-programs", apply: (state) => setPrograms(state, programs) },
    options,
  );
}
