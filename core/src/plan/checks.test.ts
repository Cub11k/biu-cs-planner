import { describe, expect, it } from "vitest";
import { parseRequirementsFile } from "../requirements/file.ts";
import { CURRENT_REQUIREMENTS_SCHEMA_VERSION, type RequirementsFile } from "../requirements/schema.ts";
import type { Attempt, Grade, Status } from "../state/schema.ts";
import { checkPlan, type PlanCheckInput, type PlanProgram, type PlanWarning } from "./checks.ts";

/**
 * The Plan checks (#291) over small invented Requirements Files, read through the real reader
 * (ADR-0006: no real data reaches a test). Each check positive and negative; the Attempts carry
 * readable ids so a Warning's target says which card it belongs on.
 */
function file(parts: Record<string, unknown>): RequirementsFile {
  const { file } = parseRequirementsFile({
    schemaVersion: CURRENT_REQUIREMENTS_SCHEMA_VERSION,
    program: { id: "cs", name: { he: "מדעי המחשב" } },
    ...parts,
  });
  if (!file) throw new Error("fixture is not a Requirements File");
  return file;
}

function attempt(
  id: string,
  courseNumber: string,
  academicYear: number,
  semester: Attempt["semester"],
  status: Status = "planned",
  grade?: Grade,
): Attempt {
  return { id, courseNumber, academicYear, semester, status, ...(grade ? { grade } : {}) };
}

const numeric = (value: number): Grade => ({ kind: "numeric", value });

const program = (f: RequirementsFile, extra: Partial<PlanProgram> = {}): PlanProgram => ({
  requirementsFile: "cs-2027",
  file: f,
  ...extra,
});

/** The checks with a generous credit limit, so a test sees only the check it is about. */
function check(attempts: Attempt[], programs: PlanProgram[], extra: Partial<PlanCheckInput> = {}): PlanWarning[] {
  return checkPlan({ attempts, programs, creditLoadLimit: 1000, ...extra });
}

const ofKind = <K extends PlanWarning["kind"]>(warnings: PlanWarning[], kind: K) =>
  warnings.filter((w): w is Extract<PlanWarning, { kind: K }> => w.kind === kind);

