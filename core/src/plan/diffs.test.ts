import { expect, it } from "vitest";
import { recordPick } from "../state/picks.ts";
import { stateSchema, type Attempt, type GroupPick, type State } from "../state/schema.ts";
import { addToTray } from "../state/tray.ts";
import { createVariant } from "../state/variants.ts";
import {
  applyPlanDiff,
  findPlanDiff,
  isActionable,
  planDiffs,
  type PlanDiffContext,
  type PlanDiffOffering,
} from "./diffs.ts";

/**
 * Plan Diffs (#295): the divergences between one Variant and the Plan's planned Attempts in its
 * Semester, read against this year's Catalog, and the "apply to Plan" edit each actionable one has.
 * Then "mark registered" with and without "apply all" (#297).
 *
 * Fixture data is invented. 89-110, 89-210, 89-230 and 89-385 are real BIU course numbers; which
 * Semester each is given in here is not, and no crawled data is committed to this repo (ADR-0006).
 */
const FALL = { academicYear: 2027, semester: "fall", variant: "A" } as const;
const SPRING = { ...FALL, semester: "spring" } as const;

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

const offering = (courseNumber: string, ...semesters: PlanDiffOffering["semesters"]): PlanDiffOffering => ({
  courseNumber,
  semesters,
});

/** 89-110 and 89-210 in Fall, 89-230 in Spring, 89-385 Year-long. */
const CATALOG: PlanDiffContext = {
  offerings: [
    offering("89-110", "fall"),
    offering("89-210", "fall"),
    offering("89-230", "spring"),
    offering("89-385", "fall", "spring"),
  ],
};

let ids = 0;
const newId = () => `new-${++ids}`;

it("offers to add a Course the Variant holds and the Plan does not", () => {
  const state = recordPick(withAttempts(empty(), [{ courseNumber: "89-110" }]), FALL, pick("89-210"));

  expect(planDiffs(state, FALL, CATALOG)).toEqual([
    // 89-110, planned and not in the Variant, is the other direction; the Plan's side is listed first
    { kind: "drop", courseNumber: "89-110", academicYear: 2027, semester: "fall", attemptIds: ["a1"] },
    { kind: "add", courseNumber: "89-210", academicYear: 2027, semester: "fall", semesters: ["fall"] },
  ]);
});

it("counts a Course added to the Tray as in the Variant, as much as a picked one", () => {
  const state = addToTray(withAttempts(empty(), [{ courseNumber: "89-110" }]), FALL, "89-110");

  expect(planDiffs(state, FALL, CATALOG)).toEqual([]);
});

it("offers to drop a planned Attempt the Variant does not hold", () => {
  const state = createVariant(withAttempts(empty(), [{ courseNumber: "89-210" }]), FALL);

  expect(planDiffs(state, FALL, CATALOG)).toEqual([
    { kind: "drop", courseNumber: "89-210", academicYear: 2027, semester: "fall", attemptIds: ["a1"] },
  ]);
});

it("offers to move a planned Course this year's Catalog has in the other Semester", () => {
  const state = withAttempts(empty(), [{ courseNumber: "89-230" }]);

  expect(planDiffs(state, FALL, CATALOG)).toEqual([
    { kind: "move", courseNumber: "89-230", academicYear: 2027, semester: "fall", to: "spring", attemptIds: ["a1"] },
  ]);
});

it("moves rather than drops, even when the Variant holds the Course", () => {
  const state = addToTray(withAttempts(empty(), [{ courseNumber: "89-230" }]), FALL, "89-230");

  expect(planDiffs(state, FALL, CATALOG).map((diff) => diff.kind)).toEqual(["move"]);
});

it("reports a planned Course not in this year's Catalog at all, with nothing to apply", () => {
  const state = addToTray(withAttempts(empty(), [{ courseNumber: "89-999" }]), FALL, "89-999");
  const diffs = planDiffs(state, FALL, CATALOG);

  expect(diffs).toEqual([
    { kind: "not-offered", courseNumber: "89-999", academicYear: 2027, semester: "fall", attemptIds: ["a1"] },
  ]);
  expect(diffs.filter(isActionable)).toEqual([]);
  expect(applyPlanDiff(state, diffs[0]!, newId)).toBe(state);
});

it("never offers to add a Course the Catalog does not give in the Semester", () => {
  const state = recordPick(
    addToTray(withAttempts(empty(), [{ courseNumber: "89-110" }]), FALL, "89-110"),
    FALL,
    pick("89-230"),
  );

  expect(planDiffs(addToTray(state, FALL, "89-999"), FALL, CATALOG)).toEqual([]);
  // without a Catalog nothing says it is not given here, and it is an add
  expect(planDiffs(state, FALL, { offerings: undefined }).map((d) => [d.kind, d.courseNumber])).toEqual([
    ["add", "89-230"],
  ]);
});

