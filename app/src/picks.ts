import {
  clashesIn,
  recordPick,
  removePick,
  resolveVariantName,
  timetableAt,
  variantAt,
  variantWarnings,
  type GroupPick,
  type MeetingClash,
  type PickSlot,
  type Semester,
  type StateFileVersion,
  type StateFileWarning,
  type State,
  type VariantRef,
  type VariantWarning,
} from "@biu-cs-planner/core";
import {
  editStateFile,
  readStateFile,
  type EditHistory,
  type EditRefusal,
  type StateEditing,
} from "./edit.ts";
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
  /**
   * Which Variant, by name. Absent means the primary one — the Variant a student registers
   * with, and the one a Semester opens on (#281) — and, for a Timetable with no Variants yet,
   * `DEFAULT_VARIANT_NAME`, which a first Pick creates as the primary one.
   */
  variant?: string | undefined;
};

/** One Variant of a Timetable as its tab shows it: the name, and whether it is the primary. */
export type VariantTab = { name: string; primary: boolean };

/** One Variant's Picks, and the Clashes among them, beside the other Variants of its Timetable. */
export type TimetableView = {
  /**
   * The Variant this view is about. A read names the one asked for while it exists and the
   * primary otherwise (`resolveVariantName`), so this is what the page is showing and what its
   * next edit should name. The Variant does not exist in the file until its first Pick creates
   * it, so for an empty Timetable this is a name no tab carries yet.
   */
  variantName: string;
  /** Every Variant of the Timetable, in file order — the tabs above the week (#281). */
  variants: VariantTab[];
  picks: GroupPick[];
  clashes: MeetingClash[];
  /**
   * What is wrong with this Timetable's Variants **after** the edit this view answers: a name
   * two of them share, or not exactly one primary. A Warning and never a refusal, computed from
   * the State this view was built from rather than taken from the file read before the edit,
   * because the edit that made a collision is exactly the one whose answer has to say so.
   */
  variantWarnings: VariantWarning[];
};

export type TimetableResult =
  /**
   * `version` is the revision of the State File this view was read from, and the one a save
   * of an edit made on it has to be based on — `undefined` when there is no file yet. It
   * travels with the view rather than being asked for separately, so that whatever shows the
   * Picks is holding the revision they came from and nothing has to remember to fetch it
   * (docs/design.md, "External edits").
   */
  | {
      kind: "served";
      view: TimetableView;
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

export type PickOptions = {
  /** The revision the student's view was read from; see `EditOptions.basedOn`. */
  basedOn: StateFileVersion | undefined;
  history?: EditHistory;
};

/**
 * Which Variant a **read** of a `TimetableRef` is about: the one named while it exists, and the
 * primary otherwise (`resolveVariantName`).
 *
 * Exported because `./exams.ts` answers about the same Variant this one does, and a second copy
 * of the fallback would let the exam rail quietly be about a different Variant than the week
 * beside it.
 */
export const variantShownIn = (state: State, at: TimetableRef): VariantRef => ({
  academicYear: at.academicYear,
  semester: at.semester,
  variant: resolveVariantName(state, at, at.variant),
});

/**
 * Which Variant an **edit** inside one writes to: the one named, verbatim, and the one a read
 * would show when none is named.
 *
 * Verbatim, unlike a read, because a page names the Variant it was showing — `variantName` off
 * the view it was read from — and the revision guard has already refused the edit if the file
 * moved since. Falling back to the primary here would put a Pick into a Variant the student was
 * not looking at; naming one the file does not hold yet is how a first Pick makes it.
 */
export const variantEditedIn = (state: State, at: TimetableRef): VariantRef =>
  at.variant === undefined
    ? variantShownIn(state, at)
    : { academicYear: at.academicYear, semester: at.semester, variant: at.variant };

const view = (state: State, at: TimetableRef): TimetableView => {
  const shown = variantShownIn(state, at);
  return {
    variantName: shown.variant,
    variants: (timetableAt(state, at)?.variants ?? []).map((variant) => ({ name: variant.name, primary: variant.primary })),
    picks: variantAt(state, shown)?.picks ?? [],
    clashes: clashesIn(state, shown),
    variantWarnings: variantWarnings(state, at),
  };
};

/** What the Timetable screen shows: the Picks in the file now, and their Clashes. */
export async function readTimetable(
  workspace: Workspace,
  at: TimetableRef,
): Promise<TimetableResult> {
  const loaded = await readStateFile(workspace, at.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }

  return {
    kind: "served",
    view: view(loaded.state, at),
    version: loaded.version,
    warnings: loaded.warnings,
  };
}

/**
 * Applies one edit to a Timetable and reports the Timetable afterwards.
 *
 * Every Timetable use case is this plus a `core` edit and a label — a Pick, a Variant, and the
 * rest of #298 — so each is one save through `editStateFile` and one undo step (ADR-0013).
 *
 * `answerAbout` is which Variant the answer shows, asked **after** the edit has been applied:
 * an edit that creates or renames a Variant only knows the name it wrote once it has run, and
 * the student is shown the Variant they just made. It defaults to `at`, the Variant edited.
 */
export async function editTimetable(
  workspace: Workspace,
  at: TimetableRef,
  editing: StateEditing,
  options: PickOptions,
  answerAbout: () => TimetableRef = () => at,
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

  return {
    kind: "served",
    view: view(outcome.state, answerAbout()),
    version: outcome.version,
    warnings: outcome.warnings,
  };
}

/**
 * Records a Pick, creating the Timetable and the Variant that hold it if this is the first
 * one. The Clash a Pick causes comes back in the view: it is reported, never refused.
 */
export async function pickGroup(
  workspace: Workspace,
  at: TimetableRef,
  pick: GroupPick,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    { label: "pick-group", apply: (state) => recordPick(state, variantEditedIn(state, at), pick) },
    options,
  );
}

/** Removes the Pick filling one Lesson Type of one Offering. */
export async function removeGroupPick(
  workspace: Workspace,
  at: TimetableRef,
  slot: PickSlot,
  options: PickOptions,
): Promise<TimetableResult> {
  return editTimetable(
    workspace,
    at,
    { label: "remove-pick", apply: (state) => removePick(state, variantEditedIn(state, at), slot) },
    options,
  );
}
