import { expect, it } from "vitest";
import { parseRequirementsFile } from "../requirements/file.ts";
import type { RequirementsFile } from "../requirements/schema.ts";
import { addAttempt } from "./attempts.ts";
import { stateSchema, type State } from "./schema.ts";
import { fromSuggestedLayout, suggestedLayoutOf } from "./suggested-layout.ts";

/**
 * New Plan from Suggested Layout (#293): planned Attempts created once from the department's layout,
 * placed relative to the Cohort, skipping Courses the student already has. The layout is invented
 * (ADR-0006).
 */
const CS: RequirementsFile = parseRequirementsFile({
  schemaVersion: 1,
  program: { id: "cs", name: { he: "מדעי המחשב" } },
  equivalences: [{ from: "89-109", to: "89-110" }],
  suggestedLayout: [
    { studyYear: 1, semester: "fall", courses: ["89-110", "88-101"] },
    { studyYear: 1, semester: "spring", courses: ["89-111"] },
    { studyYear: 2, semester: "fall", courses: ["89-210"] },
  ],
  tracks: [
    { id: "ai", name: { he: "בינה" }, suggestedLayout: [{ studyYear: 3, semester: "spring", courses: ["89-391"] }] },
  ],
}).file!;

const empty = (): State => stateSchema.parse({ schemaVersion: 1 });
const fallCohort = { academicYear: 2027, semester: "fall" } as const;

function counting(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

it("creates a planned Attempt for every Course of the layout, placed relative to a Fall Cohort", () => {
  const { state, summary } = fromSuggestedLayout(empty(), CS, undefined, fallCohort, counting());

  expect(state.attempts).toEqual([
    { id: "id-1", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "planned" },
    { id: "id-2", courseNumber: "88-101", academicYear: 2027, semester: "fall", status: "planned" },
    { id: "id-3", courseNumber: "89-111", academicYear: 2027, semester: "spring", status: "planned" },
    { id: "id-4", courseNumber: "89-210", academicYear: 2028, semester: "fall", status: "planned" },
  ]);
  expect(summary).toEqual({
    created: [
      { id: "id-1", courseNumber: "89-110", academicYear: 2027, semester: "fall" },
      { id: "id-2", courseNumber: "88-101", academicYear: 2027, semester: "fall" },
      { id: "id-3", courseNumber: "89-111", academicYear: 2027, semester: "spring" },
      { id: "id-4", courseNumber: "89-210", academicYear: 2028, semester: "fall" },
    ],
    skipped: [],
  });
});

it("shifts the layout for a Spring Cohort by the tested study-point rule", () => {
  const { state } = fromSuggestedLayout(empty(), CS, undefined, { academicYear: 2027, semester: "spring" }, counting());

  expect(state.attempts.map((a) => [a.courseNumber, a.academicYear, a.semester])).toEqual([
    ["89-110", 2028, "fall"],
    ["88-101", 2028, "fall"],
    ["89-111", 2027, "spring"],
    ["89-210", 2029, "fall"],
  ]);
});

it("includes the chosen Track's entries after the base rule set's, and only the chosen Track's", () => {
  const withTrack = fromSuggestedLayout(empty(), CS, "ai", fallCohort, counting());
  const unknownTrack = fromSuggestedLayout(empty(), CS, "robotics", fallCohort, counting());

  expect(withTrack.state.attempts.at(-1)).toEqual({
    id: "id-5",
    courseNumber: "89-391",
    academicYear: 2029,
    semester: "spring",
    status: "planned",
  });
  expect(unknownTrack.state.attempts.map((a) => a.courseNumber)).not.toContain("89-391");
  expect(suggestedLayoutOf(CS, "ai")).toHaveLength(4);
  expect(suggestedLayoutOf(CS, undefined)).toHaveLength(3);
});

it("skips a Course the student already has an Attempt of, whatever its status, and via an Equivalence", () => {
  let state = addAttempt(empty(), { courseNumber: "89-109", academicYear: 2026, semester: "fall", status: "failed" }, () => "old-1");
  state = addAttempt(state, { courseNumber: "89-111", academicYear: 2027, semester: "summer", status: "planned" }, () => "old-2");

  const { state: next, summary } = fromSuggestedLayout(state, CS, undefined, fallCohort, counting());

  expect(next.attempts.map((a) => a.courseNumber)).toEqual(["89-109", "89-111", "88-101", "89-210"]);
  expect(summary.skipped).toEqual([
    { courseNumber: "89-110", reason: "attempted" },
    { courseNumber: "89-111", reason: "attempted" },
  ]);
});

it("creates a Course the layout lists twice once, and says it skipped the second", () => {
  const twice = parseRequirementsFile({
    schemaVersion: 1,
    program: { id: "cs", name: { he: "מדעי המחשב" } },
    suggestedLayout: [
      { studyYear: 1, semester: "fall", courses: ["89-110"] },
      { studyYear: 1, semester: "spring", courses: ["89-110"] },
    ],
  }).file!;

  const { state, summary } = fromSuggestedLayout(empty(), twice, undefined, fallCohort, counting());

  expect(state.attempts).toHaveLength(1);
  expect(summary.skipped).toEqual([{ courseNumber: "89-110", reason: "listed-twice" }]);
});

it("creates nothing a second time, handing back the State it was given", () => {
  const first = fromSuggestedLayout(empty(), CS, undefined, fallCohort, counting());

  const second = fromSuggestedLayout(first.state, CS, undefined, fallCohort, counting());

  expect(second.state).toBe(first.state);
  expect(second.summary.created).toEqual([]);
  expect(second.summary.skipped).toHaveLength(4);
});

it("creates nothing from a file with no Suggested Layout", () => {
  const bare = parseRequirementsFile({ schemaVersion: 1, program: { id: "cs", name: { he: "x" } } }).file!;
  const state = empty();

  const result = fromSuggestedLayout(state, bare, undefined, fallCohort, counting());

  expect(result.state).toBe(state);
  expect(result.summary).toEqual({ created: [], skipped: [] });
  expect(suggestedLayoutOf(bare, undefined)).toEqual([]);
});

it("creates both halves of a Year-long Course, Fall and Spring of the year its entry falls in", () => {
  const yearLong = parseRequirementsFile({
    schemaVersion: 1,
    program: { id: "cs", name: { he: "מדעי המחשב" } },
    courses: [{ number: "89-120", credits: 8, offeringPattern: "year-long" }],
    suggestedLayout: [{ studyYear: 2, semester: "fall", courses: ["89-120"] }],
  }).file!;

  const { state, summary } = fromSuggestedLayout(empty(), yearLong, undefined, fallCohort, counting());

  expect(state.attempts.map((a) => [a.id, a.courseNumber, a.academicYear, a.semester])).toEqual([
    ["id-1", "89-120", 2028, "fall"],
    ["id-2", "89-120", 2028, "spring"],
  ]);
  expect(summary.created).toHaveLength(2);
});
