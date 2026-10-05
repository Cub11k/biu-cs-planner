import { describe, expect, it } from "vitest";
import {
  addAttempt,
  attemptWarnings,
  moveAttempt,
  removeAttempt,
  updateAttempt,
} from "./attempts.ts";
import { setCohort } from "./programs.ts";
import { stateSchema, type AttemptFacts, type State } from "./schema.ts";

/**
 * The Attempt edits (#290): add, update (status and grade), move (Academic Year and Semester) and
 * remove, each a plain `state -> state` function addressed by the Attempt's id; and the Warnings
 * over the Attempts, none of which refuses anything. Course numbers are invented (ADR-0006).
 */
const empty = (): State => stateSchema.parse({ schemaVersion: 1 });

/** An id source that counts, so a test can say which id an add will hand out. */
function ids(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const planned = (courseNumber: string, academicYear = 2027, semester: AttemptFacts["semester"] = "fall"): AttemptFacts => ({
  courseNumber,
  academicYear,
  semester,
  status: "planned",
});

describe("addAttempt", () => {
  it("appends an Attempt with the id the injected source gives it", () => {
    const state = addAttempt(empty(), planned("89-110"), ids());

    expect(state.attempts).toEqual([
      { id: "id-1", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "planned" },
    ]);
  });

  it("keeps a passed Attempt's grade, numeric or pass/fail", () => {
    const next = ids();
    let state = addAttempt(empty(), { ...planned("89-110"), status: "passed", grade: { kind: "numeric", value: 88 } }, next);
    state = addAttempt(state, { ...planned("89-111"), status: "passed", grade: { kind: "pass-fail", passed: true } }, next);

    expect(state.attempts.map((attempt) => attempt.grade)).toEqual([
      { kind: "numeric", value: 88 },
      { kind: "pass-fail", passed: true },
    ]);
  });

  it("adds a retake beside the failed Attempt rather than replacing it", () => {
    const next = ids();
    let state = addAttempt(empty(), { ...planned("89-110", 2026), status: "failed" }, next);
    state = addAttempt(state, planned("89-110", 2027), next);

    expect(state.attempts.map((attempt) => [attempt.id, attempt.academicYear, attempt.status])).toEqual([
      ["id-1", 2026, "failed"],
      ["id-2", 2027, "planned"],
    ]);
  });

  it("records an exemption and a credited Course as Attempts of their own status", () => {
    const next = ids();
    let state = addAttempt(empty(), { ...planned("10-001"), status: "exempt" }, next);
    state = addAttempt(state, { ...planned("89-550"), status: "credited" }, next);

    expect(state.attempts.map((attempt) => attempt.status)).toEqual(["exempt", "credited"]);
  });

  it("does not share the fields object it was handed", () => {
    const fields = planned("89-110");
    const state = addAttempt(empty(), fields, ids());
    fields.courseNumber = "changed afterwards";

    expect(state.attempts[0]?.courseNumber).toBe("89-110");
  });
});

describe("updateAttempt", () => {
  const start = () => addAttempt(addAttempt(empty(), planned("89-110"), ids()), planned("89-111"), () => "id-2");

  it("changes the status of the one Attempt its id names", () => {
    const state = updateAttempt(start(), "id-1", { status: "registered" });

    expect(state.attempts.map((attempt) => attempt.status)).toEqual(["registered", "planned"]);
  });

  it("sets a grade, keeps it across a status change, and clears it with null", () => {
    let state = updateAttempt(start(), "id-1", { status: "passed", grade: { kind: "numeric", value: 71 } });
    expect(state.attempts[0]).toMatchObject({ status: "passed", grade: { kind: "numeric", value: 71 } });

    state = updateAttempt(state, "id-1", { status: "failed" });
    expect(state.attempts[0]).toMatchObject({ status: "failed", grade: { kind: "numeric", value: 71 } });

    state = updateAttempt(state, "id-1", { grade: null });
    expect(state.attempts[0]).not.toHaveProperty("grade");
  });

  it("hands back the State it was given when nothing moves, or the id names no Attempt", () => {
    const state = start();

    expect(updateAttempt(state, "id-1", { status: "planned" })).toBe(state);
    expect(updateAttempt(state, "id-1", {})).toBe(state);
    expect(updateAttempt(state, "id-1", { grade: null })).toBe(state);
    expect(updateAttempt(state, "nobody", { status: "passed" })).toBe(state);

    const graded = updateAttempt(state, "id-1", { grade: { kind: "numeric", value: 80 } });
    expect(updateAttempt(graded, "id-1", { grade: { kind: "numeric", value: 80 } })).toBe(graded);
  });
});

describe("moveAttempt", () => {
  it("moves the one Attempt to another Semester and Academic Year, keeping its id", () => {
    const next = ids();
    let state = addAttempt(empty(), planned("89-110"), next);
    state = addAttempt(state, planned("89-111"), next);

    state = moveAttempt(state, "id-2", { academicYear: 2028, semester: "spring" });

    expect(state.attempts).toEqual([
      { id: "id-1", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "planned" },
      { id: "id-2", courseNumber: "89-111", academicYear: 2028, semester: "spring", status: "planned" },
    ]);
  });

  it("hands back the State it was given for a move to where it is, or of no Attempt", () => {
    const state = addAttempt(empty(), planned("89-110"), ids());

    expect(moveAttempt(state, "id-1", { academicYear: 2027, semester: "fall" })).toBe(state);
    expect(moveAttempt(state, "nobody", { academicYear: 2028, semester: "fall" })).toBe(state);
  });
});

describe("removeAttempt", () => {
  it("removes the one Attempt its id names, and no other of the same Course", () => {
    const next = ids();
    let state = addAttempt(empty(), { ...planned("89-110", 2026), status: "failed" }, next);
    state = addAttempt(state, planned("89-110", 2027), next);

    state = removeAttempt(state, "id-1");

    expect(state.attempts.map((attempt) => attempt.id)).toEqual(["id-2"]);
    expect(removeAttempt(state, "id-1")).toBe(state);
  });
});

it("addresses the same Attempt across a sequence of edits that move the others around it", () => {
  const next = ids();
  let state = empty();
  for (const course of ["89-110", "89-111", "89-112", "89-113"]) state = addAttempt(state, planned(course), next);

  state = removeAttempt(state, "id-1");
  state = moveAttempt(state, "id-4", { academicYear: 2026, semester: "summer" });
  state = addAttempt(state, planned("89-110"), next);
  state = updateAttempt(state, "id-3", { status: "registered" });

  expect(state.attempts.map((attempt) => [attempt.id, attempt.courseNumber, attempt.status])).toEqual([
    ["id-2", "89-111", "planned"],
    ["id-3", "89-112", "registered"],
    ["id-4", "89-113", "planned"],
    ["id-5", "89-110", "planned"],
  ]);
});

describe("attemptWarnings", () => {
  const add = (state: State, fields: AttemptFacts, id: string) => addAttempt(state, fields, () => id);

  it("is empty for a sensible Plan", () => {
    let state = add(empty(), { ...planned("89-110", 2026), status: "passed", grade: { kind: "numeric", value: 90 } }, "a");
    state = add(state, planned("89-111"), "b");

    expect(attemptWarnings(state)).toEqual([]);
  });

  it("names a second Attempt of the same Course in the same Semester, keeping both", () => {
    let state = add(empty(), planned("89-110"), "a");
    state = add(state, planned("89-110"), "b");
    state = add(state, planned("89-110", 2027, "spring"), "c");

    expect(state.attempts).toHaveLength(3);
    expect(attemptWarnings(state)).toEqual([
      {
        kind: "attempt-duplicate",
        target: { kind: "attempt", id: "b" },
        courseNumber: "89-110",
        academicYear: 2027,
        semester: "fall",
        firstId: "a",
      },
    ]);
  });

  it("names a numeric grade outside 0 to 100, at both ends, and not one on the boundary", () => {
    let state = add(empty(), { ...planned("89-110"), status: "passed", grade: { kind: "numeric", value: 101 } }, "a");
    state = add(state, { ...planned("89-111"), status: "failed", grade: { kind: "numeric", value: -1 } }, "b");
    state = add(state, { ...planned("89-112"), status: "passed", grade: { kind: "numeric", value: 100 } }, "c");
    state = add(state, { ...planned("89-113"), status: "failed", grade: { kind: "numeric", value: 0 } }, "d");

    expect(attemptWarnings(state)).toEqual([
      { kind: "grade-out-of-range", target: { kind: "attempt", id: "a" }, value: 101 },
      { kind: "grade-out-of-range", target: { kind: "attempt", id: "b" }, value: -1 },
    ]);
  });

  it("names a grade on a planned or registered Attempt, and on no other status", () => {
    const grade = { kind: "pass-fail", passed: true } as const;
    let state = add(empty(), { ...planned("89-110"), grade }, "a");
    state = add(state, { ...planned("89-111"), status: "registered", grade }, "b");
    for (const status of ["passed", "failed", "exempt", "credited"] as const) {
      state = add(state, { ...planned(`89-${status}`), status, grade }, status);
    }

    expect(attemptWarnings(state)).toEqual([
      { kind: "grade-not-completed", target: { kind: "attempt", id: "a" }, status: "planned" },
      { kind: "grade-not-completed", target: { kind: "attempt", id: "b" }, status: "registered" },
    ]);
  });

  it("names an Attempt before the Cohort's first Semester once there is a Cohort, but not an exemption or credit", () => {
    let state = add(empty(), planned("89-110", 2026, "summer"), "a");
    state = add(state, { ...planned("10-001", 2026, "spring"), status: "exempt" }, "b");
    state = add(state, { ...planned("89-550", 2025, "fall"), status: "credited" }, "c");
    state = add(state, planned("89-111", 2027, "fall"), "d");

    expect(attemptWarnings(state)).toEqual([]);

    state = setCohort(state, { academicYear: 2027, semester: "fall" });
    expect(attemptWarnings(state)).toEqual([
      {
        kind: "attempt-before-cohort",
        target: { kind: "attempt", id: "a" },
        cohort: { academicYear: 2027, semester: "fall" },
      },
    ]);
  });
});
