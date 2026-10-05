import { describe, expect, it } from "vitest";
import type { Attempt, Grade, Status } from "../state/schema.ts";
import {
  evaluateProgress,
  firstFitAssignment,
  type Assignment,
  type EvaluatedRequirement,
  type Progress,
} from "./evaluate.ts";
import { parseRequirementsFile } from "./file.ts";
import { CURRENT_REQUIREMENTS_SCHEMA_VERSION, type RequirementsFile } from "./schema.ts";

/** A small Requirements File written for the test, read through the real reader. */
function program(parts: Record<string, unknown>): RequirementsFile {
  const { file } = parseRequirementsFile({
    schemaVersion: CURRENT_REQUIREMENTS_SCHEMA_VERSION,
    program: { id: "p", name: { he: "תכנית" } },
    ...parts,
  });
  if (!file) throw new Error("fixture is not a Requirements File");
  return file;
}

function attempt(
  courseNumber: string,
  status: Status,
  options: { grade?: Grade; academicYear?: number; semester?: Attempt["semester"] } = {},
): Attempt {
  const { grade, academicYear = 2027, semester = "fall" } = options;
  return { courseNumber, academicYear, semester, status, ...(grade ? { grade } : {}) };
}

const numeric = (value: number): Grade => ({ kind: "numeric", value });

/** Courses with credits, so tests can name them without repeating the table. */
const COURSES = [
  { number: "89-110", credits: 5 },
  { number: "89-111", credits: 4 },
  { number: "89-210", credits: 4 },
  { number: "89-211", credits: 3 },
  { number: "89-310", credits: 3 },
  { number: "89-320", credits: 3 },
  { number: "89-330", credits: 2 },
  { number: "89-501", credits: 2 },
  { number: "89-502", credits: 2 },
  { number: "89-503", credits: 2 },
];

/** Evaluates with the first-fit Assignment, the strategy this ticket tests on its own. */
function evaluate(
  file: RequirementsFile,
  attempts: Attempt[],
  options: { track?: string; ticked?: string[] } = {},
): Progress {
  const assignment = firstFitAssignment({ file, attempts, ...pickTrack(options.track) });
  return evaluateProgress({ file, attempts, assignment, ...pickTrack(options.track), ...(options.ticked ? { ticked: options.ticked } : {}) });
}

function pickTrack(track: string | undefined): { track?: string } {
  return track === undefined ? {} : { track };
}

/** The evaluated node with this id, wherever it sits in the tree. */
function node(progress: Progress, id: string): EvaluatedRequirement {
  const pending = [...progress.requirements];
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (next.id === id) return next;
    pending.push(...next.children);
  }
  throw new Error(`no node ${id}`);
}

describe("course", () => {
  const file = program({
    courses: COURSES,
    requirements: [{ id: "intro", kind: "course", course: "89-110" }],
  });

  it("is satisfied by a passed Attempt of its Course, and names the Course", () => {
    const progress = evaluate(file, [attempt("89-110", "passed")]);

    expect(node(progress, "intro").completed).toEqual({ status: "satisfied", courses: ["89-110"] });
    expect(progress.status.completed).toBe("satisfied");
  });

  it("is missing without one", () => {
    const progress = evaluate(file, []);

    expect(node(progress, "intro").completed).toEqual({ status: "missing", courses: [] });
    expect(progress.status.completed).toBe("missing");
  });
});

