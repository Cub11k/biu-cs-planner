import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attempt, Pin, Status } from "../state/schema.ts";
import { evaluateProgress, firstFitAssignment, type Progress } from "./evaluate.ts";
import { parseRequirementsFile } from "./file.ts";
import { CURRENT_REQUIREMENTS_SCHEMA_VERSION, type RequirementsFile } from "./schema.ts";
import { DEFAULT_SOLVE_LIMITS, solveAssignment, type SolveInput } from "./solve.ts";

function program(parts: Record<string, unknown>): RequirementsFile {
  const { file } = parseRequirementsFile({
    schemaVersion: CURRENT_REQUIREMENTS_SCHEMA_VERSION,
    program: { id: "p", name: { he: "תכנית" } },
    ...parts,
  });
  if (!file) throw new Error("fixture is not a Requirements File");
  return file;
}

function attempt(courseNumber: string, status: Status = "passed"): Attempt {
  return { courseNumber, academicYear: 2027, semester: "fall", status };
}

const pin = (courseNumber: string, requirementId: string): Pin => ({ courseNumber, requirementId });

function statusOf(progress: Progress, id: string, lens: "completed" | "projected" = "completed") {
  const pending = [...progress.requirements];
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (next.id === id) return next[lens].status;
    pending.push(...next.children);
  }
  throw new Error(`no node ${id}`);
}

/** Solves one Program and evaluates it with the Assignment the solver returned. */
function solveAndEvaluate(file: RequirementsFile, attempts: Attempt[], pins: Pin[] = []) {
  const solution = solveAssignment({ programs: [{ file }], attempts, pins });
  const progress = evaluateProgress({ file, attempts, assignment: solution.assignments[0]! });
  return { solution, progress };
}

/** An advanced Course fits both the AI Pool and the general electives; an intro one only the latter. */
const electives = program({
  courses: [
    { number: "89-110", credits: 3 },
    { number: "89-310", credits: 3 },
  ],
  pools: [
    { id: "all", kind: "prefix", prefix: "89-" },
    { id: "adv", kind: "prefix", prefix: "89-3" },
  ],
  requirements: [
    { id: "electives", kind: "credits", min: 3, pool: "all" },
    { id: "ai", kind: "credits", min: 3, pool: "adv" },
  ],
});
const bothCourses = [attempt("89-110"), attempt("89-310")];

it("satisfies a Requirement the naive Assignment misses", () => {
  const naive = evaluateProgress({
    file: electives,
    attempts: bothCourses,
    assignment: firstFitAssignment({ file: electives, attempts: bothCourses }),
  });
  const { solution, progress } = solveAndEvaluate(electives, bothCourses);

  expect(statusOf(naive, "ai")).toBe("missing");
  expect(statusOf(progress, "electives")).toBe("satisfied");
  expect(statusOf(progress, "ai")).toBe("satisfied");
  expect(solution.assignments[0]!.completed).toEqual([
    { courseNumber: "89-110", requirementIds: ["electives"] },
    { courseNumber: "89-310", requirementIds: ["ai"] },
  ]);
  expect(solution.stoppedEarly).toBe(false);
  expect(solution.warnings).toEqual([]);
});

it("counts a Course once among siblings by default", () => {
  const { solution } = solveAndEvaluate(electives, [attempt("89-310")]);

  expect(solution.assignments[0]!.completed).toEqual([
    { courseNumber: "89-310", requirementIds: ["electives"] },
  ]);
});

it("counts a Course toward both where the file allows double counting", () => {
  const sharing = program({
    ...electives,
    doubleCounting: { within: [{ requirements: ["electives", "ai"] }] },
  });

  const { solution, progress } = solveAndEvaluate(sharing, [attempt("89-310")]);

  expect(solution.assignments[0]!.completed).toEqual([
    { courseNumber: "89-310", requirementIds: ["electives", "ai"] },
  ]);
  expect(statusOf(progress, "electives")).toBe("satisfied");
  expect(statusOf(progress, "ai")).toBe("satisfied");
});

