import { DEFAULT_VARIANT_NAME, type VariantRef } from "./picks.ts";
import type { State, Timetable, Variant } from "./schema.ts";
import { timetableAt, variantNamed, withTimetable, type TimetableAt } from "./timetable.ts";

/**
 * The Variant edits: create, duplicate, rename, delete and make primary (#281).
 *
 * Each is a plain `state -> state` function beside the Pick edits, and `app` hands each to the
 * guarded writer with its own label, so each is one undo step (ADR-0013). None of them refuses
 * anything. A name that collides with another Variant's is written and reported by
 * `variantWarnings`, because every domain check is a Warning and an edit always goes through
 * (docs/design.md, "API and data rules").
 *
 * **A Variant is addressed by its name**, as `VariantRef` already has it. Two Variants sharing a
 * name is the collision `variantWarnings` names, and while it lasts the name addresses the
 * first of them in file order — the same one `variantAt` reads — so every edit agrees with
 * every read about which Variant a tab means.
 *
 * **Exactly one primary**, kept by the edits rather than only checked: making one primary
 * clears the flag on every other Variant of the Timetable in the same edit, and deleting the
 * primary promotes the first remaining one. A file that already breaks the rule — hand edited —
 * is repaired by the first of those, and the second never makes a breach worse.
 */

/** What `variantWarnings` reports about one Semester's Variants. */
export type VariantWarning =
  /** Two or more Variants of one Timetable carry this name, so it addresses the first. */
  | { kind: "variant-name-not-unique"; name: string }
  /** A Timetable with Variants should have exactly one primary; this one has `primaries`. */
  | { kind: "primary-variant-not-unique"; primaries: number };

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * A name no Variant of this Timetable has yet: the first free letter, then the letters again
 * with a number after them.
 *
 * A letter rather than a translated word, for the reason `DEFAULT_VARIANT_NAME` gives: a
 * Variant's name is the student's own text, written into their file, and a name that arrived
 * from the UI language would read as the wrong language the moment they switched. It is what a
 * duplicated or a new Variant is called until the student names it.
 */
export function freeVariantName(state: State, at: TimetableAt): string {
  const taken = new Set(timetableAt(state, at)?.variants.map((variant) => variant.name));
  for (let round = 1; ; round++) {
    const suffix = round === 1 ? "" : String(round);
    for (const letter of LETTERS) {
      if (!taken.has(`${letter}${suffix}`)) return `${letter}${suffix}`;
    }
  }
}

/**
 * Which Variant a read is about: the one named, while it exists; otherwise the primary;
 * otherwise the first; and `DEFAULT_VARIANT_NAME` for a Timetable with none, which is the name
 * a first Pick creates.
 *
 * A name that no longer exists falls back rather than reading as an empty Variant, so a tab
 * another window deleted shows the student their primary rather than a week with nothing on it
 * that no file holds.
 */
export function resolveVariantName(
  state: State,
  at: TimetableAt,
  requested: string | undefined,
): string {
  const timetable = timetableAt(state, at);
  if (requested !== undefined && variantNamed(timetable, requested) !== undefined) {
    return requested;
  }
  const variants = timetable?.variants ?? [];
  return (variants.find((variant) => variant.primary) ?? variants[0])?.name ?? DEFAULT_VARIANT_NAME;
}

/**
 * Rewrites the Variant list of one Timetable. A rewrite handing back the list it was given
 * changes nothing, and the same State comes back (`withTimetable`).
 */
const withVariants = (
  state: State,
  at: TimetableAt,
  rewrite: (variants: Variant[], timetable: Timetable) => Variant[],
): State =>
  withTimetable(state, at, (timetable) => {
    const variants = rewrite(timetable.variants, timetable);
    return variants === timetable.variants ? timetable : { ...timetable, variants };
  });

/**
 * Creates an empty Variant with this name, making the Timetable if the Semester has none yet,
 * the way a first Pick does. It is primary only when it is the Timetable's first.
 *
 * A name already in use is created anyway, and `variantWarnings` names the collision.
 */