describe("Attempt statuses and grades", () => {
  const file = program({
    courses: COURSES,
    policies: { passingGrade: 60 },
    requirements: [{ id: "intro", kind: "course", course: "89-110" }],
  });
  const statusOf = (attempts: Attempt[]) => node(evaluate(file, attempts), "intro").completed.status;

  it("counts passed, exempt and credited Attempts as completed", () => {
    expect(statusOf([attempt("89-110", "passed")])).toBe("satisfied");
    expect(statusOf([attempt("89-110", "exempt")])).toBe("satisfied");
    expect(statusOf([attempt("89-110", "credited")])).toBe("satisfied");
  });

  it("does not count a failed Attempt", () => {
    expect(statusOf([attempt("89-110", "failed")])).toBe("missing");
  });

  it("treats a numeric grade below the file's passing grade as not passed", () => {
    expect(statusOf([attempt("89-110", "passed", { grade: numeric(59) })])).toBe("missing");
    expect(statusOf([attempt("89-110", "passed", { grade: numeric(60) })])).toBe("satisfied");
  });

  it("reads the passing grade from the file rather than assuming one", () => {
    const strict = program({
      courses: COURSES,
      policies: { passingGrade: 70 },
      requirements: [{ id: "intro", kind: "course", course: "89-110" }],
    });
    const progress = evaluate(strict, [attempt("89-110", "passed", { grade: numeric(65) })]);

    expect(node(progress, "intro").completed.status).toBe("missing");
  });

  it("treats a failing pass/fail grade as not passed", () => {
    const failing: Grade = { kind: "pass-fail", passed: false };
    const passing: Grade = { kind: "pass-fail", passed: true };

    expect(statusOf([attempt("89-110", "passed", { grade: failing })])).toBe("missing");
    expect(statusOf([attempt("89-110", "passed", { grade: passing })])).toBe("satisfied");
  });

  it("counts the retake that passed after a failed first try", () => {
    const attempts = [
      attempt("89-110", "failed", { academicYear: 2026 }),
      attempt("89-110", "passed", { academicYear: 2027 }),
    ];

    expect(statusOf(attempts)).toBe("satisfied");
    expect(statusOf([...attempts].reverse())).toBe("satisfied");
  });
});

describe("the best-or-latest policy", () => {
  const withPolicy = (gradeAttempt: "best" | "latest") =>
    program({
      courses: COURSES,
      policies: { passingGrade: 60, gradeAttempt },
      requirements: [{ id: "intro", kind: "course", course: "89-110" }],
    });
  // Passed in Fall, then a Spring retake to improve the grade went below the passing grade.
  const improvedWorse = [
    attempt("89-110", "passed", { grade: numeric(70), semester: "fall" }),
    attempt("89-110", "passed", { grade: numeric(50), semester: "spring" }),
  ];

  it("best: any passing Attempt completes the Course", () => {
    const progress = evaluate(withPolicy("best"), improvedWorse);

    expect(node(progress, "intro").completed.status).toBe("satisfied");
  });

  it("latest: the most recent decided Attempt decides, by year and then Semester", () => {
    expect(node(evaluate(withPolicy("latest"), improvedWorse), "intro").completed.status).toBe(
      "missing",
    );
    expect(
      node(evaluate(withPolicy("latest"), [...improvedWorse].reverse()), "intro").completed.status,
    ).toBe("missing");

    const passedLater = [
      attempt("89-110", "failed", { academicYear: 2027, semester: "summer" }),
      attempt("89-110", "passed", { academicYear: 2028, semester: "fall" }),
    ];
    expect(node(evaluate(withPolicy("latest"), passedLater), "intro").completed.status).toBe(
      "satisfied",
    );
  });

  it("latest: a planned Attempt does not decide, so the decided one before it still counts", () => {
    const attempts = [
      attempt("89-110", "passed", { academicYear: 2027 }),
      attempt("89-110", "planned", { academicYear: 2028 }),
    ];

    expect(node(evaluate(withPolicy("latest"), attempts), "intro").completed.status).toBe(
      "satisfied",
    );
  });
});

describe("the completed and projected lenses", () => {
  const file = program({
    courses: COURSES,
    requirements: [
      { id: "intro", kind: "course", course: "89-110" },
      { id: "ds", kind: "course", course: "89-111" },
      { id: "algo", kind: "course", course: "89-210" },
    ],
  });

  it("counts planned and registered Attempts only in the projected lens", () => {
    const progress = evaluate(file, [
      attempt("89-110", "passed"),
      attempt("89-111", "registered"),
      attempt("89-210", "planned"),
    ]);

    expect(node(progress, "ds").completed.status).toBe("missing");
    expect(node(progress, "ds").projected.status).toBe("satisfied");
    expect(node(progress, "algo").completed.status).toBe("missing");
    expect(node(progress, "algo").projected.status).toBe("satisfied");
    expect(progress.status).toEqual({ completed: "partial", projected: "satisfied" });
  });

  it("projects a planned retake of a failed Course", () => {
    const progress = evaluate(file, [
      attempt("89-110", "failed", { academicYear: 2027 }),
      attempt("89-110", "planned", { academicYear: 2028 }),
    ]);

    expect(node(progress, "intro").completed.status).toBe("missing");
    expect(node(progress, "intro").projected.status).toBe("satisfied");
  });
});

