import { variantAt, withVariant, type VariantRef } from "./picks.ts";
import type { GroupPick, State } from "./schema.ts";

/**
 * The Tray (#283): the Courses waiting to be scheduled in a Variant (CONTEXT.md).
 *
 * **Stored is only what cannot be derived**: the Courses a student added to the Variant
 * directly, by course number, in `Variant.tray`. The Tray a student sees is derived — that list,
 * plus every Course with a Pick in the Variant, plus every Course with a planned Attempt in the
 * Semester — so a Course on the week is never missing from the Tray, and a Course the Plan puts
 * in the Semester is there without anyone adding it (`docs/design.md`, "Grid and Picks").
 *
 * The two edits are plain `state -> state` functions beside the Pick edits (ADR-0013). Neither
 * touches an Attempt: the Plan belongs to the Plan, and the Timetable never edits it (ADR-0008).
 */

/** Why a Course is in the Tray. A Course can be there for more than one reason at once. */
export type TrayOrigin = "added" | "picked" | "planned";

/** One Lesson Type a Course needs, with the Group picked for it once there is one. */
export type TrayChip = { lessonType: string; groupNumber?: string };

/** One entry of the Tray as a student sees it. */
export type TrayEntry = {
  courseNumber: string;
  /** Every reason the Course is here, in the order added, picked, planned. */
  origins: TrayOrigin[];
  /** Whether the Catalog had an Offering for the Course, which is what the chips are read off. */
  known: boolean;
  /**
   * One chip per Lesson Type the Offering has, in the order its Groups list them, then any
   * Lesson Type picked that the Offering no longer has — a Pick on the week is never hidden.
   * For a Course the Catalog does not have, only the picked ones: what the Picks say is known,
   * what the Course needs is not.
   */
  chips: TrayChip[];
  /**
   * Every Lesson Type the Offering has is picked (`docs/design.md`, "Grid and Picks": one Pick
   * per Lesson Type, all in the same Semester — which the Variant already is). `null` for a
   * Course the Catalog does not have, because then what it needs is not known: `false` would
   * claim something is missing, and `true` that nothing is.
   */
  complete: boolean | null;
};

/**
 * What the derivation needs of an Offering: its course number and its Groups' Lesson Types and
 * numbers. A Catalog Offering satisfies it, so this module imports nothing from the Catalog.
 */
export type TrayOffering = {
  courseNumber: string;
  groups: readonly { lessonType: string; number: string }[];
};

/**
 * Which Offering a Tray entry describes, when a Semester lists more than one for the Course — a
 * Year-long and a Fall-only Offering of one Course both answer to Fall (#335).
 *
 * **The rule: the Offering the Variant's Picks of the Course belong to.** That is the first, in
 * listing order, that has a Group for every one of those Picks — the same Lesson Type and the same
 * Group number. With no Pick of the Course, or with Picks that no single Offering holds, it is the
 * first Offering listed, which is also the one whose Groups the week offers when the Course is
 * chosen, so the chips describe the Groups the student is being offered.
 *
 * Not the union of the Offerings' Lesson Types: a Lesson Type only one Offering has would be a chip
 * the student could never fill by picking within the Offering they are in.
 */
function offeringFor(
  offerings: readonly TrayOffering[] | undefined,
  courseNumber: string,
  picks: readonly GroupPick[],
): TrayOffering | undefined {
  const candidates = offerings?.filter((candidate) => candidate.courseNumber === courseNumber) ?? [];
  if (candidates.length <= 1 || picks.length === 0) return candidates[0];
  const holdsEveryPick = (offering: TrayOffering): boolean =>
    picks.every((pick) =>
      offering.groups.some(
        (group) => group.lessonType === pick.lessonType && group.number === pick.groupNumber,
      ),
    );
  return candidates.find(holdsEveryPick) ?? candidates[0];
}