describe("Pins", () => {
  it("keeps a pinned Course where it is pinned, even where the solver would not put it", () => {
    const { solution, progress } = solveAndEvaluate(electives, bothCourses, [
      pin("89-310", "electives"),
    ]);

    expect(solution.assignments[0]!.completed).toContainEqual({
      courseNumber: "89-310",
      requirementIds: ["electives"],
    });
    expect(statusOf(progress, "ai")).toBe("missing");
    expect(solution.warnings).toEqual([]);
  });

  it("reaches a Course through an Equivalence", () => {
    const renumbered = program({ ...electives, equivalences: [{ from: "89-309", to: "89-310" }] });

    const { solution } = solveAndEvaluate(renumbered, [attempt("89-110"), attempt("89-309")], [
      pin("89-309", "electives"),
    ]);

    expect(solution.assignments[0]!.completed).toContainEqual({
      courseNumber: "89-310",
      requirementIds: ["electives"],
    });
  });

  it("drops a Pin to a Requirement that no longer exists, with a Warning, and solves the rest", () => {
    const { solution, progress } = solveAndEvaluate(electives, bothCourses, [
      pin("89-310", "ai-old"),
    ]);

    expect(solution.warnings).toEqual([
      { kind: "pin-requirement-unknown", courseNumber: "89-310", requirementId: "ai-old" },
    ]);
    expect(statusOf(progress, "ai")).toBe("satisfied");
    expect(statusOf(progress, "electives")).toBe("satisfied");
  });

  it("drops a Pin to a Requirement the Course cannot count toward, with a Warning", () => {
    const { solution, progress } = solveAndEvaluate(electives, bothCourses, [pin("89-110", "ai")]);

    expect(solution.warnings).toEqual([
      { kind: "pin-not-accepted", courseNumber: "89-110", requirementId: "ai" },
    ]);
    expect(statusOf(progress, "ai")).toBe("satisfied");
    expect(statusOf(progress, "electives")).toBe("satisfied");
  });

  it("drops the second of two Pins that would count one Course twice, with a Warning", () => {
    const { solution } = solveAndEvaluate(electives, bothCourses, [
      pin("89-310", "electives"),
      pin("89-310", "ai"),
    ]);

    // Pins are taken in order of Requirement id, so which one survives does not depend on the
    // order the State File lists them in.
    expect(solution.warnings).toEqual([
      { kind: "pin-conflict", courseNumber: "89-310", requirementId: "electives" },
    ]);
    expect(solution.assignments[0]!.completed).toContainEqual({
      courseNumber: "89-310",
      requirementIds: ["ai"],
    });
  });

  it("keeps a Pin for a Course with no Attempt dormant, without a Warning", () => {
    const { solution } = solveAndEvaluate(electives, [attempt("89-110")], [pin("89-310", "ai")]);

    expect(solution.warnings).toEqual([]);
    expect(solution.assignments[0]!.completed).toEqual([
      { courseNumber: "89-110", requirementIds: ["electives"] },
    ]);
  });
});

it("spends a Course a cap would cut where it still counts", () => {
  const file = program({
    courses: [
      { number: "89-200", credits: 2 },
      { number: "89-501", credits: 2 },
      { number: "89-502", credits: 2 },
    ],
    pools: [
      { id: "all", kind: "prefix", prefix: "89-" },
      { id: "seminars", kind: "prefix", prefix: "89-5" },
    ],
    requirements: [
      {
        id: "block",
        kind: "allOf",
        of: [
          { id: "electives", kind: "credits", min: 4, pool: "all" },
          { id: "seminar-cap", kind: "cap", max: 2, pool: "seminars" },
        ],
      },
      { id: "seminar", kind: "credits", min: 2, pool: "seminars" },
    ],
  });
  const attempts = ["89-200", "89-501", "89-502"].map((c) => attempt(c));

  const { progress } = solveAndEvaluate(file, attempts);

  expect(statusOf(progress, "electives")).toBe("satisfied");
  expect(statusOf(progress, "seminar")).toBe("satisfied");
});

it("leaves a Course off where an exclusive would let it take another's place", () => {
  // 88-101 and 88-102 overlap, so only one of them counts anywhere below the root, and the one
  // kept is the first met in tree order. Placing 88-101 on "math" would keep it and take
  // 88-102 off "calculus"; leaving it off lets both Requirements be met.
  const file = program({
    courses: [
      { number: "88-101", credits: 5 },
      { number: "88-102", credits: 5 },
      { number: "88-200", credits: 5 },
    ],
    pools: [{ id: "math", kind: "list", courses: ["88-101", "88-200"] }],
    requirements: [
      { id: "math", kind: "credits", min: 5, pool: "math" },
      { id: "calculus", kind: "course", course: "88-102" },
      { id: "overlap", kind: "exclusive", courses: ["88-101", "88-102"] },
    ],
  });
  const attempts = [attempt("88-101"), attempt("88-102"), attempt("88-200")];

  const { progress, solution } = solveAndEvaluate(file, attempts);

  expect(statusOf(progress, "math")).toBe("satisfied");
  expect(statusOf(progress, "calculus")).toBe("satisfied");
  expect(solution.assignments[0]!.completed).toEqual([
    { courseNumber: "88-102", requirementIds: ["calculus"] },
    { courseNumber: "88-200", requirementIds: ["math"] },
  ]);
});