describe("allOf and nOf", () => {
  const file = program({
    courses: COURSES,
    requirements: [
      {
        id: "core",
        kind: "allOf",
        of: [
          { id: "intro", kind: "course", course: "89-110" },
          { id: "ds", kind: "course", course: "89-111" },
        ],
      },
      {
        id: "two-of",
        kind: "nOf",
        n: 2,
        of: [
          { id: "algo", kind: "course", course: "89-210" },
          { id: "logic", kind: "course", course: "89-211" },
          { id: "theory", kind: "course", course: "89-310" },
        ],
      },
    ],
  });

  it("allOf is satisfied, partial or missing by how many children are met", () => {
    const all = evaluate(file, [attempt("89-110", "passed"), attempt("89-111", "passed")]);
    const some = evaluate(file, [attempt("89-110", "passed")]);
    const none = evaluate(file, []);

    expect(node(all, "core").completed).toEqual({
      status: "satisfied",
      courses: ["89-110", "89-111"],
      met: { count: 2, needed: 2 },
    });
    expect(node(some, "core").completed).toEqual({
      status: "partial",
      courses: ["89-110"],
      met: { count: 1, needed: 2 },
    });
    expect(node(none, "core").completed).toEqual({
      status: "missing",
      courses: [],
      met: { count: 0, needed: 2 },
    });
  });

  it("nOf shows how many of N are met", () => {
    const enough = evaluate(file, [attempt("89-210", "passed"), attempt("89-310", "passed")]);
    const one = evaluate(file, [attempt("89-211", "passed")]);
    const none = evaluate(file, []);

    expect(node(enough, "two-of").completed).toMatchObject({
      status: "satisfied",
      met: { count: 2, needed: 2 },
    });
    expect(node(one, "two-of").completed).toMatchObject({
      status: "partial",
      met: { count: 1, needed: 2 },
    });
    expect(node(none, "two-of").completed).toMatchObject({
      status: "missing",
      met: { count: 0, needed: 2 },
    });
  });

  it("an aggregate whose only progress is a partial child is partial", () => {
    const nested = program({
      courses: COURSES,
      pools: [{ id: "adv", kind: "prefix", prefix: "89-3" }],
      requirements: [
        { id: "outer", kind: "allOf", of: [{ id: "electives", kind: "credits", min: 6, pool: "adv" }] },
      ],
    });

    const progress = evaluate(nested, [attempt("89-310", "passed")]);

    expect(node(progress, "outer").completed.status).toBe("partial");
  });

  it("an empty allOf and an nOf of zero are satisfied", () => {
    const trivial = program({
      requirements: [
        { id: "nothing", kind: "allOf", of: [] },
        { id: "zero", kind: "nOf", n: 0, of: [{ id: "x", kind: "course", course: "89-110" }] },
      ],
    });

    const progress = evaluate(trivial, []);

    expect(node(progress, "nothing").completed.status).toBe("satisfied");
    expect(node(progress, "zero").completed.status).toBe("satisfied");
  });
});