it("reads an Offering that lists no Semester as not offered, never as a move to nowhere", () => {
  const state = withAttempts(empty(), [{ courseNumber: "89-110" }]);

  expect(planDiffs(state, FALL, { offerings: [offering("89-110")] }).map((d) => d.kind)).toEqual(["not-offered"]);
});

it("reports only adds and drops without a Catalog, since nothing can say what is offered", () => {
  const state = recordPick(
    withAttempts(empty(), [{ courseNumber: "89-230" }, { courseNumber: "89-999" }]),
    FALL,
    pick("89-210"),
  );

  expect(planDiffs(state, FALL, { offerings: undefined }).map((diff) => [diff.kind, diff.courseNumber])).toEqual([
    ["drop", "89-230"],
    ["drop", "89-999"],
    ["add", "89-210"],
  ]);
});

it("produces no Plan Diffs at all for a student with no planned Attempt in the year", () => {
  const history = withAttempts(empty(), [
    { courseNumber: "89-110", status: "passed" },
    { courseNumber: "89-230", status: "registered" },
    // planned, but in another Academic Year
    { courseNumber: "89-210", academicYear: 2028 },
  ]);
  const state = recordPick(addToTray(history, FALL, "89-999"), FALL, pick("89-385"));

  expect(planDiffs(state, FALL, CATALOG)).toEqual([]);
});

it("never diffs an Attempt that is history: registered, passed or anything else but planned", () => {
  const state = createVariant(
    withAttempts(empty(), [
      { courseNumber: "89-210" },
      { courseNumber: "89-110", status: "registered" },
      { courseNumber: "89-230", status: "failed" },
      { courseNumber: "89-999", status: "passed" },
    ]),
    FALL,
  );

  expect(planDiffs(state, FALL, CATALOG).map((diff) => diff.courseNumber)).toEqual(["89-210"]);
});

it("does not offer to add a Course the Plan already holds in the Semester under another status", () => {
  const state = recordPick(
    withAttempts(empty(), [{ courseNumber: "89-210" }, { courseNumber: "89-110", status: "registered" }]),
    FALL,
    pick("89-110"),
  );

  expect(planDiffs(state, FALL, CATALOG).map((diff) => [diff.kind, diff.courseNumber])).toEqual([
    ["drop", "89-210"],
  ]);
});

it("treats Courses an Equivalence makes one as the same Course on both sides", () => {
  // the Plan has the old number, the Catalog and the Variant the new one
  const state = recordPick(withAttempts(empty(), [{ courseNumber: "89-100" }]), FALL, pick("89-110"));
  const context = { ...CATALOG, equivalences: [{ from: "89-100", to: "89-110" }] };

  expect(planDiffs(state, FALL, context)).toEqual([]);
  // and without it, the two numbers are two Courses
  expect(planDiffs(state, FALL, CATALOG).map((diff) => diff.kind)).toEqual(["not-offered", "add"]);
});

it("follows an Equivalence chain, and reads a loop as one Course", () => {
  const state = recordPick(withAttempts(empty(), [{ courseNumber: "89-001" }]), FALL, pick("89-003"));
  const chain = { offerings: undefined, equivalences: [{ from: "89-001", to: "89-002" }, { from: "89-002", to: "89-003" }] };
  const loop = { offerings: undefined, equivalences: [{ from: "89-001", to: "89-003" }, { from: "89-003", to: "89-001" }] };

  expect(planDiffs(state, FALL, chain)).toEqual([]);
  expect(planDiffs(state, FALL, loop)).toEqual([]);
});

it("adds both halves of a Year-long Course, and only the half the Plan lacks", () => {
  const state = recordPick(withAttempts(empty(), [{ courseNumber: "89-110" }]), FALL, pick("89-385"));
  const both = planDiffs(addToTray(state, FALL, "89-110"), FALL, CATALOG);

  expect(both).toEqual([
    { kind: "add", courseNumber: "89-385", academicYear: 2027, semester: "fall", semesters: ["fall", "spring"] },
  ]);

  const springHalf = withAttempts(empty(), [{ courseNumber: "89-385", semester: "spring" }]);
  expect(planDiffs(recordPick(springHalf, FALL, pick("89-385")), FALL, CATALOG)).toEqual([
    { kind: "add", courseNumber: "89-385", academicYear: 2027, semester: "fall", semesters: ["fall"] },
  ]);
});

