import { expect, it } from "vitest";
import { clashesIn, DEFAULT_VARIANT_NAME, recordPick, removePick, variantAt } from "./picks.ts";
import type { Day } from "../catalog/schema.ts";
import { stateSchema, type GroupPick, type State } from "./schema.ts";

/**
 * Recording and removing a Pick: the first edit the app can make, and a pure one.
 *
 * Fixture data is invented. 89-110 and 89-210 are real BIU course numbers, the Meetings
 * are not, and no crawled data is committed to this repo (ADR-0006).
 */
const FALL_2027 = { academicYear: 2027, semester: "fall", variant: DEFAULT_VARIANT_NAME } as const;

const empty = (): State => stateSchema.parse({ schemaVersion: 1 });

const pick = (
  courseNumber: string,
  lessonType: string,
  groupNumber: string,
  meetings: ReadonlyArray<[Day, string, string]> = [],
): GroupPick => ({
  courseNumber,
  lessonType,
  groupNumber,
  meetings: meetings.map(([day, start, end]) => ({ semester: "fall" as const, day, start, end })),
});

const LECTURE = pick("89-110", "הרצאה", "01", [["tuesday", "15:00", "18:00"]]);
const OTHER_LECTURE = pick("89-110", "הרצאה", "02", [["sunday", "10:00", "12:00"]]);
const TIRGUL = pick("89-110", "תרגיל", "03", [["tuesday", "18:00", "20:00"]]);
/** Overlaps LECTURE on Tuesday afternoon, so picking both is a Clash. */
const CLASHING = pick("89-210", "הרצאה", "01", [["tuesday", "16:00", "17:00"]]);

it("records a Pick, making the Timetable and the Variant that hold it", () => {
  const state = recordPick(empty(), FALL_2027, LECTURE);

  expect(state.timetables).toEqual([
    {
      academicYear: 2027,
      semester: "fall",
      blockedTimes: [],
      variants: [{ name: DEFAULT_VARIANT_NAME, primary: true, picks: [LECTURE] }],
    },
  ]);
});

it("keeps the snapshot of the Group's Meetings as they stood", () => {
  const state = recordPick(empty(), FALL_2027, LECTURE);

  // the snapshot is the point: a re-import compares it against the new Catalog to show
  // "changed since picked" (core/src/state/schema.ts), so a Group reference alone loses it
  expect(variantAt(state, FALL_2027)?.picks[0]?.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
  ]);
});

it("makes only the first Variant of a Timetable the primary one", () => {
  const first = recordPick(empty(), FALL_2027, LECTURE);
  const second = recordPick(first, { ...FALL_2027, variant: "B" }, OTHER_LECTURE);

  expect(second.timetables[0]?.variants.map((v) => [v.name, v.primary])).toEqual([
    [DEFAULT_VARIANT_NAME, true],
    ["B", false],
  ]);
});

it("replaces the Pick for a Lesson Type already picked, in the place it held", () => {
  const before = recordPick(recordPick(empty(), FALL_2027, LECTURE), FALL_2027, TIRGUL);
  const after = recordPick(before, FALL_2027, OTHER_LECTURE);

  // one Pick per Lesson Type per Offering: the second Group replaces the first rather
  // than joining it, and the Tirgul picked after it keeps its place
  expect(variantAt(after, FALL_2027)?.picks).toEqual([OTHER_LECTURE, TIRGUL]);
});

it("keeps one Pick per Lesson Type, so two Lesson Types of one Course are two Picks", () => {
  const state = recordPick(recordPick(empty(), FALL_2027, LECTURE), FALL_2027, TIRGUL);

  expect(variantAt(state, FALL_2027)?.picks).toEqual([LECTURE, TIRGUL]);
});

it("collapses Picks a hand-edited file left duplicated for one Lesson Type", () => {
  // `parseStateFile` keeps both and warns `pick-not-unique`; recording over the slot is
  // what resolves it, and leaving the second behind would leave the Warning standing
  const doubled = stateSchema.parse({
    schemaVersion: 1,
    timetables: [
      {
        academicYear: 2027,
        semester: "fall",
        variants: [{ name: DEFAULT_VARIANT_NAME, primary: true, picks: [LECTURE, TIRGUL, LECTURE] }],
      },
    ],
  });

  const state = recordPick(doubled, FALL_2027, OTHER_LECTURE);

  expect(variantAt(state, FALL_2027)?.picks).toEqual([OTHER_LECTURE, TIRGUL]);
});

it("changes nothing the caller handed it", () => {
  const before = empty();
  const frozen = JSON.stringify(before);

  recordPick(before, FALL_2027, LECTURE);

  expect(JSON.stringify(before)).toBe(frozen);
});

it("leaves the other Semester's Timetable alone", () => {
  const fall = recordPick(empty(), FALL_2027, LECTURE);
  const both = recordPick(fall, { ...FALL_2027, semester: "spring" }, TIRGUL);

  expect(both.timetables.map((t) => t.semester)).toEqual(["fall", "spring"]);
  expect(variantAt(both, FALL_2027)?.picks).toEqual([LECTURE]);
});

it("records a Pick that Clashes and reports the Clash rather than refusing it", () => {
  const state = recordPick(recordPick(empty(), FALL_2027, LECTURE), FALL_2027, CLASHING);

  expect(variantAt(state, FALL_2027)?.picks).toHaveLength(2);
  const clashes = clashesIn(state, FALL_2027);
  expect(clashes).toHaveLength(1);
  expect(clashes[0]).toMatchObject({
    kind: "meeting-meeting",
    overlap: { day: "tuesday", start: "16:00", end: "17:00" },
  });
});

it("reports a Pick that Clashes with a Blocked Time", () => {
  const blocked = stateSchema.parse({
    schemaVersion: 1,
    timetables: [
      {
        academicYear: 2027,
        semester: "fall",
        blockedTimes: [
          { semester: "fall", day: "tuesday", start: "16:00", end: "20:00", label: "work" },
        ],
      },
    ],
  });

  const clashes = clashesIn(recordPick(blocked, FALL_2027, LECTURE), FALL_2027);

  expect(clashes).toHaveLength(1);
  expect(clashes[0]?.kind).toBe("meeting-blocked-time");
});

it("finds no Clash in a Variant that is not there", () => {
  expect(clashesIn(empty(), FALL_2027)).toEqual([]);
  expect(variantAt(empty(), FALL_2027)).toBeUndefined();
});

it("removes one Pick and leaves the rest", () => {
  const both = recordPick(recordPick(empty(), FALL_2027, LECTURE), FALL_2027, TIRGUL);

  const after = removePick(both, FALL_2027, { courseNumber: "89-110", lessonType: "הרצאה" });

  expect(variantAt(after, FALL_2027)?.picks).toEqual([TIRGUL]);
});

it("hands back the same State when there is nothing to remove", () => {
  const state = recordPick(empty(), FALL_2027, LECTURE);
  const slot = { courseNumber: "89-110", lessonType: "הרצאה" };
  const blank = empty();

  // identity, not equality: the caller saves only what changed, so a removal that
  // removed nothing must not be written back over a file
  expect(removePick(state, FALL_2027, { courseNumber: "89-210", lessonType: "הרצאה" })).toBe(state);
  expect(removePick(state, { ...FALL_2027, variant: "B" }, slot)).toBe(state);
  expect(removePick(state, { ...FALL_2027, semester: "summer" }, slot)).toBe(state);
  expect(removePick(blank, FALL_2027, slot)).toBe(blank);
});