describe("credits and Pools", () => {
  it("shows credits counted against credits needed: satisfied, partial and missing", () => {
    const file = program({
      courses: COURSES,
      pools: [{ id: "adv", kind: "range", department: "89", from: 300, to: 399 }],
      requirements: [{ id: "electives", kind: "credits", min: 6, pool: "adv" }],
    });

    const done = evaluate(file, [attempt("89-310", "passed"), attempt("89-320", "passed")]);
    const half = evaluate(file, [attempt("89-310", "passed")]);
    const none = evaluate(file, [attempt("89-110", "passed")]);

    expect(node(done, "electives").completed).toEqual({
      status: "satisfied",
      courses: ["89-310", "89-320"],
      credits: { counted: 6, needed: 6 },
    });
    expect(node(half, "electives").completed).toEqual({
      status: "partial",
      courses: ["89-310"],
      credits: { counted: 3, needed: 6 },
    });
    expect(node(none, "electives").completed).toEqual({
      status: "missing",
      courses: [],
      credits: { counted: 0, needed: 6 },
    });
  });

  it("matches a range by number, not by string", () => {
    const file = program({
      courses: [
        { number: "89-150", credits: 1 },
        { number: "89-1195", credits: 1 },
        { number: "89-99", credits: 1 },
        { number: "88-150", credits: 1 },
        { number: "89-1a0", credits: 1 },
      ],
      pools: [{ id: "first", kind: "range", department: "89", from: 100, to: 199 }],
      requirements: [{ id: "c", kind: "credits", min: 10, pool: "first" }],
    });
    const attempts = ["89-150", "89-1195", "89-99", "88-150", "89-1a0"].map((c) =>
      attempt(c, "passed"),
    );

    expect(node(evaluate(file, attempts), "c").completed.courses).toEqual(["89-150"]);
  });

  it("includes both ends of a range", () => {
    const file = program({
      courses: [
        { number: "89-100", credits: 1 },
        { number: "89-199", credits: 1 },
        { number: "89-200", credits: 1 },
      ],
      pools: [{ id: "first", kind: "range", department: "89", from: 100, to: 199 }],
      requirements: [{ id: "c", kind: "credits", min: 10, pool: "first" }],
    });
    const attempts = ["89-100", "89-199", "89-200"].map((c) => attempt(c, "passed"));

    expect(node(evaluate(file, attempts), "c").completed.courses).toEqual(["89-100", "89-199"]);
  });

  it("matches a prefix as a string, and a list exactly", () => {
    const file = program({
      courses: [
        { number: "89-310", credits: 1 },
        { number: "89-3001", credits: 1 },
        { number: "89-210", credits: 1 },
        { number: "88-101", credits: 1 },
        { number: "88-1010", credits: 1 },
      ],
      pools: [
        { id: "adv", kind: "prefix", prefix: "89-3" },
        { id: "calc", kind: "list", courses: ["88-101"] },
      ],
      requirements: [
        { id: "a", kind: "credits", min: 10, pool: "adv" },
        { id: "b", kind: "credits", min: 10, pool: "calc" },
      ],
    });
    const attempts = ["89-310", "89-3001", "89-210", "88-101", "88-1010"].map((c) =>
      attempt(c, "passed"),
    );
    const progress = evaluate(file, attempts);

    expect(node(progress, "a").completed.courses).toEqual(["89-3001", "89-310"]);
    expect(node(progress, "b").completed.courses).toEqual(["88-101"]);
  });

  it("a Pool that is not defined matches nothing", () => {
    const file = program({
      courses: COURSES,
      requirements: [{ id: "c", kind: "credits", min: 3, pool: "ghost" }],
    });

    expect(node(evaluate(file, [attempt("89-310", "passed")]), "c").completed.status).toBe(
      "missing",
    );
  });
});

describe("cap", () => {
  const file = program({
    courses: COURSES,
    pools: [
      { id: "electives", kind: "prefix", prefix: "89-" },
      { id: "seminars", kind: "prefix", prefix: "89-5" },
    ],
    requirements: [
      {
        id: "elective-block",
        kind: "allOf",
        of: [
          { id: "electives", kind: "credits", min: 10, pool: "electives" },
          { id: "seminar-cap", kind: "cap", max: 3, pool: "seminars" },
        ],
      },
      { id: "outside", kind: "credits", min: 10, pool: "seminars" },
    ],
  });

  it("stops counting credits from its Pool beyond the maximum, counting a Course partly", () => {
    const attempts = ["89-501", "89-502", "89-503", "89-310"].map((c) => attempt(c, "passed"));

    const progress = evaluate(file, attempts);

    // The 3 of 89-310, which is not a seminar, and then 2 + 1 of the seminars' 6.
    expect(node(progress, "electives").completed.credits).toEqual({ counted: 6, needed: 10 });
    expect(node(progress, "seminar-cap").completed).toEqual({
      status: "satisfied",
      courses: [],
      capped: { counted: 3, max: 3, cut: 3 },
    });
  });

  it("is a limit, not a demand: never what makes its parent unmet, and not counted in met", () => {
    const progress = evaluate(file, []);

    expect(node(progress, "seminar-cap").completed.status).toBe("satisfied");
    expect(node(progress, "elective-block").completed.met).toEqual({ count: 0, needed: 1 });
  });

  it("limits only the credits Requirements under its own parent", () => {
    // The same seminars placed on a credits Requirement beside the capped block instead.
    const attempts = ["89-501", "89-502", "89-503"].map((c) => attempt(c, "passed"));
    const assignment: Assignment = {
      completed: attempts.map((a) => ({ courseNumber: a.courseNumber, requirementIds: ["outside"] })),
      projected: [],
    };

    const progress = evaluateProgress({ file, attempts, assignment });

    expect(node(progress, "outside").completed.credits).toEqual({ counted: 6, needed: 10 });
  });
});