it("drops a Year-long Course as one unit, both planned halves, from either Semester", () => {
  const state = withAttempts(empty(), [
    { courseNumber: "89-385", semester: "fall" },
    { courseNumber: "89-385", semester: "spring" },
  ]);

  expect(planDiffs(createVariant(state, FALL), FALL, CATALOG)).toEqual([
    { kind: "drop", courseNumber: "89-385", academicYear: 2027, semester: "fall", attemptIds: ["a1", "a2"] },
  ]);
  expect(planDiffs(createVariant(state, SPRING), SPRING, CATALOG)).toEqual([
    { kind: "drop", courseNumber: "89-385", academicYear: 2027, semester: "spring", attemptIds: ["a2", "a1"] },
  ]);
});

it("never reports a Year-long half as offered elsewhere: the Course is given in both its Semesters", () => {
  const state = withAttempts(empty(), [
    { courseNumber: "89-385", semester: "fall" },
    { courseNumber: "89-385", semester: "spring" },
  ]);

  expect(planDiffs(recordPick(state, SPRING, pick("89-385")), SPRING, CATALOG)).toEqual([]);
});

it("takes a Year-long Course from the Offering Pattern when there is no Catalog to say", () => {
  const state = recordPick(withAttempts(empty(), [{ courseNumber: "89-110" }]), FALL, pick("89-385"));

  expect(planDiffs(addToTray(state, FALL, "89-110"), FALL, { offerings: undefined, yearLong: ["89-385"] })).toEqual([
    { kind: "add", courseNumber: "89-385", academicYear: 2027, semester: "fall", semesters: ["fall", "spring"] },
  ]);
});

it("finds a Plan Diff by its kind and its Course, and finds nothing once it is gone", () => {
  const state = withAttempts(empty(), [{ courseNumber: "89-230" }]);
  const diffs = planDiffs(state, FALL, CATALOG);

  expect(findPlanDiff(diffs, { kind: "move", courseNumber: "89-230" })).toBe(diffs[0]);
  expect(findPlanDiff(diffs, { kind: "drop", courseNumber: "89-230" })).toBeUndefined();
  expect(findPlanDiff(diffs, { kind: "move", courseNumber: "89-110" })).toBeUndefined();
});

/** Everything in a State but its Attempts, which an apply must leave exactly as it was. */
const allButAttempts = ({ attempts: _attempts, ...rest }: State) => rest;

it("applies an add as planned Attempts in the Variant's Semester, and touches nothing else", () => {
  const before = recordPick(withAttempts(empty(), [{ courseNumber: "89-110" }]), FALL, pick("89-385"));
  const diff = planDiffs(before, FALL, CATALOG).find((d) => d.kind === "add")!;
  ids = 0;

  const after = applyPlanDiff(before, diff, newId);

  expect(after.attempts).toEqual([
    ...before.attempts,
    { id: "new-1", courseNumber: "89-385", academicYear: 2027, semester: "fall", status: "planned" },
    { id: "new-2", courseNumber: "89-385", academicYear: 2027, semester: "spring", status: "planned" },
  ]);
  expect(allButAttempts(after)).toEqual(allButAttempts(before));
  expect(planDiffs(after, FALL, CATALOG).find((d) => d.kind === "add")).toBeUndefined();
});

it("applies a drop by removing the Attempts it names, and touches nothing else", () => {
  const before = addToTray(
    withAttempts(empty(), [
      { courseNumber: "89-385", semester: "spring" },
      { courseNumber: "89-210" },
      { courseNumber: "89-385" },
      { courseNumber: "89-210", status: "passed", academicYear: 2026 },
    ]),
    FALL,
    "89-210",
  );
  const diff = planDiffs(before, FALL, CATALOG)[0]!;

  const after = applyPlanDiff(before, diff, newId);

  expect(after.attempts.map((attempt) => attempt.id)).toEqual(["a2", "a4"]);
  expect(allButAttempts(after)).toEqual(allButAttempts(before));
});

it("applies a move by moving the Attempt to the Semester it names, and touches nothing else", () => {
  const before = addToTray(withAttempts(empty(), [{ courseNumber: "89-230", grade: undefined }]), FALL, "89-230");
  const diff = planDiffs(before, FALL, CATALOG)[0]!;

  const after = applyPlanDiff(before, diff, newId);

  expect(after.attempts).toEqual([
    { id: "a1", courseNumber: "89-230", academicYear: 2027, semester: "spring", status: "planned", grade: undefined },
  ]);
  expect(allButAttempts(after)).toEqual(allButAttempts(before));
  expect(planDiffs(after, FALL, CATALOG)).toEqual([]);
});
