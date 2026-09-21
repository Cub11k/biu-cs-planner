import type { Semester } from "../catalog/schema.ts";
import {
  findMeetingClashes,
  type MeetingClash,
  type PickedGroup,
} from "../timetable/clashes.ts";
import type { GroupPick, State, Timetable, Variant } from "./schema.ts";

/**
 * The first edits the app can make: recording a Pick and removing one.
 *
 * Both are plain `state -> state` functions, beside the Clashes and Exams logic and with no
 * filesystem anywhere near them ([ADR-0013](../../../docs/adr/0013-undo-is-snapshots-not-commands.md)).
 * `app` wraps them — it keeps the previous value with the label the use case supplied and
 * saves the new one — so undo costs one wrapper rather than an inverse per edit, and there
 * is no command concept for either of these to be.
 *
 * Nothing here refuses anything. A Pick that Clashes is recorded and the Clash is reported
 * by `clashesIn`, because every domain check is a Warning and an edit always goes through
 * (docs/design.md, "API and data rules").
 */

/**
 * The Variant a first Pick goes into when nothing else names one.
 *
 * A Pick lives in a Variant (CONTEXT.md), so picking requires one, and there is no screen
 * for creating or naming Variants yet. A single letter rather than a translated word:
 * a Variant's name is the student's own text, it is written into their file, and a name
 * that arrived from the UI language would read as the wrong language the moment they
 * switched. `A` is what the Variant tabs in docs/design.md would call the first one.
 */
export const DEFAULT_VARIANT_NAME = "A";

/** One Variant of one Semester's Timetable: everything needed to find the Picks. */
export type VariantRef = {
  academicYear: number;
  semester: Semester;
  /** Variants are named, and the name is what tells them apart (CONTEXT.md). */
  variant: string;
};

/**
 * What one Pick occupies: one Lesson Type of one Offering. Picking a second Group for a
 * slot already filled replaces what was there, which is what "the choice of one Group"
 * means — and it is why this is a pair rather than a Group number.
 */
export type PickSlot = { courseNumber: string; lessonType: string };

const isTimetableFor = (timetable: Timetable, at: VariantRef): boolean =>
  timetable.academicYear === at.academicYear && timetable.semester === at.semester;

const fills = (pick: GroupPick, slot: PickSlot): boolean =>
  pick.courseNumber === slot.courseNumber && pick.lessonType === slot.lessonType;

/** The Timetable of one Semester, or nothing when the State File holds none for it. */
function timetableAt(state: State, at: VariantRef): Timetable | undefined {
  return state.timetables.find((timetable) => isTimetableFor(timetable, at));
}

/** The named Variant, or nothing when neither it nor its Timetable is there yet. */
export function variantAt(state: State, at: VariantRef): Variant | undefined {
  return timetableAt(state, at)?.variants.find((variant) => variant.name === at.variant);
}

/**
 * Rewrites one Variant, making the Timetable and the Variant if they are not there yet.
 *
 * Creating them is what lets a first Pick land in an empty State File, and the created
 * Variant is primary only when it is the Timetable's first: exactly one Variant of a
 * Timetable is primary (core/src/state/schema.ts), and an app that made every new one
 * primary would be writing the file that `parseStateFile` warns about.
 */
function inVariant(
  state: State,
  at: VariantRef,
  rewrite: (picks: GroupPick[]) => GroupPick[],
): State {
  const timetable = timetableAt(state, at) ?? {
    academicYear: at.academicYear,
    semester: at.semester,
    variants: [],
    blockedTimes: [],
  };
  const variant = timetable.variants.find((v) => v.name === at.variant) ?? {
    name: at.variant,
    primary: timetable.variants.length === 0,
    picks: [],
  };

  const rewritten: Variant = { ...variant, picks: rewrite(variant.picks) };
  const variants = timetable.variants.some((v) => v.name === at.variant)
    ? timetable.variants.map((v) => (v.name === at.variant ? rewritten : v))
    : [...timetable.variants, rewritten];

  const next: Timetable = { ...timetable, variants };
  return {
    ...state,
    timetables: state.timetables.some((t) => isTimetableFor(t, at))
      ? state.timetables.map((t) => (isTimetableFor(t, at) ? next : t))
      : [...state.timetables, next],
  };
}

/**
 * Records a Pick: one Group chosen for one Lesson Type of an Offering, carrying the
 * snapshot of that Group's Meetings the caller took. The snapshot is required rather than
 * an optimisation — a re-import compares it against the new Catalog to show "changed since
 * picked" — and nothing here reads or reconstructs it.
 *
 * A Pick already filling the slot is replaced where it stood, so re-picking a Lesson Type
 * does not shuffle the Variant. A file that somehow holds two Picks for one slot — hand
 * edited, and reported by `parseStateFile` as `pick-not-unique` — comes back with one.
 */
export function recordPick(state: State, at: VariantRef, pick: GroupPick): State {
  return inVariant(state, at, (picks) => {
    const held = picks.findIndex((existing) => fills(existing, pick));
    if (held === -1) return [...picks, pick];

    return picks
      .map((existing, index) => (index === held ? pick : existing))
      .filter((existing, index) => index === held || !fills(existing, pick));
  });
}

/**
 * Removes the Pick filling one slot. A slot nothing fills — or a Variant, Timetable or
 * State File that does not hold it — hands the same State back rather than a copy, so a
 * caller that saves what changed writes nothing at all.
 */
export function removePick(state: State, at: VariantRef, slot: PickSlot): State {
  const variant = variantAt(state, at);
  if (variant === undefined) return state;
  if (!variant.picks.some((pick) => fills(pick, slot))) return state;

  return inVariant(state, at, (picks) => picks.filter((pick) => !fills(pick, slot)));
}

/**
 * A Pick as the Clashes module reads a Group: its snapshot is already the shape of a
 * weekly span, so this is the whole of the translation and neither module imports the
 * other (core/src/timetable/clashes.ts).
 */
const asPickedGroup = (pick: GroupPick): PickedGroup => ({
  courseNumber: pick.courseNumber,
  lessonType: pick.lessonType,
  number: pick.groupNumber,
  meetings: pick.meetings,
});

/**
 * Every Clash among one Variant's Picks, and between them and that Semester's Blocked
 * Times. A Warning and never a refusal: this is what the app reports after an edit has
 * already gone through.
 */
export function clashesIn(state: State, at: VariantRef): MeetingClash[] {
  const variant = variantAt(state, at);
  if (variant === undefined) return [];

  return findMeetingClashes(
    variant.picks.map(asPickedGroup),
    timetableAt(state, at)?.blockedTimes ?? [],
  );
}
