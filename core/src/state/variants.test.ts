import { describe, expect, it } from "vitest";
import { DEFAULT_VARIANT_NAME, recordPick } from "./picks.ts";
import { stateSchema, type GroupPick, type State } from "./schema.ts";
import {
  createVariant,
  deleteVariant,
  duplicateVariant,
  freeVariantName,
  renameVariant,
  resolveVariant,
  resolveVariantName,
  setPrimaryVariant,
  variantPosition,
  variantWarnings,
} from "./variants.ts";

/**
 * Variants as a student edits them: created, duplicated, renamed, deleted and made primary.
 * Each is a pure `state -> state` edit beside the Pick edits (ADR-0013).
 *
 * Fixture data is invented. 89-110 is a real BIU course number, the Meetings are not, and no
 * crawled data is committed to this repo (ADR-0006).
 */
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const at = (variant: string) => ({ ...FALL_2027, variant });

const empty = (): State => stateSchema.parse({ schemaVersion: 1 });

const LECTURE: GroupPick = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

/** The Variants of the Fall Timetable as `[name, primary]` pairs, in file order. */
const tabs = (state: State) =>
  state.timetables[0]?.variants.map((variant) => [variant.name, variant.primary]);

/** A Timetable holding A (primary, with a Pick), B and C. */
function threeVariants(): State {
  let state = recordPick(empty(), at("A"), LECTURE);
  state = createVariant(state, at("B"));
  return createVariant(state, at("C"));
}

it("creates an empty Variant, making the Timetable that holds it", () => {
  const state = createVariant(empty(), at("Sunday off"));

  expect(state.timetables).toEqual([
    {
      ...FALL_2027,
      blockedTimes: [],
      variants: [{ name: "Sunday off", primary: true, picks: [], tray: [] }],
    },
  ]);
});

it("makes a created Variant primary only when it is the Timetable's first", () => {
  expect(tabs(threeVariants())).toEqual([
    ["A", true],
    ["B", false],
    ["C", false],
  ]);
});

it("creates a Variant whose name is already taken, and warns about the collision", () => {
  const state = createVariant(threeVariants(), at("B"));

  // a Warning and not a refusal: the edit goes through and the name is the student's to fix
  expect(tabs(state)).toEqual([
    ["A", true],
    ["B", false],
    ["C", false],
    ["B", false],
  ]);
  expect(variantWarnings(state, FALL_2027)).toEqual([
    { kind: "variant-name-not-unique", name: "B" },
  ]);
});

it("names a new Variant with the first free letter, never a translated word", () => {
  expect(freeVariantName(empty(), FALL_2027)).toBe(DEFAULT_VARIANT_NAME);
  expect(freeVariantName(threeVariants(), FALL_2027)).toBe("D");

  // a gap left by a deleted Variant is filled before the alphabet moves on
  expect(freeVariantName(deleteVariant(threeVariants(), at("B")), FALL_2027)).toBe("B");
});

it("still finds a free name once every letter is taken", () => {
  let state = empty();
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") state = createVariant(state, at(letter));

  expect(freeVariantName(state, FALL_2027)).toBe("A2");
});

it("duplicates a Variant with its Picks, right after it and not primary", () => {
  const state = duplicateVariant(threeVariants(), at("A"), "A copy");

  expect(tabs(state)).toEqual([
    ["A", true],
    ["A copy", false],
    ["B", false],
    ["C", false],
  ]);
  // the snapshot travels with the Pick: the copy is the same week, not a reference to it
  expect(state.timetables[0]?.variants[1]?.picks).toEqual([LECTURE]);
});

it("leaves the original untouched when the copy is changed", () => {
  const copied = duplicateVariant(threeVariants(), at("A"), "A copy");
  const changed = recordPick(copied, at("A copy"), { ...LECTURE, groupNumber: "02" });

  expect(changed.timetables[0]?.variants[0]?.picks).toEqual([LECTURE]);
});

it("duplicates nothing when the Variant is not there", () => {
  const state = threeVariants();

  expect(duplicateVariant(state, at("Z"), "Z copy")).toBe(state);
});

it("renames a Variant in place", () => {
  const state = renameVariant(threeVariants(), at("B"), "Sunday off");

  expect(tabs(state)).toEqual([
    ["A", true],
    ["Sunday off", false],
    ["C", false],
  ]);
});