describe("Prerequisite order", () => {
  const cs = file({
    courses: [
      { number: "89-110", credits: 5 },
      { number: "89-111", credits: 5, prerequisites: { kind: "passed", course: "89-110" } },
      {
        number: "89-112",
        credits: 4,
        prerequisites: { kind: "passed", course: "89-110", allowConcurrent: true },
      },
    ],
  });

  it("warns when a Course is planned in the same Semester as its Prerequisite, or before it", () => {
    const same = check([attempt("a", "89-110", 2027, "fall"), attempt("b", "89-111", 2027, "fall")], [program(cs)]);
    const earlier = check([attempt("a", "89-110", 2027, "spring"), attempt("b", "89-111", 2027, "fall")], [program(cs)]);

    for (const warnings of [same, earlier]) {
      expect(ofKind(warnings, "prerequisite-unmet")).toEqual([
        {
          kind: "prerequisite-unmet",
          target: { kind: "attempt", id: "b" },
          requirementsFile: "cs-2027",
          courseNumber: "89-111",
          missing: ["89-110"],
          reliesOn: [],
        },
      ]);
    }
  });

  it("accepts the Prerequisite in an earlier Semester, naming the planned Attempt it relies on", () => {
    const warnings = check(
      [attempt("a", "89-110", 2027, "fall"), attempt("b", "89-111", 2027, "spring")],
      [program(cs)],
    );

    expect(ofKind(warnings, "prerequisite-unmet")).toEqual([]);
  });

  it("accepts concurrent taking where the Prerequisite allows it, and only there", () => {
    const warnings = check(
      [attempt("a", "89-110", 2027, "fall"), attempt("c", "89-112", 2027, "fall")],
      [program(cs)],
    );

    expect(ofKind(warnings, "prerequisite-unmet")).toEqual([]);
  });

  it("ignores a failed Attempt: a fail does not unlock a Course", () => {
    const warnings = check(
      [attempt("a", "89-110", 2026, "fall", "failed"), attempt("b", "89-111", 2027, "fall")],
      [program(cs)],
    );

    expect(ofKind(warnings, "prerequisite-unmet")).toMatchObject([{ target: { id: "b" }, missing: ["89-110"] }]);
  });

  it("checks only what is planned or registered, not a Course already passed", () => {
    const warnings = check([attempt("b", "89-111", 2026, "fall", "passed")], [program(cs)]);

    expect(warnings).toEqual([]);
  });

  it("names the Attempts it relied on when the rest of an allOf is unmet", () => {
    const both = file({
      courses: [
        {
          number: "89-210",
          prerequisites: {
            kind: "allOf",
            of: [
              { kind: "passed", course: "89-110" },
              { kind: "passed", course: "89-111" },
            ],
          },
        },
      ],
    });

    const warnings = check([attempt("a", "89-110", 2026, "fall"), attempt("d", "89-210", 2027, "fall")], [program(both)]);

    expect(ofKind(warnings, "prerequisite-unmet")).toEqual([
      {
        kind: "prerequisite-unmet",
        target: { kind: "attempt", id: "d" },
        requirementsFile: "cs-2027",
        courseNumber: "89-210",
        missing: ["89-111"],
        reliesOn: ["a"],
      },
    ]);
  });

  it("is met by any one child of an anyOf, and names every alternative when none is there", () => {
    const either = file({
      courses: [
        {
          number: "89-210",
          prerequisites: {
            kind: "anyOf",
            of: [
              { kind: "passed", course: "89-110" },
              { kind: "passed", course: "88-101" },
            ],
          },
        },
      ],
    });

    expect(
      check([attempt("a", "88-101", 2026, "fall", "passed"), attempt("d", "89-210", 2027, "fall")], [program(either)]),
    ).toEqual([]);
    expect(ofKind(check([attempt("d", "89-210", 2027, "fall")], [program(either)]), "prerequisite-unmet")).toMatchObject([
      { missing: ["89-110", "88-101"] },
    ]);
  });

  it("checks a named-set Prerequisite against every Course of the set", () => {
    const sets = file({
      courseSets: [{ id: "first-year", courses: ["89-110", "88-101"] }],
      courses: [{ number: "89-310", prerequisites: { kind: "set", set: "first-year" } }],
    });

    const partial = check(
      [attempt("a", "89-110", 2026, "fall", "passed"), attempt("e", "89-310", 2027, "fall")],
      [program(sets)],
    );
    const whole = check(
      [
        attempt("a", "89-110", 2026, "fall", "passed"),
        attempt("b", "88-101", 2026, "spring", "passed"),
        attempt("e", "89-310", 2027, "fall"),
      ],
      [program(sets)],
    );

    expect(ofKind(partial, "prerequisite-unmet")).toMatchObject([{ target: { id: "e" }, missing: ["88-101"] }]);
    expect(whole).toEqual([]);
  });

  it("shows a Manual Prerequisite as a reminder rather than checking it", () => {
    const approval = { he: "באישור המרצה", en: "Lecturer approval" };
    const manual = file({
      courses: [
        { number: "89-590", prerequisites: { kind: "manual", text: approval } },
        {
          number: "89-591",
          prerequisites: { kind: "anyOf", of: [{ kind: "passed", course: "89-110" }, { kind: "manual", text: approval }] },
        },
      ],
    });

    expect(check([attempt("m", "89-590", 2027, "fall")], [program(manual)])).toEqual([
      {
        kind: "prerequisite-manual",
        target: { kind: "attempt", id: "m" },
        requirementsFile: "cs-2027",
        courseNumber: "89-590",
        text: approval,
      },
    ]);
    // the alternative to approval is there, so there is nothing to remind about
    expect(
      check([attempt("a", "89-110", 2026, "fall", "passed"), attempt("n", "89-591", 2027, "fall")], [program(manual)]),
    ).toEqual([]);
    expect(ofKind(check([attempt("n", "89-591", 2027, "fall")], [program(manual)]), "prerequisite-manual")).toHaveLength(1);
  });

  it("satisfies a Prerequisite through an Equivalence, in either direction", () => {
    const renumbered = file({
      equivalences: [{ from: "89-109", to: "89-110" }],
      courses: [{ number: "89-111", prerequisites: { kind: "passed", course: "89-110" } }],
    });

    expect(
      check([attempt("a", "89-109", 2026, "fall", "passed"), attempt("b", "89-111", 2027, "fall")], [program(renumbered)]),
    ).toEqual([]);
  });
});

