import {
  addBlockedTime,
  copyBlockedTimes,
  removeBlockedTime,
  replaceBlockedTime,
  type BlockedRange,
  type TimetableAt,
} from "@biu-cs-planner/core";
import {
  editTimetable,
  type PickOptions,
  type TimetableRef,
  type TimetableResult,
} from "./picks.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The use cases behind the Blocked Time editor (#282): add, replace, remove, and copy a
 * Semester's Blocked Times to another Semester.
 *
 * Each is `core`'s pure edit plus a label through `editTimetable` and so `editStateFile` — one
 * guarded save and one undo step each (ADR-0013). Blocked Times belong to the Semester, so the
 * Variant `at` names only decides which Variant the answer shows: the one the student is on.
 *
 * A Blocked Time is addressed by its position in the Timetable's list. That is safe across two
 * tabs because the save is refused when the file moved since the view it was made on (#90), so a
 * position is only ever applied to the list the student was looking at.
 */

/** Adds a Blocked Time — two rows for a range that wraps past midnight. */
export async function addBlockedTimeTo(
  workspace: Workspace,
  at: TimetableRef,
  range: BlockedRange,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    { label: "add-blocked-time", apply: (state) => addBlockedTime(state, at, range) },
    options,
  );
}

/** Replaces the Blocked Time at `index` with what the student typed. */
export async function replaceBlockedTimeAt(
  workspace: Workspace,
  at: TimetableRef,
  index: number,
  range: BlockedRange,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    {
      label: "replace-blocked-time",
      apply: (state) => replaceBlockedTime(state, at, index, range),
    },
    options,
  );
}

/** Removes the Blocked Time at `index`. */
export async function removeBlockedTimeAt(
  workspace: Workspace,
  at: TimetableRef,
  index: number,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    { label: "remove-blocked-time", apply: (state) => removeBlockedTime(state, at, index) },
    options,
  );
}

/**
 * Copies every Blocked Time of `at`'s Semester to `to`, adding to what is there. The answer is
 * still about `at`, the week the student copied from.
 */
export async function copyBlockedTimesTo(
  workspace: Workspace,
  at: TimetableRef,
  to: TimetableAt,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    { label: "copy-blocked-times", apply: (state) => copyBlockedTimes(state, at, to) },
    options,
  );
}
