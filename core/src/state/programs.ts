import type { Program, State, StudentCohort } from "./schema.ts";

/**
 * The student's Cohort and Programs (#287): which rules apply to them. Two edits, each a plain
 * `state -> state` function the guarded writer is handed with its own label, so each is one undo
 * step (ADR-0013); and the Warnings for a Programs entry the Workspace cannot honour.
 *
 * **The Programs are set as a whole list**, never one entry at a time. A double major is two
 * entries, and choosing the second Program while changing the first's Track is one decision a
 * student makes on one form: one edit, one save, one undo step.
 *
 * Each edit hands back the State it was given when nothing moves, which `editStateFile` reads as
 * "nothing to save" — so choosing the Program already chosen moves no change count and spends no
 * undo entry.
 *
 * Nothing here refuses anything. A Program naming a file the Workspace does not hold, or a Track
 * that file does not define, is stored as chosen and named by `programWarnings`: a file removed
 * from the folder, or reissued without a Track, must not break the State File or silently change
 * the student's rules.
 */

/** Sets the Cohort, or clears it when given none. */
export function setCohort(state: State, cohort: StudentCohort | undefined): State {
  const current = state.cohort;
  if (
    current?.academicYear === cohort?.academicYear &&
    current?.semester === cohort?.semester
  ) {
    return state;
  }
  if (cohort === undefined) {
    const { cohort: _cleared, ...rest } = state;
    return rest;
  }
  return { ...state, cohort: { academicYear: cohort.academicYear, semester: cohort.semester } };
}

const sameProgram = (a: Program, b: Program): boolean =>
  a.requirementsFile === b.requirementsFile && a.track === b.track;

/**
 * Sets the whole list of Programs: one for a single major, two for a double major.
 *
 * **A Pin or tick that names no file keeps the file it meant.** Such a one is read as naming the
 * first Program's (`effectiveFile`), so when this edit changes which file is first — the order of
 * a double major swapped, or the first Program replaced — it is stamped with the file that was
 * first, in the same edit, rather than silently moving to another Program's Requirement.
 */
export function setPrograms(state: State, programs: readonly Program[]): State {
  if (
    programs.length === state.programs.length &&
    programs.every((program, index) => sameProgram(program, state.programs[index]!))
  ) {
    return state;
  }
  const wasFirst = state.programs[0]?.requirementsFile;
  const keepMeaning = <T extends { requirementsFile?: string | undefined }>(held: T): T =>
    held.requirementsFile === undefined && wasFirst !== undefined && programs[0]?.requirementsFile !== wasFirst
      ? { ...held, requirementsFile: wasFirst }
      : held;
  return {
    ...state,
    pins: state.pins.map(keepMeaning),
    manualTicks: state.manualTicks.map(keepMeaning),
    programs: programs.map((program) =>
      program.track === undefined
        ? { requirementsFile: program.requirementsFile }
        : { requirementsFile: program.requirementsFile, track: program.track },
    ),
  };
}

/**
 * One Requirements File the Workspace holds, as the Warnings need it: its name, and the ids of
 * the Tracks it defines — absent when the file is there and cannot be read as a Requirements File
 * at all.
 */
export type ListedRequirementsFile = { name: string; tracks?: readonly string[] };

export type ProgramWarning =
  /** The Programs entry at `index` names a file the Workspace does not hold. */
  | { kind: "program-file-missing"; index: number; requirementsFile: string }
  /** It names a file that is there and is not a Requirements File this build can read. */
  | { kind: "program-file-unreadable"; index: number; requirementsFile: string }
  /** It names a Track its file does not define, so only the base rule set applies. */
  | { kind: "program-track-unknown"; index: number; requirementsFile: string; track: string };

/** What is wrong with the student's Programs, given what the Workspace holds. */
export function programWarnings(
  state: State,
  listing: readonly ListedRequirementsFile[],
): ProgramWarning[] {
  const byName = new Map(listing.map((file) => [file.name, file]));
  const warnings: ProgramWarning[] = [];
  state.programs.forEach((program, index) => {
    const { requirementsFile, track } = program;
    const listed = byName.get(requirementsFile);
    if (listed === undefined) {
      warnings.push({ kind: "program-file-missing", index, requirementsFile });
    } else if (listed.tracks === undefined) {
      warnings.push({ kind: "program-file-unreadable", index, requirementsFile });
    } else if (track !== undefined && !listed.tracks.includes(track)) {
      warnings.push({ kind: "program-track-unknown", index, requirementsFile, track });
    }
  });
  return warnings;
}

/**
 * The Requirements File a Pin or a ticked Manual Requirement is about: the one it names, or — for
 * one written before Pins named their file — the student's first Program's (`GLOSSARY.md`, Pin).
 * `undefined` when it names none and the student has chosen no Program, so it is about nothing
 * that is evaluated.
 */
export function effectiveFile(
  state: Pick<State, "programs">,
  ref: { requirementId?: string; requirementsFile?: string | undefined },
): string | undefined {
  return ref.requirementsFile ?? state.programs[0]?.requirementsFile;
}
