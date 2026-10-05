import { compileProgram, type CompiledProgram } from "../requirements/program.ts";
import type { RequirementsFile } from "../requirements/schema.ts";
import type { Attempt } from "../state/schema.ts";
import { semesterIndex, type SemesterAt } from "../state/semester-order.ts";

/**
 * What each Semester of the Plan adds up to in credits (#352): the one computation the credit-load
 * check (`checkPlan`, `./checks.ts`) judges and the Plan screen's columns show, so the number on a
 * column and the number its Warning is about cannot disagree.
 *
 * **Which Attempts count.** Every Attempt that took a seat that Semester — planned, registered,
 * passed, failed — and not an exempt or credited one, which was done elsewhere or waived.
 *
 * **Where a Course's credits come from.** The first of the student's Programs whose Requirements
 * File gives them, matched through that file's Equivalences. Never a Catalog: future years have
 * none (ADR-0008), and a Catalog's credits are a sum of weekly hours rather than the Course's.
 *
 * **A Year-long Course.** Its credits are the year's, so when its Fall and Spring halves are both
 * in one Academic Year each carries half of them; a lone half carries them all, since nothing says
 * where the rest falls.
 *
 * Pure: the same Attempts and files always give the same totals.
 */
export type SemesterCredits = SemesterAt & {
  /** The credits of the Attempts whose credits a Program's file gives. */
  credits: number;
  /** How many of the Semester's counted Attempts no Program's file gives credits for. */
  unknown: number;
};

/** One Program whose file credits are read from. */
export type CreditsProgram = { file: RequirementsFile; track?: string };

const NOT_A_LOAD: ReadonlySet<Attempt["status"]> = new Set(["exempt", "credited"]);

/** Whether an Attempt is a load the student carried or will carry in its Semester. */
export const isLoad = (attempt: Attempt): boolean => !NOT_A_LOAD.has(attempt.status);

/**
 * One Attempt's share of credits, from the first compiled Program whose file gives them, or
 * `undefined` when none does.
 */
function creditsOfAttempt(
  programs: readonly CompiledProgram[],
  attempts: readonly Attempt[],
  taken: Attempt,
): number | undefined {
  for (const program of programs) {
    const course = program.canonical(taken.courseNumber);
    const credits = program.credits(course);
    if (credits === undefined) continue;
    const yearLong = program.file.courses.some(
      (c) => program.canonical(c.number) === course && c.offeringPattern === "year-long",
    );
    const otherHalf = taken.semester === "fall" ? "spring" : taken.semester === "spring" ? "fall" : undefined;
    const paired =
      otherHalf !== undefined &&
      attempts.some(
        (a) =>
          a.academicYear === taken.academicYear &&
          a.semester === otherHalf &&
          program.canonical(a.courseNumber) === course,
      );
    return yearLong && paired ? credits / 2 : credits;
  }
  return undefined;
}

/**
 * The totals over Programs already compiled, as `checkPlan` holds them: every Semester holding a
 * counted Attempt, earliest first.
 */
export function creditsOverCompiled(
  programs: readonly CompiledProgram[],
  attempts: readonly Attempt[],
): SemesterCredits[] {
  const semesters = new Map<number, SemesterCredits>();
  for (const attempt of attempts) {
    if (!isLoad(attempt)) continue;
    const index = semesterIndex(attempt);
    const slot = semesters.get(index) ?? {
      academicYear: attempt.academicYear,
      semester: attempt.semester,
      credits: 0,
      unknown: 0,
    };
    const credits = creditsOfAttempt(programs, attempts, attempt);
    if (credits === undefined) slot.unknown += 1;
    else slot.credits += credits;
    semesters.set(index, slot);
  }
  return [...semesters.entries()].sort(([a], [b]) => a - b).map(([, slot]) => slot);
}

/**
 * What each Semester of the Plan adds up to, against the student's Programs in their order. A
 * Semester holding no counted Attempt is not listed: it adds up to nothing.
 */
export function semesterCredits(input: {
  attempts: readonly Attempt[];
  programs: readonly CreditsProgram[];
}): SemesterCredits[] {
  const compiled = input.programs.map((entry) => compileProgram(entry.file, entry.track));
  return creditsOverCompiled(compiled, input.attempts);
}