it("breaks a tie toward credits that are progress on a credits Requirement rather than surplus", () => {
  const file = program({
    courses: [
      { number: "89-301", credits: 3 },
      { number: "89-302", credits: 3 },
    ],
    pools: [{ id: "all", kind: "prefix", prefix: "89-" }],
    requirements: [
      { id: "small", kind: "credits", min: 3, pool: "all" },
      { id: "large", kind: "credits", min: 10, pool: "all" },
    ],
  });

  const { solution, progress } = solveAndEvaluate(file, [attempt("89-301"), attempt("89-302")]);

  // First-fit puts both on "small", which meets it with 3 credits of surplus. Either Course on
  // "large" meets "small" just the same and is 3 credits of progress there instead.
  expect(statusOf(progress, "small")).toBe("satisfied");
  expect(statusOf(progress, "large")).toBe("partial");
  expect(
    solution.assignments[0]!.completed.map((placement) => placement.requirementIds).sort(),
  ).toEqual([["large"], ["small"]]);
});

it("finds a sensible Assignment for each lens on its own", () => {
  // Today 89-310 is the only way to meet "ai-or-core"; once 89-211 is planned, that is met
  // by 89-211 and 89-310 is better spent completing the electives with 89-320.
  const file = program({
    courses: [
      { number: "89-211", credits: 3 },
      { number: "89-310", credits: 3 },
      { number: "89-320", credits: 3 },
    ],
    pools: [
      { id: "adv", kind: "prefix", prefix: "89-3" },
      { id: "core", kind: "list", courses: ["89-211", "89-310"] },
    ],
    requirements: [
      { id: "ai-or-core", kind: "credits", min: 3, pool: "core" },
      { id: "electives", kind: "credits", min: 6, pool: "adv" },
    ],
  });
  const attempts = [attempt("89-310"), attempt("89-211", "planned"), attempt("89-320", "planned")];

  const { solution, progress } = solveAndEvaluate(file, attempts);

  expect(solution.assignments[0]!.completed).toEqual([
    { courseNumber: "89-310", requirementIds: ["ai-or-core"] },
  ]);
  expect(statusOf(progress, "ai-or-core", "completed")).toBe("satisfied");
  expect(statusOf(progress, "ai-or-core", "projected")).toBe("satisfied");
  expect(statusOf(progress, "electives", "projected")).toBe("satisfied");
});

describe("a double major", () => {
  const cs = program({
    program: { id: "cs", name: { he: "מדמ״ח" } },
    courses: [
      { number: "88-101", credits: 5 },
      { number: "88-200", credits: 5 },
    ],
    pools: [{ id: "math", kind: "prefix", prefix: "88-" }],
    requirements: [{ id: "math-electives", kind: "credits", min: 5, pool: "math" }],
  });
  const math = program({
    program: { id: "math", name: { he: "מתמטיקה" } },
    courses: [{ number: "88-101", credits: 5 }],
    requirements: [{ id: "calculus", kind: "course", course: "88-101" }],
  });
  const attempts = [attempt("88-101"), attempt("88-200")];

  it("counts a Course in one Program only by default, choosing where it satisfies the most", () => {
    const solution = solveAssignment({ programs: [{ file: cs }, { file: math }], attempts });

    expect(solution.assignments.map((a) => a.completed)).toEqual([
      [{ courseNumber: "88-200", requirementIds: ["math-electives"] }],
      [{ courseNumber: "88-101", requirementIds: ["calculus"] }],
    ]);
  });

  it("counts it in both where both files allow it across Programs", () => {
    const allowing = (file: RequirementsFile) =>
      program({ ...file, doubleCounting: { within: [], acrossPrograms: {} } });
    const lone = [attempt("88-101")];

    const both = solveAssignment({
      programs: [{ file: allowing(cs) }, { file: allowing(math) }],
      attempts: lone,
    });
    const one = solveAssignment({
      programs: [{ file: allowing(cs) }, { file: math }],
      attempts: lone,
    });

    expect(both.assignments.map((a) => a.completed)).toEqual([
      [{ courseNumber: "88-101", requirementIds: ["math-electives"] }],
      [{ courseNumber: "88-101", requirementIds: ["calculus"] }],
    ]);
    expect(one.assignments.flatMap((a) => a.completed)).toHaveLength(1);
  });

  it("holds a cross-Program permission to its Pool", () => {
    const limited = (file: RequirementsFile) =>
      program({
        ...file,
        pools: [...file.pools, { id: "none", kind: "list", courses: [] }],
        doubleCounting: { within: [], acrossPrograms: { pool: "none" } },
      });

    const solution = solveAssignment({
      programs: [{ file: limited(cs) }, { file: limited(math) }],
      attempts: [attempt("88-101")],
    });

    expect(solution.assignments.flatMap((a) => a.completed)).toHaveLength(1);
  });

  it("applies a Pin in whichever Program has the Requirement", () => {
    const solution = solveAssignment({
      programs: [{ file: cs }, { file: math }],
      attempts,
      pins: [pin("88-101", "math-electives")],
    });

    expect(solution.assignments[0]!.completed).toContainEqual({
      courseNumber: "88-101",
      requirementIds: ["math-electives"],
    });
    expect(solution.assignments[1]!.completed).toEqual([]);
  });
});

