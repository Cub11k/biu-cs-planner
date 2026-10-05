import {
  blockedTimeWarnings,
  clashesIn,
  recordPick,
  removePick,
  resolveVariant,
  timetableAt,
  trayEntries,
  variantAt,
  variantWarnings,
  type BlockedTime,
  type BlockedTimeWarning,
  type GroupPick,
  type PlanDiff,
  type TimetableClash,
  type PickSlot,
  type Semester,
  type StateFileVersion,
  type StateFileWarning,
  type State,
  type TrayEntry,
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
import { planDiffsOf, yearOfferings } from "./planDiffSources.ts";
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
  /**
   * Which Variant of that name, by position in file order, while two share it (#322): how the
   * second of two same-named tabs is reached. Honoured only when the Variant there carries the
   * name, so leaving it out addresses by name alone, as every caller did before.
   */
  position?: number | undefined;
};

/**
 * One Variant of a Timetable as its tab shows it: the name, whether it is the primary, and
 * `registered: true` on the one the student registered with (#297) — absent on every other, so a
 * Timetable nobody registered answers exactly as it did before the mark existed.
 */
export type VariantTab = { name: string; primary: boolean; registered?: true };

/** One Variant's Picks, and the Clashes among them, beside the other Variants of its Timetable. */
export type TimetableView = {
  /**
   * The Variant this view is about. A read names the one asked for while it exists and the
   * primary otherwise (`resolveVariantName`), so this is what the page is showing and what its
   * next edit should name. The Variant does not exist in the file until its first Pick creates
   * it, so for an empty Timetable this is a name no tab carries yet.
   */
  variantName: string;
  /**
   * Where that Variant stands in file order, which is what tells it from another of the same name
   * (#322): a page sends it back with its next edit. Absent while the Variant does not exist yet.
   */
  variantPosition: number | undefined;
  /** Every Variant of the Timetable, in file order — the tabs above the week (#281). */
  variants: VariantTab[];
  picks: GroupPick[];
  clashes: TimetableClash[];
  /**
   * What is wrong with this Timetable's Variants **after** the edit this view answers: a name
   * two of them share, or not exactly one primary. A Warning and never a refusal, computed from
   * the State this view was built from rather than taken from the file read before the edit,
   * because the edit that made a collision is exactly the one whose answer has to say so.
   */
  variantWarnings: VariantWarning[];
  /**
   * The Tray of the Variant shown, derived (#283): the Courses added to it, the Courses picked in
   * it and the Courses planned for the Semester, each with a chip per Lesson Type read off this
   * year's Catalog. A Course the Catalog cannot answer for — no Catalog, a refused one, or one
   * that does not have it — is listed with `known: false` rather than left out.
   */
  tray: TrayEntry[];
  /**
   * The Semester's Blocked Times (#282), the same whichever Variant is shown — they belong to the
   * Semester, so switching Variants never hides one. In file order, which is how an edit
   * addresses one: by its position here.
   */
  blockedTimes: BlockedTime[];
  /** A Blocked Time that keeps no time free, by position, as the file stands after the edit. */
  blockedTimeWarnings: BlockedTimeWarning[];
  /**
   * Where the Variant shown and the Plan disagree (#295), each resolved only by an explicit
   * "apply to Plan" (ADR-0008). Recomputed from the State this view was built from, so an edit's
   * answer — a Pick, an apply — already says which divergences are left. Empty with no planned
   * Attempt in the Academic Year: a Timetable works with no Plan.
   */
  planDiffs: PlanDiff[];
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
 * Which Variant a **read** of a `TimetableRef` is about: the one named while it exists — of two
 * that share the name, the one at `position` — and the primary otherwise (`resolveVariant`).
 *
 * Exported because `./exams.ts` answers about the same Variant this one does, and a second copy
 * of the fallback would let the exam rail quietly be about a different Variant than the week
 * beside it.
 */
export const variantShownIn = (state: State, at: TimetableRef): VariantRef => ({
  academicYear: at.academicYear,
  semester: at.semester,
  ...resolveVariant(state, at, at.variant, at.position),
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
    : {
        academicYear: at.academicYear,
        semester: at.semester,
        variant: at.variant,
        position: at.position,
      };

/**
 * The Timetable as the screen shows it, built from one State.
 *
 * **Async because of the Tray**, whose chips are read off the Catalog — which `./exams.ts` argued
 * a Pick's answer should not have to read. The read is made only when the Tray has something in
 * it, so a Variant with nothing added, picked or planned costs no Catalog read, and once it has,
 * the chips are part of the answer every edit gives: a chip that filled a poll later than the ink
 * beside it would be a Tray disagreeing with the week. A Catalog that cannot be read is not a
 * refusal and carries no Warning here — the Catalog's own routes say what is wrong with it — and
 * every entry is simply `known: false`. **It is one read for the whole view** (#356): the year's
 * Catalog, from which the Tray takes this Semester's Offerings and the Plan Diffs every Semester's.
 *
 * **After a save, a Catalog read that fails in any way is that same `known: false`** (#324).
 * `yearOfferings` answers a refusal as no Catalog and lets anything else propagate, which for a read
 * is a 500 that changed nothing. Built after a save, the same throw used to answer 500 for an edit
 * that had landed, and the page told the student it failed. So `afterSave` reads the Catalog as
 * not there when the read throws: the answer carries the new revision and the parts it could read,
 * and the Tray says which part it could not.
 */
async function view(
  workspace: Workspace,
  state: State,
  at: TimetableRef,
  afterSave = false,
): Promise<TimetableView> {
  const shown = variantShownIn(state, at);
  const unread = trayEntries(state, shown, undefined);
  // One Catalog read per view (#356), the whole year: the Tray's chips take this Semester's
  // Offerings from it, and the Plan Diffs every Semester's.
  const year = unread.length === 0 ? undefined : await yearOfferings(workspace, at.academicYear, afterSave);
  const tray =
    unread.length === 0
      ? unread
      : trayEntries(state, shown, year?.filter((offering) => offering.semesters.includes(at.semester)));
  // an empty Tray holds nothing planned here and nothing in the Variant, so nothing to diff
  const planDiffs = unread.length === 0 ? [] : await planDiffsOf(workspace, state, shown, year, afterSave);
  return {
    variantName: shown.variant,
    variantPosition: shown.position,
    variants: (timetableAt(state, at)?.variants ?? []).map((variant): VariantTab => ({
      name: variant.name,
      primary: variant.primary,
      ...(variant.registered === true ? { registered: true } : {}),
    })),
    picks: variantAt(state, shown)?.picks ?? [],
    clashes: clashesIn(state, shown),
    variantWarnings: variantWarnings(state, at),
    tray,
    blockedTimes: timetableAt(state, at)?.blockedTimes ?? [],
    blockedTimeWarnings: blockedTimeWarnings(state, at),
    planDiffs,
  };
}

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
    view: await view(workspace, loaded.state, at),
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
    // the save has landed, so nothing read from here on may answer as if it had not (#324)
    view: await view(workspace, outcome.state, answerAbout(), true),
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