describe("exclusive", () => {
  const file = program({
    courses: [
      { number: "88-101", credits: 5 },
      { number: "88-102", credits: 5 },
    ],
    pools: [{ id: "calc", kind: "prefix", prefix: "88-" }],
    requirements: [
      {
        id: "math",
        kind: "allOf",
        of: [
          { id: "calculus", kind: "credits", min: 10, pool: "calc" },
          { id: "overlap", kind: "exclusive", courses: ["88-101", "88-102"] },
        ],
      },
      { id: "elsewhere", kind: "credits", min: 10, pool: "calc" },
    ],
  });

  it("counts only one of the listed Courses below its parent", () => {
    const attempts = [attempt("88-102", "passed"), attempt("88-101", "passed")];

    const progress = evaluate(file, attempts);

    expect(node(progress, "calculus").completed).toMatchObject({
      courses: ["88-101"],
      credits: { counted: 5, needed: 10 },
    });
    expect(node(progress, "overlap").completed).toEqual({ status: "satisfied", courses: ["88-101"] });
  });

  it("does not reach Requirements outside its parent", () => {
    const attempts = [attempt("88-101", "passed"), attempt("88-102", "passed")];
    const assignment: Assignment = {
      completed: [
        { courseNumber: "88-101", requirementIds: ["elsewhere"] },
        { courseNumber: "88-102", requirementIds: ["elsewhere"] },
      ],
      projected: [],
    };

    const progress = evaluateProgress({ file, attempts, assignment });

    expect(node(progress, "elsewhere").completed.credits).toEqual({ counted: 10, needed: 10 });
  });
});

describe("manual", () => {
  const file = program({
    requirements: [{ id: "english", kind: "manual", text: { he: "אנגלית", en: "English" } }],
  });

  it("needs the student's tick, and carries the department's text", () => {
    const progress = evaluate(file, []);

    expect(node(progress, "english")).toMatchObject({
      kind: "manual",
      text: { he: "אנגלית", en: "English" },
      ticked: false,
      completed: { status: "missing" },
      projected: { status: "missing" },
    });
  });

  it("is satisfied in both lenses once ticked", () => {
    const progress = evaluate(file, [], { ticked: ["english"] });

    expect(node(progress, "english")).toMatchObject({
      ticked: true,
      completed: { status: "satisfied" },
      projected: { status: "satisfied" },
    });
  });
});

describe("Equivalence", () => {
  const file = program({
    courses: COURSES,
    equivalences: [
      { from: "89-109", to: "89-110" },
      { from: "89-108", to: "89-109" },
    ],
    requirements: [{ id: "intro", kind: "course", course: "89-110" }],
  });

  it("makes a renumbered Course count as the original, through a chain", () => {
    expect(node(evaluate(file, [attempt("89-109", "passed")]), "intro").completed).toEqual({
      status: "satisfied",
      courses: ["89-110"],
    });
    expect(node(evaluate(file, [attempt("89-108", "passed")]), "intro").completed.status).toBe(
      "satisfied",
    );
  });

  it("counts the old and the new number once between them", () => {
    const progress = evaluate(file, [attempt("89-109", "passed"), attempt("89-110", "passed")]);

    expect(progress.totalCredits.completed).toBe(5);
    expect(progress.warnings).toEqual([]);
  });

  it("does not loop on a cycle of Equivalences", () => {
    const cyclic = program({
      courses: COURSES,
      equivalences: [
        { from: "89-110", to: "89-111" },
        { from: "89-111", to: "89-110" },
      ],
      requirements: [{ id: "a", kind: "course", course: "89-110" }],
    });

    const progress = evaluate(cyclic, [attempt("89-111", "passed")]);

    expect(node(progress, "a").completed.status).toBe("satisfied");
  });
});

