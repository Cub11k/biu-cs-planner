/**
 * The Plan screen's columns (#292), derived and never stored: the Semesters from the student's
 * Cohort onward, grouped by Academic Year, and what a column adds up to. Pure, so the rules are
 * tested without a browser.
 */
import type { Attempt, CourseFacts, Grade, Semester, SemesterAt } from "./plan.ts";

export const SEMESTERS: readonly Semester[] = ["fall", "spring", "summer"];

/** How many study years the columns cover from the Cohort at least: a standard BIU CS degree. */
export const STANDARD_DEGREE_YEARS = 3;

/** Where a Semester falls in time: a larger number is later (`CONTEXT.md`, Academic Year). */
export const semesterIndex = (at: SemesterAt): number => at.academicYear * 3 + SEMESTERS.indexOf(at.semester);

const fromIndex = (index: number): SemesterAt => ({
  academicYear: Math.floor(index / 3),
  semester: SEMESTERS[index % 3]!,
});

/** One Academic Year of the Plan and the Semesters of it shown, in the order of the year. */
export type PlanYear = { academicYear: number; semesters: Semester[] };

export type ColumnsInput = {
  cohort: SemesterAt | null | undefined;
  attempts: readonly Pick<Attempt, "academicYear" | "semester">[];
  /** The Academic Year the columns start in when there is neither a Cohort nor an Attempt. */
  thisYear: number;
  /** How many study years from the Cohort are shown however few Attempts there are. */
  degreeYears?: number;
  /** Academic Years the student asked for beyond those. */
  extraYears?: number;
};

/**
 * The Semesters shown: from the Cohort's — or an earlier Attempt's, an exemption from before the
 * student started, so no Attempt is ever off the screen — to the later of the last Attempt and the
 * end of a standard degree counted from the Cohort, plus any years the student added.
 *
 * A study year begins at the Cohort's own Semester (`core`'s `studyPointAt`), so a Spring Cohort's
 * third study year ends in the Fall of the Academic Year after its third.
 */
export function planYears({
  cohort,
  attempts,
  thisYear,
  degreeYears = STANDARD_DEGREE_YEARS,
  extraYears = 0,
}: ColumnsInput): PlanYear[] {
  const indices = attempts.map(semesterIndex);
  const anchor = cohort ?? (indices.length === 0 ? { academicYear: thisYear, semester: "fall" as const } : undefined);
  const first = Math.min(...indices, ...(anchor === undefined ? [] : [semesterIndex(anchor)]));
  const start = fromIndex(first);
  const from = anchor ?? start;
  const degreeEnd = from.academicYear + degreeYears - 1 + (from.semester === "fall" ? 0 : 1);
  const lastYear = Math.max(degreeEnd, ...attempts.map((attempt) => attempt.academicYear)) + extraYears;

  const years: PlanYear[] = [];
  for (let academicYear = start.academicYear; academicYear <= lastYear; academicYear++) {
    years.push({
      academicYear,
      semesters: SEMESTERS.filter((semester) => semesterIndex({ academicYear, semester }) >= first),
    });
  }
  return years;
}

/** Statuses that are not a load the student carries: done elsewhere, or waived. */
const NOT_A_LOAD: ReadonlySet<Attempt["status"]> = new Set(["exempt", "credited"]);

/**
 * What one Semester adds up to: the credits of its Attempts the Workspace knows credits for, and
 * how many it does not, leaving out exempt and credited Attempts as the credit-load check does.
 *
 * **A reading aid, not the check.** `core`'s `checkPlan` also halves a Year-long Course whose two
 * halves share an Academic Year, matches course numbers through Equivalences and reads only the
 * chosen Programs' files, and none of that is known here — so a column holding a Year-long half
 * can show more than the credit-load Warning counts. The Warning on the column is the server's and
 * is the one that judges the load.
 */
export function creditsOf(
  attempts: readonly Pick<Attempt, "courseNumber" | "status">[],
  courses: ReadonlyMap<string, CourseFacts>,
): { credits: number; unknown: number } {
  let credits = 0;
  let unknown = 0;
  for (const attempt of attempts) {
    if (NOT_A_LOAD.has(attempt.status)) continue;
    const known = courses.get(attempt.courseNumber)?.credits;
    if (known === undefined) unknown += 1;
    else credits += known;
  }
  return { credits, unknown };
}

/**
 * Where a retake goes by default: the next Fall or Spring after the try it repeats. A Summer is
 * never chosen for the student; the retake can be moved there like any card.
 */
export function retakeSemester(after: SemesterAt): SemesterAt {
  let index = semesterIndex(after) + 1;
  while (fromIndex(index).semester === "summer") index += 1;
  return fromIndex(index);
}

/**
 * A grade as typed: a number is a numeric grade, one of the words for a pass or a fail is a
 * pass/fail grade, nothing at all clears it (`null`), and anything else is not a grade
 * (`undefined`). The words are the translation table's, in either language.
 */
export function gradeOf(
  text: string,
  words: { pass: readonly string[]; fail: readonly string[] },
): Grade | null | undefined {
  const typed = text.trim();
  if (typed === "") return null;
  const folded = typed.toLocaleLowerCase();
  if (words.pass.some((word) => word.toLocaleLowerCase() === folded)) return { kind: "pass-fail", passed: true };
  if (words.fail.some((word) => word.toLocaleLowerCase() === folded)) return { kind: "pass-fail", passed: false };
  const value = Number(typed);
  return Number.isFinite(value) ? { kind: "numeric", value } : undefined;
}
