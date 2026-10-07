import type { Day, Semester } from "../catalog/schema.ts";
import { clockAsEnd, clockAsStart } from "../clock.ts";
import type { BlockedTime, State } from "./schema.ts";
import { timetableAt, withTimetable, type TimetableAt } from "./timetable.ts";

/**
 * The Blocked Time edits (#282): add, replace, remove, and copy a Semester's Blocked Times to
 * another Semester.
 *
 * Each is a plain `state -> state` function, handed to the guarded writer with its own label so
 * each is one undo step (ADR-0013). Blocked Times belong to the Semester's Timetable and not to a
 * Variant (`docs/design.md`, "Data model"), so switching Variants never hides one.
 *
 * **A Blocked Time is addressed by its position** in its Timetable's list, the way the parse
 * Warnings already point at one (`timetables[0].blockedTimes[2]`). Position is safe across two
 * tabs because every edit carries the revision it was based on and is refused when the file moved
 * since (#90): an index is only ever applied to the list the student was looking at.
 *
 * Nothing here refuses anything. A range that does not advance is kept as typed and reported by
 * `blockedTimeWarnings`, because a Warning never costs a student what they typed.
 */

/** A Blocked Time as a student enters it: the Semester is the Timetable's, not theirs to type. */
export type BlockedRange = { day: Day; start: string; end: string; label: string };

/** What `blockedTimeWarnings` reports: a Blocked Time that keeps no time free. */
export type BlockedTimeWarning = {
  kind: "blocked-time-does-not-advance";
  index: number;
  start: string;
  end: string;
};

/** The Day after each Day of the week. Friday has none: the week is Sunday to Friday. */
const NEXT_DAY: Readonly<Record<Day, Day | undefined>> = {
  sunday: "monday",
  monday: "tuesday",
  tuesday: "wednesday",
  wednesday: "thursday",
  thursday: "friday",
  friday: undefined,
};

/**
 * One typed range as the rows it is stored as, which is where the glossary puts the split
 * (GLOSSARY.md, Blocked Time; the ruling on #39): a Blocked Time never wraps past midnight, and
 * the screen that takes a wrapping range from a student is what makes it two.
 *
 * Each end is read in its own position (`core/src/clock.ts`, #48), so:
 *
 *   - an end after the start is one row — `22:00`–`00:00` among them, since an `end` of `00:00`
 *     is the end of the Day, and `00:00`–`00:00`, which is the whole Day;
 *   - an end **before** the start wraps: the Day's part runs to midnight and the next Day's from
 *     it, so `23:00`–`01:00` on Monday is Monday `23:00`–`00:00` and Tuesday `00:00`–`01:00`;
 *   - an end **equal** to the start keeps no time free and wraps into nothing anyone meant, so it
 *     is one row as typed, and `blockedTimeWarnings` names it.
 *
 * **Friday night keeps only Friday's part.** The week this domain knows is Sunday to Friday
 * (`daySchema`); the tail falls on a Saturday it has no name for and no Meeting can occupy, so it
 * could never Clash with anything and there is nowhere to store it. Dropping it loses nothing a
 * Timetable can see.
 */
export function splitBlockedRange(semester: Semester, range: BlockedRange): BlockedTime[] {
  const start = clockAsStart(range.start);
  const end = clockAsEnd(range.end);
  const typed: BlockedTime = { semester, ...range };
  if (start === undefined || end === undefined || end >= start) return [typed];

  const next = NEXT_DAY[range.day];
  const tonight: BlockedTime = { ...typed, end: "00:00" };
  return next === undefined ? [tonight] : [tonight, { ...typed, day: next, start: "00:00" }];
}

const sameBlockedTime = (a: BlockedTime, b: BlockedTime): boolean =>
  a.semester === b.semester &&
  a.day === b.day &&
  a.start === b.start &&
  a.end === b.end &&
  a.label === b.label;