describe("Tracks and Programs", () => {
  const file = program({
    courses: COURSES,
    requirements: [{ id: "intro", kind: "course", course: "89-110" }],
    tracks: [
      {
        id: "ai",
        name: { he: "בינה" },
        requirements: [{ id: "ml", kind: "course", course: "89-310" }],
      },
    ],
  });

  it("evaluates a Track's Requirements together with the base rule set", () => {
    const progress = evaluate(file, [attempt("89-110", "passed")], { track: "ai" });

    expect(progress.requirements.map((r) => r.id)).toEqual(["intro", "ml"]);
    expect(progress.status.completed).toBe("partial");
  });

  it("evaluates the base rule set alone without a Track", () => {
    const progress = evaluate(file, [attempt("89-110", "passed")]);

    expect(progress.requirements.map((r) => r.id)).toEqual(["intro"]);
    expect(progress.status.completed).toBe("satisfied");
  });

  it("warns about a Track the file does not have, and evaluates the base rule set", () => {
    const progress = evaluate(file, [attempt("89-110", "passed")], { track: "robotics" });

    expect(progress.requirements.map((r) => r.id)).toEqual(["intro"]);
    expect(progress.warnings).toEqual([{ kind: "track-unknown", track: "robotics" }]);
  });

  it("evaluates each Program of a double major against the same Attempts", () => {
    const math = program({
      program: { id: "math", name: { he: "מתמטיקה" } },
      courses: [{ number: "88-101", credits: 5 }],
      requirements: [{ id: "calc", kind: "course", course: "88-101" }],
    });
    const attempts = [attempt("89-110", "passed"), attempt("88-101", "planned")];

    const cs = evaluate(file, attempts);
    const maths = evaluate(math, attempts);

    expect(cs.status).toEqual({ completed: "satisfied", projected: "satisfied" });
    expect(maths.status).toEqual({ completed: "missing", projected: "satisfied" });
  });
});

describe("totals and Warnings", () => {
  const file = program({
    courses: [...COURSES, { number: "89-999" }],
    pools: [{ id: "adv", kind: "prefix", prefix: "89-3" }],
    requirements: [{ id: "electives", kind: "credits", min: 6, pool: "adv" }],
  });

  it("counts every completed Course in the totals, whether or not a Requirement takes it", () => {
    const progress = evaluate(file, [
      attempt("89-110", "passed"),
      attempt("89-310", "passed"),
      attempt("89-111", "planned"),
      attempt("89-210", "failed"),
    ]);

    expect(progress.totalCredits).toEqual({ completed: 8, projected: 12 });
  });

  it("reports an Attempt for a Course the file does not know, rather than ignoring it", () => {
    const progress = evaluate(file, [attempt("89-3100", "passed"), attempt("98-110", "failed")]);

    // 89-3100 is matched by the prefix Pool, so the file knows where it counts but not its
    // credits; 98-110 is matched by nothing at all.
    expect(progress.warnings).toEqual([
      { kind: "credits-unknown", courseNumber: "89-3100" },
      { kind: "course-unknown", courseNumber: "98-110" },
    ]);
    expect(node(progress, "electives").completed.credits).toEqual({ counted: 0, needed: 6 });
  });

  it("counts a Course with unknown credits as zero and says so once", () => {
    const progress = evaluate(file, [attempt("89-999", "passed"), attempt("89-999", "planned")]);

    expect(progress.totalCredits).toEqual({ completed: 0, projected: 0 });
    expect(progress.warnings).toEqual([{ kind: "credits-unknown", courseNumber: "89-999" }]);
  });
});