/**
 * Adds a Course to a Variant's Tray, making the Timetable and the Variant if they are not there
 * yet — the way a first Pick does. A Course already in the Tray is not added twice, and the same
 * State comes back, so nothing is saved.
 */
export function addToTray(state: State, at: VariantRef, courseNumber: string): State {
  return withVariant(state, at, (variant) =>
    variant.tray.includes(courseNumber)
      ? variant
      : { ...variant, tray: [...variant.tray, courseNumber] },
  );
}

/**
 * Removes a Course from a Variant's Tray **and its Picks in that Variant**, in one edit: a
 * Course taken out of the Tray with its Groups still inked on the week would be back in the
 * derived Tray at once, because it has Picks.
 *
 * A Course in the Tray only because of a planned Attempt loses its Picks and is otherwise left:
 * the Attempt belongs to the Plan, and the Timetable never edits the Plan (ADR-0008). A Course
 * with nothing here to remove hands the same State back.
 */
export function removeFromTray(state: State, at: VariantRef, courseNumber: string): State {
  const variant = variantAt(state, at);
  if (variant === undefined) return state;
  const added = variant.tray.includes(courseNumber);
  const picked = variant.picks.some((pick) => pick.courseNumber === courseNumber);
  if (!added && !picked) return state;

  return withVariant(state, at, (held) => ({
    ...held,
    tray: held.tray.filter((entry) => entry !== courseNumber),
    picks: held.picks.filter((pick) => pick.courseNumber !== courseNumber),
  }));
}

/**
 * The Tray as shown: the Courses added, then the Courses picked, then the Courses with a planned
 * Attempt in this Academic Year and Semester, each once, with the reasons it is there and — read
 * off the Catalog's Offering when there is one — its chips and whether it is complete.
 *
 * `offerings` is the Catalog of the Semester, or `undefined` when there is none to ask; then
 * every entry is `known: false`. A Course the Semester lists more than one Offering for is read
 * off the one `offeringFor` chooses: the Offering its Picks belong to, and otherwise the first.
 */
export function trayEntries(
  state: State,
  at: VariantRef,
  offerings: readonly TrayOffering[] | undefined,
): TrayEntry[] {
  const variant = variantAt(state, at);
  const picks = variant?.picks ?? [];
  const planned = state.attempts
    .filter(
      (attempt) =>
        attempt.status === "planned" &&
        attempt.academicYear === at.academicYear &&
        attempt.semester === at.semester,
    )
    .map((attempt) => attempt.courseNumber);

  const origins = new Map<string, TrayOrigin[]>();
  const note = (courseNumber: string, origin: TrayOrigin): void => {
    const held = origins.get(courseNumber) ?? [];
    if (!held.includes(origin)) origins.set(courseNumber, [...held, origin]);
  };
  for (const courseNumber of variant?.tray ?? []) note(courseNumber, "added");
  for (const pick of picks) note(pick.courseNumber, "picked");
  for (const courseNumber of planned) note(courseNumber, "planned");

  return [...origins].map(([courseNumber, why]) => {
    const mine = picks.filter((pick) => pick.courseNumber === courseNumber);
    const offering = offeringFor(offerings, courseNumber, mine);
    const needed = [...new Set(offering?.groups.map((group) => group.lessonType) ?? [])];
    const lessonTypes = [
      ...needed,
      ...new Set(mine.map((pick) => pick.lessonType).filter((type) => !needed.includes(type))),
    ];

    const chips = lessonTypes.map((lessonType): TrayChip => {
      const chosen = mine.find((pick) => pick.lessonType === lessonType);
      return chosen === undefined ? { lessonType } : { lessonType, groupNumber: chosen.groupNumber };
    });

    return {
      courseNumber,
      origins: why,
      known: offering !== undefined,
      chips,
      complete:
        offering === undefined
          ? null
          : needed.every((lessonType) => mine.some((pick) => pick.lessonType === lessonType)),
    };
  });
}