it("renames into a collision, and warns about it", () => {
  const state = renameVariant(threeVariants(), at("B"), "C");

  expect(tabs(state)).toEqual([
    ["A", true],
    ["C", false],
    ["C", false],
  ]);
  expect(variantWarnings(state, FALL_2027)).toEqual([
    { kind: "variant-name-not-unique", name: "C" },
  ]);
});

it("hands the same State back for a rename that changes nothing", () => {
  const state = threeVariants();

  expect(renameVariant(state, at("B"), "B")).toBe(state);
  expect(renameVariant(state, at("Z"), "Y")).toBe(state);
});

it("marks a Variant primary and unmarks the previous primary in the same edit", () => {
  const state = setPrimaryVariant(threeVariants(), at("C"));

  expect(tabs(state)).toEqual([
    ["A", false],
    ["B", false],
    ["C", true],
  ]);
});

it("repairs a file with two primaries when one is marked", () => {
  const twoPrimaries = setPrimaryVariant(threeVariants(), at("B"));
  const broken: State = {
    ...twoPrimaries,
    timetables: twoPrimaries.timetables.map((timetable) => ({
      ...timetable,
      variants: timetable.variants.map((variant) =>
        variant.name === "A" ? { ...variant, primary: true } : variant,
      ),
    })),
  };
  expect(variantWarnings(broken, FALL_2027)).toEqual([
    { kind: "primary-variant-not-unique", primaries: 2 },
  ]);

  const repaired = setPrimaryVariant(broken, at("B"));

  expect(tabs(repaired)).toEqual([
    ["A", false],
    ["B", true],
    ["C", false],
  ]);
  expect(variantWarnings(repaired, FALL_2027)).toEqual([]);
});

it("hands the same State back when the Variant is already the only primary, or not there", () => {
  const state = threeVariants();

  expect(setPrimaryVariant(state, at("A"))).toBe(state);
  expect(setPrimaryVariant(state, at("Z"))).toBe(state);
});

it("deletes a Variant", () => {
  expect(tabs(deleteVariant(threeVariants(), at("B")))).toEqual([
    ["A", true],
    ["C", false],
  ]);
});

it("promotes the first remaining Variant when the primary is deleted", () => {
  const state = setPrimaryVariant(threeVariants(), at("B"));

  expect(tabs(deleteVariant(state, at("B")))).toEqual([
    ["A", true],
    ["C", false],
  ]);
});

it("promotes nobody when another Variant is still primary", () => {
  // a hand-edited file with two primaries: deleting one leaves the other, and making a third
  // primary as well would be writing the breach rather than repairing it
  const state = threeVariants();
  const broken: State = {
    ...state,
    timetables: state.timetables.map((timetable) => ({
      ...timetable,
      variants: timetable.variants.map((variant) =>
        variant.name === "C" ? { ...variant, primary: true } : variant,
      ),
    })),
  };

  expect(tabs(deleteVariant(broken, at("A")))).toEqual([
    ["B", false],
    ["C", true],
  ]);
});

it("leaves a Timetable with no Variants when the last one is deleted", () => {
  const state = deleteVariant(createVariant(empty(), at("A")), at("A"));

  expect(state.timetables).toEqual([{ ...FALL_2027, variants: [], blockedTimes: [] }]);
  expect(variantWarnings(state, FALL_2027)).toEqual([]);
});

it("deletes only the first of two Variants sharing a name", () => {
  const state = createVariant(threeVariants(), at("B"));

  expect(tabs(deleteVariant(state, at("B")))).toEqual([
    ["A", true],
    ["C", false],
    ["B", false],
  ]);
});

it("hands the same State back when deleting a Variant that is not there", () => {
  const state = threeVariants();

  expect(deleteVariant(state, at("Z"))).toBe(state);
  expect(deleteVariant(empty(), at("A")).timetables).toEqual([]);
});

it("resolves no name to the primary Variant, and a missing name to it too", () => {
  const state = setPrimaryVariant(threeVariants(), at("B"));

  expect(resolveVariantName(state, FALL_2027, undefined)).toBe("B");
  expect(resolveVariantName(state, FALL_2027, "C")).toBe("C");
  expect(resolveVariantName(state, FALL_2027, "gone")).toBe("B");
});

