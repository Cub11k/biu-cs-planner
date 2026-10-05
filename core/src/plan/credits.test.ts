import { expect, it } from "vitest";
import { parseRequirementsFile } from "../requirements/file.ts";
import { CURRENT_REQUIREMENTS_SCHEMA_VERSION, type RequirementsFile } from "../requirements/schema.ts";
import type { Attempt, Status } from "../state/schema.ts";
import { checkPlan } from "./checks.ts";
import { semesterCredits } from "./credits.ts";

/**
 * Per-Semester credit totals (#352) over small invented Requirements Files, read through the real
 * reader (ADR-0006: no real data reaches a test). The Plan screen shows these and the credit-load
 * check judges them, so the last test holds the two to one number.
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

const attempt = (
  id: string,
  courseNumber: string,
  academicYear: number,
  semester: Attempt["semester"],
  status: Status = "planned",
): Attempt => ({ id, courseNumber, academicYear, semester, status });

const cs = file({
  courses: [
    { number: "89-110", credits: 5 },
    { number: "89-111", credits: 4 },
    { number: "89-120", credits: 8, offeringPattern: "year-long" },
  ],
  equivalences: [{ from: "88-110", to: "89-110" }],
});

it("adds up each Semester's Attempts by the Requirements File's credits, earliest Semester first", () => {
  const attempts = [
    attempt("b", "89-111", 2027, "spring"),
    attempt("a", "89-110", 2027, "fall", "passed"),
    attempt("c", "89-111", 2027, "fall", "failed"),
  ];

  expect(semesterCredits({ attempts, programs: [{ file: cs }] })).toEqual([
    { academicYear: 2027, semester: "fall", credits: 9, unknown: 0 },
    { academicYear: 2027, semester: "spring", credits: 4, unknown: 0 },
  ]);
});

it("halves a Year-long Course whose two halves share an Academic Year, and not a lone half", () => {
  const paired = [attempt("f", "89-120", 2027, "fall"), attempt("s", "89-120", 2027, "spring")];
  const split = [attempt("f", "89-120", 2027, "fall"), attempt("s", "89-120", 2028, "spring")];

  expect(semesterCredits({ attempts: paired, programs: [{ file: cs }] }).map((s) => s.credits)).toEqual([4, 4]);
  expect(semesterCredits({ attempts: split, programs: [{ file: cs }] }).map((s) => s.credits)).toEqual([8, 8]);
});

it("reads a Course by its Equivalence, and counts one no file gives credits for as unknown", () => {
  const attempts = [attempt("a", "88-110", 2027, "fall"), attempt("b", "99-999", 2027, "fall")];

  expect(semesterCredits({ attempts, programs: [{ file: cs }] })).toEqual([
    { academicYear: 2027, semester: "fall", credits: 5, unknown: 1 },
  ]);
});

it("leaves out exempt and credited Attempts, and a Semester holding nothing else", () => {
  const attempts = [
    attempt("a", "89-110", 2027, "fall", "exempt"),
    attempt("b", "89-111", 2027, "spring", "credited"),
    attempt("c", "89-111", 2027, "spring"),
  ];

  expect(semesterCredits({ attempts, programs: [{ file: cs }] })).toEqual([
    { academicYear: 2027, semester: "spring", credits: 4, unknown: 0 },
  ]);
});

it("takes a Course's credits from the first Program whose file gives them", () => {
  const other = file({ courses: [{ number: "89-111", credits: 6 }, { number: "89-300", credits: 3 }] });
  const attempts = [attempt("a", "89-111", 2027, "fall"), attempt("b", "89-300", 2027, "fall")];

  expect(semesterCredits({ attempts, programs: [{ file: cs }, { file: other }] })[0]!.credits).toBe(7);
  expect(semesterCredits({ attempts, programs: [{ file: other }, { file: cs }] })[0]!.credits).toBe(9);
  expect(semesterCredits({ attempts, programs: [] })).toEqual([
    { academicYear: 2027, semester: "fall", credits: 0, unknown: 2 },
  ]);
});

/**
 * The case #352 was filed for: a Year-long Course's two halves in one Academic Year beside a Course
 * known only by its Equivalence. Summing the cards' own credits gave 8 + 0 for the Fall, while the
 * Warning measured 4 + 5; the totals now are what the Warning measures.
 */
it("is the number the credit-load Warning is about", () => {
  const attempts = [
    attempt("f", "89-120", 2027, "fall"),
    attempt("s", "89-120", 2027, "spring"),
    attempt("e", "88-110", 2027, "fall"),
  ];
  const programs = [{ requirementsFile: "cs-2027", file: cs }];

  const totals = semesterCredits({ attempts, programs });
  const warned = checkPlan({ attempts, programs, creditLoadLimit: 0 }).filter((w) => w.kind === "credit-load");

  expect(totals.map((s) => s.credits)).toEqual([9, 4]);
  expect(warned.map((w) => (w.kind === "credit-load" ? [w.target.semester, w.credits] : []))).toEqual(
    totals.map((s) => [s.semester, s.credits]),
  );
});