it("warns about a Track a Program does not have", () => {
  const solution = solveAssignment({ programs: [{ file: electives, track: "ai" }], attempts: [] });

  expect(solution.warnings).toEqual([{ kind: "track-unknown", program: "p", track: "ai" }]);
});

it("gives the same Assignment for the same inputs, whatever order they are listed in", () => {
  const file = program({
    courses: ["89-110", "89-111", "89-210", "89-310", "89-320", "89-330"].map((number) => ({
      number,
      credits: 3,
    })),
    pools: [
      { id: "all", kind: "prefix", prefix: "89-" },
      { id: "adv", kind: "prefix", prefix: "89-3" },
    ],
    requirements: [
      { id: "a", kind: "credits", min: 6, pool: "all" },
      { id: "b", kind: "credits", min: 6, pool: "adv" },
      { id: "c", kind: "nOf", n: 1, of: [{ id: "c1", kind: "course", course: "89-210" }] },
    ],
  });
  const attempts = ["89-110", "89-111", "89-210", "89-310", "89-320", "89-330"].map((c) =>
    attempt(c),
  );
  const pins = [pin("89-320", "b"), pin("89-110", "a"), pin("89-320", "a")];

  const first = solveAssignment({ programs: [{ file }], attempts, pins });
  for (let shuffle = 0; shuffle < 5; shuffle++) {
    const rotated = [...attempts.slice(shuffle), ...attempts.slice(0, shuffle)].reverse();
    const again = solveAssignment({
      programs: [{ file }],
      attempts: rotated,
      pins: shuffle % 2 ? [...pins].reverse() : pins,
    });
    expect(again).toEqual(first);
  }
});

describe("limits", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Many interchangeable Courses and Requirements: a search far larger than one iteration. */
  function wide() {
    const numbers = Array.from({ length: 12 }, (_, i) => `89-${300 + i}`);
    const file = program({
      courses: numbers.map((number) => ({ number, credits: 2 })),
      pools: [{ id: "adv", kind: "prefix", prefix: "89-3" }],
      requirements: Array.from({ length: 6 }, (_, i) => ({
        id: `r${i}`,
        kind: "credits",
        min: 4 + i,
        pool: "adv",
      })),
    });
    return { file, attempts: numbers.map((c) => attempt(c)) };
  }

  it("stops at the iteration cap, says so, and still returns an Assignment", () => {
    const { file, attempts } = wide();

    const solution = solveAssignment({
      programs: [{ file }],
      attempts,
      limits: { maxIterations: 1 },
    });

    expect(solution.stoppedEarly).toBe(true);
    expect(solution.assignments[0]!.completed).toHaveLength(12);
  });

  it("stops at the time cap, read only through the clock it is given", () => {
    const { file, attempts } = wide();
    const dateNow = vi.spyOn(Date, "now");
    const performanceNow = vi.spyOn(performance, "now");
    let time = 0;
    const now = () => (time += 100);

    const solution = solveAssignment({
      programs: [{ file }],
      attempts,
      limits: { maxMillis: 250, maxIterations: 1_000_000, now },
    });

    expect(solution.stoppedEarly).toBe(true);
    expect(time).toBeLessThan(1_000);
    expect(solution.assignments[0]!.completed).toHaveLength(12);
    expect(dateNow).not.toHaveBeenCalled();
    expect(performanceNow).not.toHaveBeenCalled();
  });

  it("does not stop early when the search finishes inside its limits", () => {
    const now = () => 0;

    const solution = solveAssignment({
      programs: [{ file: electives }],
      attempts: bothCourses,
      limits: { now },
    });

    expect(solution.stoppedEarly).toBe(false);
  });

  it("has a default iteration cap, and no time cap without a clock", () => {
    expect(DEFAULT_SOLVE_LIMITS).toEqual({ maxIterations: 20_000, maxMillis: 250 });

    const { file, attempts } = wide();
    const input: SolveInput = { programs: [{ file }], attempts };
    const solution = solveAssignment(input);

    expect(solution.assignments[0]!.completed).toHaveLength(12);
  });
});