describe("minimum grade, under both policies", () => {
  const withPolicy = (gradeAttempt: "best" | "latest") =>
    file({
      policies: { passingGrade: 60, gradeAttempt },
      courses: [{ number: "89-210", prerequisites: { kind: "passed", course: "89-110", minGrade: 75 } }],
    });
  // Passed with 80, then retook it to improve and passed with 65.
  const improvedWorse = [
    attempt("a1", "89-110", 2026, "fall", "passed", numeric(80)),
    attempt("a2", "89-110", 2026, "spring", "passed", numeric(65)),
    attempt("d", "89-210", 2027, "fall"),
  ];

  it("best: the best passing grade counts, so the earlier 80 meets 75", () => {
    expect(check(improvedWorse, [program(withPolicy("best"))])).toEqual([]);
  });

  it("latest: the latest passing grade counts, so the 65 falls short of 75", () => {
    expect(check(improvedWorse, [program(withPolicy("latest"))])).toEqual([
      {
        kind: "prerequisite-grade-below",
        target: { kind: "attempt", id: "d" },
        requirementsFile: "cs-2027",
        courseNumber: "89-210",
        prerequisite: "89-110",
        minGrade: 75,
        grade: 65,
        reliesOn: [],
      },
    ]);
  });

  it("latest: a failed retake after the pass changes nothing, under either policy (#327)", () => {
    const failedRetake = [
      attempt("a1", "89-110", 2026, "fall", "passed", numeric(80)),
      attempt("a2", "89-110", 2026, "spring", "failed", numeric(40)),
      attempt("d", "89-210", 2027, "fall"),
    ];

    expect(check(failedRetake, [program(withPolicy("latest"))])).toEqual([]);
    expect(check(failedRetake, [program(withPolicy("best"))])).toEqual([]);
  });

  it("warns under both when every passing grade is below the minimum", () => {
    const low = [attempt("a", "89-110", 2026, "fall", "passed", numeric(70)), attempt("d", "89-210", 2027, "fall")];

    for (const policy of ["best", "latest"] as const) {
      expect(ofKind(check(low, [program(withPolicy(policy))]), "prerequisite-grade-below")).toMatchObject([
        { grade: 70, minGrade: 75 },
      ]);
    }
  });

  it("relies on a planned retake rather than warning about the grade it will replace", () => {
    const retaking = [
      attempt("a", "89-110", 2026, "fall", "passed", numeric(70)),
      attempt("r", "89-110", 2026, "spring", "planned"),
      attempt("d", "89-210", 2027, "fall"),
    ];

    expect(check(retaking, [program(withPolicy("best"))])).toEqual([]);
  });

  it("holds an exemption or a pass/fail result to no number", () => {
    const exempt = [attempt("a", "89-110", 2026, "fall", "exempt"), attempt("d", "89-210", 2027, "fall")];

    expect(check(exempt, [program(withPolicy("latest"))])).toEqual([]);
  });
});

describe("Offering Pattern", () => {
  const cs = file({
    courses: [
      { number: "89-110", offeringPattern: "fall" },
      { number: "89-111", offeringPattern: "spring" },
      { number: "89-120", offeringPattern: "year-long" },
      { number: "89-130" },
    ],
  });

  it("warns when a Course is planned in a Semester its pattern says it is not given", () => {
    const warnings = check(
      [
        attempt("a", "89-110", 2027, "spring"),
        attempt("b", "89-111", 2027, "fall"),
        attempt("c", "89-120", 2027, "summer"),
      ],
      [program(cs)],
    );

    expect(warnings).toEqual([
      { kind: "offering-pattern", target: { kind: "attempt", id: "a" }, requirementsFile: "cs-2027", courseNumber: "89-110", pattern: "fall" },
      { kind: "offering-pattern", target: { kind: "attempt", id: "b" }, requirementsFile: "cs-2027", courseNumber: "89-111", pattern: "spring" },
      { kind: "offering-pattern", target: { kind: "attempt", id: "c" }, requirementsFile: "cs-2027", courseNumber: "89-120", pattern: "year-long" },
    ]);
  });

  it("is quiet when the Semester matches, and when the pattern is unknown", () => {
    const warnings = check(
      [
        attempt("a", "89-110", 2027, "fall"),
        attempt("b", "89-111", 2027, "spring"),
        attempt("c", "89-120", 2027, "fall"),
        attempt("d", "89-130", 2027, "summer"),
        attempt("e", "89-999", 2027, "summer"),
      ],
      [program(cs)],
    );

    expect(warnings).toEqual([]);
  });

  it("leaves history alone: a Course passed in another Semester was evidently given then", () => {
    expect(check([attempt("a", "89-110", 2026, "spring", "passed")], [program(cs)])).toEqual([]);
  });
});