/** Rewrites a Timetable's Blocked Times; handing back the same list changes nothing. */
const withBlockedTimes = (
  state: State,
  at: TimetableAt,
  rewrite: (blockedTimes: BlockedTime[]) => BlockedTime[],
): State =>
  withTimetable(state, at, (timetable) => {
    const blockedTimes = rewrite(timetable.blockedTimes);
    return blockedTimes === timetable.blockedTimes ? timetable : { ...timetable, blockedTimes };
  });

/** Adds a Blocked Time — two rows for a range that wraps — making the Timetable if needed. */
export function addBlockedTime(state: State, at: TimetableAt, range: BlockedRange): State {
  return withBlockedTimes(state, at, (blockedTimes) => [
    ...blockedTimes,
    ...splitBlockedRange(at.semester, range),
  ]);
}

/**
 * Replaces the Blocked Time at one position with what the student typed — two rows where it
 * stood, for a range that wraps. A position that is not there, or a replacement identical to what
 * is there, hands the same State back.
 */
export function replaceBlockedTime(
  state: State,
  at: TimetableAt,
  index: number,
  range: BlockedRange,
): State {
  return withBlockedTimes(state, at, (blockedTimes) => {
    const held = blockedTimes[index];
    if (held === undefined) return blockedTimes;
    const rows = splitBlockedRange(at.semester, range);
    if (rows.length === 1 && sameBlockedTime(rows[0]!, held)) return blockedTimes;

    return [...blockedTimes.slice(0, index), ...rows, ...blockedTimes.slice(index + 1)];
  });
}

/** Removes the Blocked Time at one position; a position that is not there changes nothing. */
export function removeBlockedTime(state: State, at: TimetableAt, index: number): State {
  return withBlockedTimes(state, at, (blockedTimes) =>
    blockedTimes[index] === undefined
      ? blockedTimes
      : blockedTimes.filter((_, position) => position !== index),
  );
}

/**
 * Copies every Blocked Time of one Semester's Timetable to another's — a job that continues all
 * year is entered once (`docs/design.md`, "Data model").
 *
 * **Added to the target's, never replacing them**, and with the Semester each carries rewritten
 * to the target's: `parseStateFile` warns `blocked-time-semester-mismatch` about one that
 * disagrees with its Timetable, and the Clashes module reads the field. A Blocked Time the target
 * already holds exactly is not copied again, so copying twice is copying once rather than two
 * hatched copies of one shift. Copying into the same Semester, or from one with none, hands the
 * same State back.
 */
export function copyBlockedTimes(state: State, from: TimetableAt, to: TimetableAt): State {
  if (from.academicYear === to.academicYear && from.semester === to.semester) return state;
  const source = timetableAt(state, from)?.blockedTimes ?? [];

  return withBlockedTimes(state, to, (blockedTimes) => {
    const copies = source
      .map((blocked) => ({ ...blocked, semester: to.semester }))
      .filter((copy) => !blockedTimes.some((held) => sameBlockedTime(held, copy)));
    return copies.length === 0 ? blockedTimes : [...blockedTimes, ...copies];
  });
}

/**
 * The Blocked Times of one Semester that keep no time free, by position — computed from a State,
 * so an edit's answer says so about the row it has just written. `parseStateFile` reports the
 * same thing as it reads a whole file (`checkBlockedRanges` in `./file.ts`), and the two read a
 * clock the same way because both read it through `core/src/clock.ts`.
 */
export function blockedTimeWarnings(state: State, at: TimetableAt): BlockedTimeWarning[] {
  return (timetableAt(state, at)?.blockedTimes ?? []).flatMap((blocked, index) => {
    const start = clockAsStart(blocked.start);
    const end = clockAsEnd(blocked.end);
    return start !== undefined && end !== undefined && end > start
      ? []
      : [{ kind: "blocked-time-does-not-advance", index, start: blocked.start, end: blocked.end }];
  });
}