describe("the Assignment", () => {
  const file = program({
    courses: COURSES,
    pools: [
      { id: "adv", kind: "prefix", prefix: "89-3" },
      { id: "all", kind: "prefix", prefix: "89-" },
    ],
    requirements: [
      { id: "ai", kind: "credits", min: 3, pool: "adv" },
      { id: "electives", kind: "credits", min: 3, pool: "all" },
      { id: "intro", kind: "course", course: "89-110" },
    ],
  });
  const attempts = [attempt("89-310", "passed")];
  const only = (requirementIds: string[]): Assignment => ({
    completed: [{ courseNumber: "89-310", requirementIds }],
    projected: [{ courseNumber: "89-310", requirementIds }],
  });

  it("counts a Course toward the Requirement the Assignment names, and nowhere else", () => {
    const progress = evaluateProgress({ file, attempts, assignment: only(["electives"]) });

    expect(node(progress, "ai").completed.status).toBe("missing");
    expect(node(progress, "electives").completed.status).toBe("satisfied");
  });

  it("warns about a Requirement id that does not exist", () => {
    const progress = evaluateProgress({ file, attempts, assignment: only(["ghost"]) });

    expect(progress.warnings).toEqual([
      { kind: "assignment-requirement-unknown", courseNumber: "89-310", requirementId: "ghost" },
    ]);
  });

  it("warns about a Requirement that cannot take the Course, and does not count it there", () => {
    const progress = evaluateProgress({ file, attempts, assignment: only(["intro"]) });

    expect(progress.warnings).toEqual([
      { kind: "assignment-not-accepted", courseNumber: "89-310", requirementId: "intro" },
    ]);
    expect(node(progress, "intro").completed.status).toBe("missing");
  });

  it("counts a Course once among siblings unless the file allows more, keeping the first", () => {
    const progress = evaluateProgress({ file, attempts, assignment: only(["ai", "electives"]) });

    expect(node(progress, "ai").completed.status).toBe("satisfied");
    expect(node(progress, "electives").completed.status).toBe("missing");
    expect(progress.warnings).toEqual([
      { kind: "assignment-double-count", courseNumber: "89-310", requirementId: "electives" },
    ]);
  });

  it("counts a Course twice where the file allows double counting", () => {
    const sharing = program({
      courses: COURSES,
      pools: [
        { id: "adv", kind: "prefix", prefix: "89-3" },
        { id: "all", kind: "prefix", prefix: "89-" },
      ],
      requirements: [
        { id: "ai", kind: "credits", min: 3, pool: "adv" },
        { id: "electives", kind: "credits", min: 3, pool: "all" },
      ],
      doubleCounting: { within: [{ requirements: ["ai", "electives"], pool: "adv" }] },
    });

    const progress = evaluateProgress({
      file: sharing,
      attempts,
      assignment: only(["ai", "electives"]),
    });

    expect(node(progress, "ai").completed.status).toBe("satisfied");
    expect(node(progress, "electives").completed.status).toBe("satisfied");
    expect(progress.warnings).toEqual([]);
  });

  it("holds a permission to its Pool: a Course outside it still counts once", () => {
    const sharing = program({
      courses: COURSES,
      pools: [
        { id: "adv", kind: "prefix", prefix: "89-3" },
        { id: "all", kind: "prefix", prefix: "89-" },
        { id: "none", kind: "list", courses: [] },
      ],
      requirements: [
        { id: "ai", kind: "credits", min: 3, pool: "adv" },
        { id: "electives", kind: "credits", min: 3, pool: "all" },
      ],
      doubleCounting: { within: [{ requirements: ["ai", "electives"], pool: "none" }] },
    });

    const progress = evaluateProgress({ file: sharing, attempts, assignment: only(["ai", "electives"]) });

    expect(node(progress, "electives").completed.status).toBe("missing");
  });

  it("ignores a placement for a Course the lens does not count", () => {
    const progress = evaluateProgress({
      file,
      attempts: [attempt("89-310", "planned")],
      assignment: only(["ai"]),
    });

    expect(node(progress, "ai").completed.status).toBe("missing");
    expect(node(progress, "ai").projected.status).toBe("satisfied");
    expect(progress.warnings).toEqual([]);
  });
});

describe("firstFitAssignment", () => {
  it("places every counted Course on the first Requirement in tree order that accepts it", () => {
    const file = program({
      courses: COURSES,
      pools: [{ id: "all", kind: "prefix", prefix: "89-" }],
      requirements: [
        { id: "core", kind: "allOf", of: [{ id: "intro", kind: "course", course: "89-110" }] },
        { id: "electives", kind: "credits", min: 3, pool: "all" },
      ],
    });

    const assignment = firstFitAssignment({
      file,
      attempts: [
        attempt("89-310", "passed"),
        attempt("89-110", "passed"),
        attempt("89-111", "planned"),
        attempt("98-000", "passed"),
      ],
    });

    expect(assignment).toEqual({
      completed: [
        { courseNumber: "89-110", requirementIds: ["intro"] },
        { courseNumber: "89-310", requirementIds: ["electives"] },
      ],
      projected: [
        { courseNumber: "89-110", requirementIds: ["intro"] },
        { courseNumber: "89-111", requirementIds: ["electives"] },
        { courseNumber: "89-310", requirementIds: ["electives"] },
      ],
    });
  });

  it("includes the chosen Track's Requirements", () => {
    const file = program({
      courses: COURSES,
      tracks: [
        { id: "ai", name: { he: "x" }, requirements: [{ id: "ml", kind: "course", course: "89-310" }] },
      ],
    });

    const assignment = firstFitAssignment({ file, track: "ai", attempts: [attempt("89-310", "passed")] });

    expect(assignment.completed).toEqual([{ courseNumber: "89-310", requirementIds: ["ml"] }]);
  });
});