it("resolves to the first Variant when none is primary, and to the default when there are none", () => {
  const state = threeVariants();
  const noPrimary: State = {
    ...state,
    timetables: state.timetables.map((timetable) => ({
      ...timetable,
      variants: timetable.variants.map((variant) => ({ ...variant, primary: false })),
    })),
  };

  expect(resolveVariantName(noPrimary, FALL_2027, undefined)).toBe("A");
  expect(resolveVariantName(empty(), FALL_2027, undefined)).toBe(DEFAULT_VARIANT_NAME);
  expect(resolveVariantName(empty(), FALL_2027, "B")).toBe(DEFAULT_VARIANT_NAME);
});

it("warns about nothing for a Timetable that is not there", () => {
  expect(variantWarnings(empty(), FALL_2027)).toEqual([]);
});

it("warns about a Timetable whose Variants have no primary", () => {
  const state = threeVariants();
  const noPrimary: State = {
    ...state,
    timetables: state.timetables.map((timetable) => ({
      ...timetable,
      variants: timetable.variants.map((variant) => ({ ...variant, primary: false })),
    })),
  };

  expect(variantWarnings(noPrimary, FALL_2027)).toEqual([
    { kind: "primary-variant-not-unique", primaries: 0 },
  ]);
});

/**
 * #322: two Variants of one name, which is a Warning and never a refusal, are both reachable. A
 * `VariantRef` may carry the Variant's position in file order, and every edit and read honours it
 * while the Variant there carries the name. Without one, the name reaches the first, as before.
 */
describe("two Variants sharing a name", () => {
  /** A (primary, with lecture 01) then a second A, made by renaming B into the taken name. */
  const collided = (): State => renameVariant(createVariant(recordPick(empty(), at("A"), LECTURE), at("B")), at("B"), "A");
  const second = { ...at("A"), position: 1 };

  it("is made by a rename into a taken name, with its Warning", () => {
    const state = collided();
    expect(tabs(state)).toEqual([
      ["A", true],
      ["A", false],
    ]);
    expect(variantWarnings(state, FALL_2027)).toEqual([{ kind: "variant-name-not-unique", name: "A" }]);
  });

  it("reaches the second by its position, for a read and for every edit", () => {
    const state = collided();

    expect(resolveVariant(state, FALL_2027, "A", 1)).toEqual({ variant: "A", position: 1 });
    expect(variantPosition(state, second)).toBe(1);

    const picked = recordPick(state, second, { ...LECTURE, groupNumber: "02" });
    expect(picked.timetables[0]?.variants.map((v) => v.picks.map((p) => p.groupNumber))).toEqual([
      ["01"],
      ["02"],
    ]);

    expect(tabs(renameVariant(state, second, "C"))).toEqual([
      ["A", true],
      ["C", false],
    ]);
    expect(tabs(setPrimaryVariant(state, second))).toEqual([
      ["A", false],
      ["A", true],
    ]);
    expect(deleteVariant(state, second).timetables[0]?.variants.map((v) => v.picks.length)).toEqual([1]);
    expect(duplicateVariant(state, second, "D").timetables[0]?.variants.map((v) => v.name)).toEqual([
      "A",
      "A",
      "D",
    ]);
  });

  it("reaches the first by the name alone, as every caller that sends no position did", () => {
    const state = collided();

    expect(resolveVariant(state, FALL_2027, "A")).toEqual({ variant: "A", position: 0 });
    expect(resolveVariantName(state, FALL_2027, "A")).toBe("A");
    expect(tabs(renameVariant(state, at("A"), "C"))).toEqual([
      ["C", true],
      ["A", false],
    ]);
  });

  it("falls back to the name when the position names another Variant", () => {
    const state = createVariant(collided(), at("Z"));

    // position 2 is Z, not an A, so the position does not count and the first A is reached
    expect(variantPosition(state, { ...at("A"), position: 2 })).toBe(0);
    expect(variantPosition(state, { ...at("A"), position: 9 })).toBe(0);
    expect(variantPosition(state, at("nothing"))).toBeUndefined();
  });
});