describe("Year-long Course split across years", () => {
  const cs = file({ courses: [{ number: "89-120", credits: 8, offeringPattern: "year-long" }] });

  it("warns on a planned half whose other half is in another Academic Year", () => {
    const warnings = check(
      [attempt("f", "89-120", 2027, "fall"), attempt("s", "89-120", 2028, "spring")],
      [program(cs)],
    );

    expect(warnings).toEqual([
      { kind: "year-long-split", target: { kind: "attempt", id: "f" }, requirementsFile: "cs-2027", courseNumber: "89-120", otherHalf: ["s"] },
      { kind: "year-long-split", target: { kind: "attempt", id: "s" }, requirementsFile: "cs-2027", courseNumber: "89-120", otherHalf: ["f"] },
    ]);
  });

  it("is quiet when both halves are in one year, a retake included", () => {
    const warnings = check(
      [
        attempt("f1", "89-120", 2026, "fall", "failed"),
        attempt("s1", "89-120", 2026, "spring", "failed"),
        attempt("f2", "89-120", 2027, "fall"),
        attempt("s2", "89-120", 2027, "spring"),
      ],
      [program(cs)],
    );

    expect(warnings).toEqual([]);
  });

  it("names only the planned half when the other is history", () => {
    const warnings = check(
      [attempt("f", "89-120", 2027, "fall", "passed"), attempt("s", "89-120", 2028, "spring")],
      [program(cs)],
    );

    expect(warnings).toMatchObject([{ kind: "year-long-split", target: { id: "s" }, otherHalf: ["f"] }]);
  });
});

describe("credit load per Semester", () => {
  const cs = file({
    courses: [
      { number: "89-110", credits: 10 },
      { number: "89-111", credits: 10 },
      { number: "89-112", credits: 4 },
      { number: "89-120", credits: 8, offeringPattern: "year-long" },
    ],
  });
  const fall = [attempt("a", "89-110", 2027, "fall"), attempt("b", "89-111", 2027, "fall"), attempt("c", "89-112", 2027, "fall")];

  it("warns above the limit and not at it, using the Requirements File's credits", () => {
    expect(checkPlan({ attempts: fall, programs: [program(cs)], creditLoadLimit: 24 })).toEqual([]);
    expect(checkPlan({ attempts: fall, programs: [program(cs)], creditLoadLimit: 23 })).toEqual([
      { kind: "credit-load", target: { kind: "semester", academicYear: 2027, semester: "fall" }, credits: 24, limit: 23 },
    ]);
  });

  it("counts each half of a Year-long Course as half its credits", () => {
    const yearLong = [attempt("f", "89-120", 2027, "fall"), attempt("s", "89-120", 2027, "spring")];

    expect(checkPlan({ attempts: yearLong, programs: [program(cs)], creditLoadLimit: 3 })).toMatchObject([
      { kind: "credit-load", target: { semester: "fall" }, credits: 4 },
      { kind: "credit-load", target: { semester: "spring" }, credits: 4 },
    ]);
  });

  it("leaves out exempt and credited Courses, and a Semester that is only history", () => {
    const attempts = [
      attempt("a", "89-110", 2026, "fall", "passed"),
      attempt("b", "89-111", 2026, "fall", "passed"),
      attempt("c", "89-110", 2027, "fall", "exempt"),
      attempt("d", "89-111", 2027, "fall", "credited"),
      attempt("e", "89-112", 2027, "fall"),
    ];

    expect(checkPlan({ attempts, programs: [program(cs)], creditLoadLimit: 5 })).toEqual([]);
  });
});

