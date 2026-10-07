import type { Semester } from "../catalog/schema.ts";
import type { State, Timetable, Variant } from "./schema.ts";

/**
 * Finding and rewriting one Semester's Timetable, which every Timetable edit does — a Pick, a
 * Variant, a Blocked Time and a Tray entry all live under one. Shared here so that "the
 * Timetable for 2027 Fall" means one thing to all of them, and so that each edit stays a plain
 * `state -> state` function (ADR-0013).
 */

/** One Semester of one Academic Year: what names a Timetable (GLOSSARY.md). */
export type TimetableAt = { academicYear: number; semester: Semester };

export const isTimetableFor = (timetable: Timetable, at: TimetableAt): boolean =>
  timetable.academicYear === at.academicYear && timetable.semester === at.semester;

/**
 * The Timetable of one Semester, or nothing when the State File holds none for it. A file
 * holding two for one Semester is reported by `parseStateFile` as `timetable-not-unique`; the
 * first is the one every edit reads and writes, so the edits agree with each other about it.
 */
export function timetableAt(state: State, at: TimetableAt): Timetable | undefined {
  return state.timetables.find((timetable) => isTimetableFor(timetable, at));
}

/**
 * Rewrites one Semester's Timetable, making it first if the State File has none for it yet —
 * which is how a first Pick, a first Variant or a first Blocked Time lands in an empty file.
 *
 * **A rewrite that hands back the Timetable it was given changes nothing**, and the same State
 * comes back rather than a copy: `editStateFile` reads that identity as "nothing to save", so an
 * edit that found nothing to do writes nothing and leaves no undo entry. That holds for a
 * Timetable this function had to make, too — a no-op on a Semester the file never mentioned does
 * not add an empty Timetable to it.
 *
 * Only the first Timetable for the Semester is replaced, by identity: a file that holds two keeps
 * the second exactly as it was rather than having it overwritten with a copy of the first.
 */
export function withTimetable(
  state: State,
  at: TimetableAt,
  rewrite: (timetable: Timetable) => Timetable,
): State {
  const held = timetableAt(state, at);
  const timetable: Timetable = held ?? {
    academicYear: at.academicYear,
    semester: at.semester,
    variants: [],
    blockedTimes: [],
  };

  const next = rewrite(timetable);
  if (next === timetable) return state;

  return {
    ...state,
    timetables:
      held === undefined
        ? [...state.timetables, next]
        : state.timetables.map((existing) => (existing === held ? next : existing)),
  };
}

/**
 * The Variant of a Timetable a name addresses: the first with this name — or, when `position` is
 * given and the Variant at that position in file order carries this name, that one (#322).
 *
 * Two Variants sharing a name is a Warning and not a refusal, so while it lasts the name alone
 * reaches only the first of them. A position lets the second be reached too. It counts only when
 * it agrees with the name, so a position that no longer names that Variant falls back to the
 * name rather than reaching a different Variant; a stale page is refused before any edit is
 * applied anyway (`editStateFile`).
 */
export const variantNamed = (
  timetable: Timetable | undefined,
  name: string,
  position?: number,
): Variant | undefined => {
  const at = position === undefined ? undefined : timetable?.variants[position];
  return at?.name === name ? at : timetable?.variants.find((variant) => variant.name === name);
};
