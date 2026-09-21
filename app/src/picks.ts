import {
  clashesIn,
  DEFAULT_VARIANT_NAME,
  recordPick,
  removePick,
  variantAt,
  type GroupPick,
  type MeetingClash,
  type PickSlot,
  type Semester,
  type StateFileWarning,
  type State,
  type VariantRef,
} from "@biu-cs-planner/core";
import { editStateFile, readStateFile, type EditHistory, type EditRefusal } from "./edit.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The use cases behind a Pick: read one Semester's Variant, record a Pick in it, remove one.
 *
 * Each is `core`'s pure function plus a label, handed to `editStateFile` — the wrapper
 * ADR-0013 describes. Nothing here refuses a student's edit: a Pick that Clashes is
 * recorded and the Clash travels back with it as a Warning does.
 */

/**
 * The State File a student is working in while there is no picker for choosing one.
 *
 * A Workspace holds one or more State Files at its root — `alice.state.json` — and the
 * Workspace screen will offer a picker when there are several (docs/design.md, "Screens").
 * Until it does, every use case here works on this one unless its caller names another, so
 * the name is an argument with a default rather than something baked into a route.
 */
export const DEFAULT_STATE_FILE = "me";

/** Which Semester's Picks, in which State File and which Variant. */
export type TimetableRef = {
  academicYear: number;
  semester: Semester;
  /** Defaults to `DEFAULT_STATE_FILE`; a State File is named, never a path. */
  stateFile?: string;
  /** Defaults to `DEFAULT_VARIANT_NAME`, which a first Pick creates as the primary one. */
  variant?: string;
};

/** One Variant's Picks, and the Clashes among them. */
export type TimetableView = {
  /** Named; the Variant does not exist in the file until its first Pick creates it. */
  variantName: string;
  picks: GroupPick[];
  clashes: MeetingClash[];
};

export type TimetableResult =
  | { kind: "served"; view: TimetableView; warnings: StateFileWarning[] }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

export type PickOptions = { history?: EditHistory };

const where = (at: TimetableRef): VariantRef => ({
  academicYear: at.academicYear,
  semester: at.semester,
  variant: at.variant ?? DEFAULT_VARIANT_NAME,
});

const view = (state: State, at: VariantRef): TimetableView => ({
  variantName: at.variant,
  picks: variantAt(state, at)?.picks ?? [],
  clashes: clashesIn(state, at),
});

/** What the Timetable screen shows: the Picks in the file now, and their Clashes. */
export async function readTimetable(
  workspace: Workspace,
  at: TimetableRef,
): Promise<TimetableResult> {
  const loaded = await readStateFile(workspace, at.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }

  return { kind: "served", view: view(loaded.state, where(at)), warnings: loaded.warnings };
}

/** Applies one edit to the Variant and reports what the Variant holds afterwards. */
async function edit(
  workspace: Workspace,
  at: TimetableRef,
  editing: { label: string; apply(state: State): State },
  options: PickOptions,
): Promise<TimetableResult> {
  const outcome = await editStateFile(
    workspace,
    at.stateFile ?? DEFAULT_STATE_FILE,
    editing,
    options,
  );
  if (outcome.kind === "refused") {
    return { kind: "refused", reason: outcome.reason, warnings: outcome.warnings };
  }

  return { kind: "served", view: view(outcome.state, where(at)), warnings: outcome.warnings };
}

/**
 * Records a Pick, creating the Timetable and the Variant that hold it if this is the first
 * one. The Clash a Pick causes comes back in the view: it is reported, never refused.
 */
export async function pickGroup(
  workspace: Workspace,
  at: TimetableRef,
  pick: GroupPick,
  options: PickOptions = {},
): Promise<TimetableResult> {
  return edit(
    workspace,
    at,
    { label: "pick-group", apply: (state) => recordPick(state, where(at), pick) },
    options,
  );
}

/** Removes the Pick filling one Lesson Type of one Offering. */
export async function removeGroupPick(
  workspace: Workspace,
  at: TimetableRef,
  slot: PickSlot,
  options: PickOptions = {},
): Promise<TimetableResult> {
  return edit(
    workspace,
    at,
    { label: "remove-pick", apply: (state) => removePick(state, where(at), slot) },
    options,
  );
}
