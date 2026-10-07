import { effectiveFile } from "./programs.ts";
import type { ManualTick, Pin, State } from "./schema.ts";

/**
 * Pins and ticked Manual Requirements (#288): Pin a Course to a Requirement, unpin it, tick a
 * Manual Requirement, untick it. Each is a plain `state -> state` function the guarded writer is
 * handed with its own label, so each is one undo step (ADR-0013), and each hands back the State it
 * was given when nothing moves, so nothing is saved.
 *
 * **A Requirement is named by its id and its Requirements File** (`GLOSSARY.md`, Pin), because an
 * id is unique only within one file and a double major has two. Every Pin and tick written here
 * names its file. One written before Pins named their file is read as naming the student's first
 * Program's (`effectiveFile`), so pinning a Course in the first Program replaces such a Pin, and
 * unpinning it there removes it.
 *
 * Nothing here checks that the Requirement exists or can take the Course: that is the engine's to
 * say, and a Pin that cannot be honoured is a Warning there rather than a refused edit.
 */

/** Which Requirement of which file, as an edit names it: the file is always named. */
export type RequirementRef = { requirementsFile: string; requirementId: string };

/** A Pin as an edit names it. */
export type PinRef = RequirementRef & { courseNumber: string };

const sameRequirement = (state: State, held: ManualTick | Pin, ref: RequirementRef): boolean =>
  held.requirementId === ref.requirementId && effectiveFile(state, held) === ref.requirementsFile;

/**
 * Pins a Course to a Requirement, replacing any Pin the Course already had in that Program: a
 * Course pinned somewhere new in one Program is no longer pinned where it was, while its Pin in the
 * other Program of a double major stays.
 */
export function pinCourse(state: State, pin: PinRef): State {
  const inProgram = (held: Pin): boolean =>
    held.courseNumber === pin.courseNumber && effectiveFile(state, held) === pin.requirementsFile;
  const already = state.pins.filter(inProgram);
  if (already.length === 1 && sameRequirement(state, already[0]!, pin) && already[0]!.requirementsFile !== undefined) {
    return state;
  }
  return {
    ...state,
    pins: [
      ...state.pins.filter((held) => !inProgram(held)),
      {
        courseNumber: pin.courseNumber,
        requirementsFile: pin.requirementsFile,
        requirementId: pin.requirementId,
      },
    ],
  };
}

/** Removes the Pin of a Course to a Requirement, so the solver decides where it counts again. */
export function unpinCourse(state: State, pin: PinRef): State {
  const pins = state.pins.filter(
    (held) => !(held.courseNumber === pin.courseNumber && sameRequirement(state, held, pin)),
  );
  return pins.length === state.pins.length ? state : { ...state, pins };
}

/** Ticks a Manual Requirement the student has met. */
export function tickManual(state: State, tick: RequirementRef): State {
  if (state.manualTicks.some((held) => sameRequirement(state, held, tick))) return state;
  return {
    ...state,
    manualTicks: [
      ...state.manualTicks,
      { requirementsFile: tick.requirementsFile, requirementId: tick.requirementId },
    ],
  };
}

/** Unticks a Manual Requirement, so a mistake is reversible. */
export function untickManual(state: State, tick: RequirementRef): State {
  const manualTicks = state.manualTicks.filter((held) => !sameRequirement(state, held, tick));
  return manualTicks.length === state.manualTicks.length ? state : { ...state, manualTicks };
}
