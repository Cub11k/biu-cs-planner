import { expect, it } from "vitest";
import { recordPick } from "../state/picks.ts";
import { stateSchema, type Attempt, type GroupPick, type State } from "../state/schema.ts";
import { addToTray } from "../state/tray.ts";
import { createVariant } from "../state/variants.ts";
import { planDiffsDigest, type PlanDiffContext } from "./diffs.ts";
import { markRegistered, registrationPreview, unmarkRegistered } from "./registration.ts";

/**
 * Marking a Variant registered (#297): the flags, and with "apply all" every actionable Plan Diff
 * and the registered statuses, in one `state -> state` edit; the preview of exactly that; and
 * unmarking, which touches nothing but the flag.
 *
 * Fixture data is invented. 89-110, 89-210, 89-230 and 89-385 are real BIU course numbers; which
 * Semester each is given in here is not, and no crawled data is committed to this repo (ADR-0006).
 */
const FALL = { academicYear: 2027, semester: "fall", variant: "A" } as const;

const empty = (): State => stateSchema.parse({ schemaVersion: 1 });

const pick = (courseNumber: string): GroupPick => ({
  courseNumber,
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "sunday", start: "10:00", end: "12:00" }],
});

type Planned = Partial<Attempt> & Pick<Attempt, "courseNumber">;

/** The State with these Attempts, each named `a<n>` and planned in Fall 2027 unless it says otherwise. */
const withAttempts = (state: State, attempts: Planned[]): State => ({
  ...state,
  attempts: attempts.map((attempt, index) => ({
    id: `a${index + 1}`,
    academicYear: 2027,
    semester: "fall",
    status: "planned",
    ...attempt,
  })),
});

/** 89-110 and 89-210 in Fall, 89-230 in Spring, 89-385 Year-long. */
const CATALOG: PlanDiffContext = {
  offerings: [
    { courseNumber: "89-110", semesters: ["fall"] },
    { courseNumber: "89-210", semesters: ["fall"] },
    { courseNumber: "89-230", semesters: ["spring"] },
    { courseNumber: "89-385", semesters: ["fall", "spring"] },
  ],
};

let ids = 0;
const newId = () => `new-${++ids}`;

/** A Fall Plan with one of each kind, and a Variant B holding 89-110 and 89-210. */
function registration(): State {
  const plan = withAttempts(empty(), [
    { courseNumber: "89-110" },
    { courseNumber: "89-385" }, // not in the Variant: drop, with its Spring half
    { courseNumber: "89-385", semester: "spring" },
    { courseNumber: "89-230" }, // offered in Spring: move
    { courseNumber: "89-999" }, // not offered: left alone
    { courseNumber: "89-500", semester: "spring" }, // another Semester: untouched
  ]);
  const a = createVariant(plan, FALL);
  const b = { ...FALL, variant: "B" };
  return recordPick(addToTray(addToTray(createVariant(a, b), b, "89-999"), b, "89-110"), b, pick("89-210"));
}

const B = { ...FALL, variant: "B" } as const;

it("marks a Variant registered and primary, clearing both on its siblings, and leaves the Plan", () => {
  const before = registration();

  const after = markRegistered(before, B, { applyDiffs: false, context: CATALOG, newId });

  expect(after.timetables[0]?.variants.map((v) => [v.name, v.primary, v.registered])).toEqual([
    ["A", false, undefined],
    ["B", true, true],
  ]);
  expect(after.attempts).toBe(before.attempts);
  // and marking another one moves both flags to it
  const moved = markRegistered(after, FALL, { applyDiffs: false, context: CATALOG, newId });
  expect(moved.timetables[0]?.variants.map((v) => [v.name, v.primary, v.registered])).toEqual([
    ["A", true, true],
    ["B", false, undefined],
  ]);
});

it("hands the same State back when the Variant is already the registered primary", () => {
  const once = markRegistered(registration(), B, { applyDiffs: false, context: CATALOG, newId });

  expect(markRegistered(once, B, { applyDiffs: false, context: CATALOG, newId })).toBe(once);
});

it("with apply all, applies every actionable Plan Diff and registers what the Variant holds", () => {
  ids = 0;
  const after = markRegistered(registration(), B, { applyDiffs: true, context: CATALOG, newId });

  expect(after.attempts.map((a) => [a.id, a.courseNumber, a.semester, a.status])).toEqual([
    ["a1", "89-110", "fall", "registered"],
    // 89-385's two halves dropped; 89-230 moved and still planned, now in Spring
    ["a4", "89-230", "spring", "planned"],
    // in the Variant, but not offered: listed and never applied, so left exactly as it was
    ["a5", "89-999", "fall", "planned"],
    ["a6", "89-500", "spring", "planned"],
    ["new-1", "89-210", "fall", "registered"],
  ]);
  expect(after.timetables[0]?.variants[1]).toMatchObject({ name: "B", primary: true, registered: true });
});

it("previews exactly what apply all would do, before anything is written", () => {
  const before = registration();

  const preview = registrationPreview(before, B, CATALOG);

  expect(preview.planDiffs.map((diff) => [diff.kind, diff.courseNumber])).toEqual([
    ["drop", "89-385"],
    ["move", "89-230"],
    ["not-offered", "89-999"],
    ["add", "89-210"],
  ]);
  expect(preview.registers).toEqual(["89-110", "89-210"]);
  expect(registrationPreview(before, B, CATALOG)).toEqual(preview);
  // the digest is of the list shown, which "apply all" carries back (#355)
  expect(preview.digest).toBe(planDiffsDigest(preview.planDiffs));
});

it("unmarks the registered Variant and nothing else: it stays primary and the Plan stays", () => {
  const marked = markRegistered(registration(), B, { applyDiffs: true, context: CATALOG, newId });

  const after = unmarkRegistered(marked, B);

  expect(after.timetables[0]?.variants[1]).toEqual({ ...marked.timetables[0]!.variants[1], registered: undefined });
  expect("registered" in after.timetables[0]!.variants[1]!).toBe(false);
  expect(after.timetables[0]?.variants[1]?.primary).toBe(true);
  expect(after.attempts).toBe(marked.attempts);
  expect(unmarkRegistered(after, B)).toBe(after);
});
