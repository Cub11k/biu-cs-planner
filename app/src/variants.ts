import {
  createVariant,
  deleteVariant,
  duplicateVariant,
  freeVariantName,
  renameVariant,
  setPrimaryVariant,
} from "@biu-cs-planner/core";
import {
  editTimetable,
  variantEditedIn,
  type PickOptions,
  type TimetableRef,
  type TimetableResult,
} from "./picks.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The use cases behind the Variant tabs (#281): create, duplicate, rename, delete and make
 * primary.
 *
 * Each is `core`'s pure edit plus a label, handed to `editTimetable` and so to `editStateFile` —
 * one guarded save and one undo step each (ADR-0013). Each answers with the Timetable as it
 * stands afterwards, about the Variant the student should now be looking at: the one just made,
 * the one just renamed or made primary, and — after a delete — the primary.
 *
 * Nothing here refuses a student's edit. A name another Variant already has is written, and the
 * collision comes back in the view's `variantWarnings`.
 */

/**
 * A Variant name the student may leave out: a new or a duplicated Variant is then given the
 * first free letter (`freeVariantName`), which they can rename once they have tried it.
 */
export type VariantNaming = { name?: string };

/**
 * Creates an empty Variant in one Semester, making the Timetable if there is none yet. `at`
 * names the Semester; any Variant it names is ignored, because a new Variant is about itself.
 */
export async function addVariant(
  workspace: Workspace,
  at: TimetableRef,
  naming: VariantNaming,
  options: PickOptions,
): Promise<TimetableResult> {
  // The name is decided against the State the edit is applied to, so a default letter is free
  // in the file actually written rather than in whatever the page last saw.
  let created: string | undefined;
  return editTimetable(
    workspace,
    at,
    {
      label: "create-variant",
      apply: (state) => {
        created = naming.name ?? freeVariantName(state, at);
        return createVariant(state, { ...at, variant: created });
      },
    },
    options,
    () => ({ ...at, variant: created }),
  );
}

/** Copies the Variant `at` names — the primary when it names none — under a new name. */
export async function duplicateVariantAs(
  workspace: Workspace,
  at: TimetableRef,
  naming: VariantNaming,
  options: PickOptions,
): Promise<TimetableResult> {
  let copy: string | undefined;
  return editTimetable(
    workspace,
    at,
    {
      label: "duplicate-variant",
      apply: (state) => {
        copy = naming.name ?? freeVariantName(state, at);
        return duplicateVariant(state, variantEditedIn(state, at), copy);
      },
    },
    options,
    () => ({ ...at, variant: copy }),
  );
}

/** Renames the Variant `at` names. */
export async function renameVariantAs(
  workspace: Workspace,
  at: TimetableRef,
  name: string,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    {
      label: "rename-variant",
      apply: (state) => renameVariant(state, variantEditedIn(state, at), name),
    },
    options,
    () => ({ ...at, variant: name }),
  );
}

/** Deletes the Variant `at` names, and answers about the primary that is left. */
export async function removeVariant(
  workspace: Workspace,
  at: TimetableRef,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    {
      label: "delete-variant",
      apply: (state) => deleteVariant(state, variantEditedIn(state, at)),
    },
    options,
    // no Variant named, which reads as the primary: the deleted one is gone, and deleting the
    // primary promoted another
    () => ({ ...at, variant: undefined }),
  );
}

/** Makes the Variant `at` names the primary one, and every other Variant of it not. */
export async function makeVariantPrimary(
  workspace: Workspace,
  at: TimetableRef,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    {
      label: "set-primary-variant",
      apply: (state) => setPrimaryVariant(state, variantEditedIn(state, at)),
    },
    options,
  );
}
