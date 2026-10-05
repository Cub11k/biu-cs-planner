import { addToTray, removeFromTray } from "@biu-cs-planner/core";
import {
  editTimetable,
  variantEditedIn,
  type PickOptions,
  type TimetableRef,
  type TimetableResult,
} from "./picks.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The use cases behind the Tray (#283): adding a Course to a Variant's Tray, and removing one.
 *
 * Each is `core`'s pure edit plus a label, through `editTimetable` and so `editStateFile` — one
 * guarded save and one undo step each (ADR-0013). Removing a Course takes its Picks in that
 * Variant with it, in the same edit, so one undo puts both back.
 */

/** Adds a Course to the Tray of the Variant `at` names — the primary when it names none. */
export async function addCourseToTray(
  workspace: Workspace,
  at: TimetableRef,
  courseNumber: string,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    {
      label: "add-to-tray",
      apply: (state) => addToTray(state, variantEditedIn(state, at), courseNumber),
    },
    options,
  );
}

/** Removes a Course from the Tray of the Variant `at` names, with its Picks there. */
export async function removeCourseFromTray(
  workspace: Workspace,
  at: TimetableRef,
  courseNumber: string,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    {
      label: "remove-from-tray",
      apply: (state) => removeFromTray(state, variantEditedIn(state, at), courseNumber),
    },
    options,
  );
}