export function createVariant(state: State, at: VariantRef): State {
  return withVariants(state, at, (variants) => [
    ...variants,
    { name: at.variant, primary: variants.length === 0, picks: [], tray: [] },
  ]);
}

/**
 * Copies a Variant under a new name, right after the one it was copied from. Everything the
 * Variant holds is copied — its Picks, snapshots included, and its Tray (#283) — so the copy
 * starts as the same week and the same working set, and changing one never changes the other. The copy is never primary: the student
 * registers with one Variant, and duplicating it is how they try something else.
 */
export function duplicateVariant(state: State, from: VariantRef, name: string): State {
  return withVariants(state, from, (variants, timetable) => {
    const source = variantNamed(timetable, from.variant);
    if (source === undefined) return variants;

    const copy: Variant = { ...source, name, primary: false };
    const index = variants.indexOf(source);
    return [...variants.slice(0, index + 1), copy, ...variants.slice(index + 1)];
  });
}

/** Renames a Variant where it stands. A name already in use is a Warning, not a refusal. */
export function renameVariant(state: State, at: VariantRef, name: string): State {
  return withVariants(state, at, (variants, timetable) => {
    const held = variantNamed(timetable, at.variant);
    if (held === undefined || held.name === name) return variants;

    return variants.map((variant) => (variant === held ? { ...variant, name } : variant));
  });
}

/**
 * Deletes a Variant. Deleting the primary promotes the first remaining Variant in file order,
 * so a Timetable with Variants always has one — unless another one is already primary, which a
 * hand-edited file can say, and then nobody is promoted rather than a third being added to the
 * breach. Deleting the last Variant leaves a Timetable with none, which is a valid file: its
 * Blocked Times stay, and the next Pick makes a Variant again.
 */
export function deleteVariant(state: State, at: VariantRef): State {
  return withVariants(state, at, (variants, timetable) => {
    const held = variantNamed(timetable, at.variant);
    if (held === undefined) return variants;

    const remaining = variants.filter((variant) => variant !== held);
    const promote = held.primary && remaining.length > 0 && !remaining.some((v) => v.primary);
    return promote
      ? remaining.map((variant, index) => (index === 0 ? { ...variant, primary: true } : variant))
      : remaining;
  });
}

/**
 * Makes one Variant the primary and every other Variant of its Timetable not, in one edit — so
 * nothing the student does can leave the file saying two Variants are primary. Hands the same
 * State back when that is already exactly so.
 */
export function setPrimaryVariant(state: State, at: VariantRef): State {
  return withVariants(state, at, (variants, timetable) => {
    const held = variantNamed(timetable, at.variant);
    if (held === undefined) return variants;
    if (variants.every((variant) => variant.primary === (variant === held))) return variants;

    return variants.map((variant) =>
      variant.primary === (variant === held) ? variant : { ...variant, primary: variant === held },
    );
  });
}

/**
 * What is wrong with one Semester's Variants as they stand: a name two of them share, and a
 * Timetable whose Variants do not have exactly one primary.
 *
 * Computed from a State rather than read off the file, so it describes the file **after** an
 * edit: an edit's answer carries the Warnings of the file it read, and a collision the edit has
 * just made is not among those. `parseStateFile` still reports a broken primary as it reads, for
 * whoever reads a whole file; this is the Timetable screen's account of the Timetable it shows.
 */
export function variantWarnings(state: State, at: TimetableAt): VariantWarning[] {
  const variants = timetableAt(state, at)?.variants ?? [];
  const warnings: VariantWarning[] = [];

  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const variant of variants) {
    if (seen.has(variant.name) && !reported.has(variant.name)) {
      warnings.push({ kind: "variant-name-not-unique", name: variant.name });
      reported.add(variant.name);
    }
    seen.add(variant.name);
  }

  const primaries = variants.filter((variant) => variant.primary).length;
  if (variants.length > 0 && primaries !== 1) {
    warnings.push({ kind: "primary-variant-not-unique", primaries });
  }
  return warnings;
}