describe("missing Requirements", () => {
  const cs = file({
    courses: [
      { number: "89-110", credits: 5 },
      { number: "89-111", credits: 5 },
      { number: "89-210", credits: 4 },
      { number: "89-211", credits: 4 },
    ],
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
        id: "theory",
        kind: "nOf",
        n: 1,
        of: [
          { id: "algo", kind: "course", course: "89-210" },
          { id: "logic", kind: "course", course: "89-211" },
        ],
      },
      { id: "english", kind: "manual", text: { he: "אנגלית" } },
    ],
  });

  it("names the unmet leaves of an allOf, an unmet nOf itself, and an unticked Manual Requirement", () => {
    const warnings = check([attempt("a", "89-110", 2027, "fall")], [program(cs)]);

    expect(warnings).toEqual([
      { kind: "requirements-missing", target: { kind: "program", requirementsFile: "cs-2027" }, requirementIds: ["ds", "theory", "english"] },
    ]);
  });

  it("reads the projected lens, so a planned Course counts and a ticked Manual Requirement is met", () => {
    const attempts = [
      attempt("a", "89-110", 2026, "fall", "passed"),
      attempt("b", "89-111", 2027, "fall"),
      attempt("c", "89-211", 2027, "spring", "registered"),
    ];

    expect(check(attempts, [program(cs, { ticked: ["english"] })])).toEqual([]);
  });

  it("gives one summary per Program of a double major", () => {
    const math = file({
      program: { id: "math", name: { he: "מתמטיקה" } },
      requirements: [{ id: "calc", kind: "course", course: "88-101" }],
    });

    const warnings = check([], [program(cs, { ticked: ["english"] }), { requirementsFile: "math-2027", file: math }]);

    expect(warnings).toEqual([
      { kind: "requirements-missing", target: { kind: "program", requirementsFile: "cs-2027" }, requirementIds: ["intro", "ds", "theory"] },
      { kind: "requirements-missing", target: { kind: "program", requirementsFile: "math-2027" }, requirementIds: ["calc"] },
    ]);
  });
});

describe("progression deadlines", () => {
  const cs = file({
    deadlines: [{ name: { he: "סוף שנה א" }, by: { studyYear: 1, semester: "spring" }, courses: ["89-110", "89-111"] }],
  });
  const fallCohort = { academicYear: 2027, semester: "fall" } as const;

  it("warns when a deadline's Courses are not passed or planned by the end of its Semester", () => {
    const warnings = check(
      [attempt("a", "89-110", 2027, "fall", "passed"), attempt("b", "89-111", 2027, "summer")],
      [program(cs)],
      { cohort: fallCohort },
    );

    expect(warnings).toEqual([
      {
        kind: "deadline-missed",
        target: { kind: "semester", academicYear: 2027, semester: "spring" },
        requirementsFile: "cs-2027",
        name: { he: "סוף שנה א" },
        missing: ["89-111"],
        reliesOn: [],
      },
    ]);
  });

  it("is met by a pass or a planned Attempt in time, and is checked only with a Cohort", () => {
    const attempts = [attempt("a", "89-110", 2027, "fall", "passed"), attempt("b", "89-111", 2027, "spring")];

    expect(check(attempts, [program(cs)], { cohort: fallCohort })).toEqual([]);
    expect(check([], [program(cs)])).toEqual([]);
  });

  it("places the deadline relative to a Spring Cohort", () => {
    const springCohort = { academicYear: 2027, semester: "spring" } as const;
    // year 1 Spring for a Spring Cohort is its first Semester, 2027 Spring; Fall 2027 is before it
    const warnings = check([attempt("a", "89-110", 2027, "spring", "passed")], [program(cs)], { cohort: springCohort });

    expect(warnings).toMatchObject([{ target: { academicYear: 2027, semester: "spring" }, missing: ["89-111"] }]);
  });
});

it("runs nothing that needs a Requirements File when no Program is chosen", () => {
  const attempts = [attempt("a", "89-110", 2027, "fall"), attempt("b", "89-111", 2027, "fall")];

  expect(checkPlan({ attempts, programs: [], creditLoadLimit: 0 })).toEqual([]);
});
