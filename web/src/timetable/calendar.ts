/**
 * Which Timetable the app opens on. A Timetable covers one Semester of the current
 * Academic Year (docs/design.md, "Timetable"), so "current" has to be worked out from the
 * date — and the planner is used around registration windows, right before a Semester
 * starts, so the month a Semester is registered in counts as that Semester's.
 */
import type { Semester } from "./catalog.ts";

/**
 * An Academic Year is named by the Gregorian year it ends in: 2026-27 is 2027
 * (CONTEXT.md, "Academic Year"). It turns over in September, when registration for the
 * Fall Semester opens — which is also when the year's Catalog is worth crawling.
 */
export function academicYearOf(date: Date): number {
  const year = date.getFullYear();
  return date.getMonth() >= 8 ? year + 1 : year;
}

/**
 * The Semester being registered for or sat in now. September through January is Fall,
 * February through June is Spring, and what is left is Summer — which lands in the same
 * Academic Year as the Fall that follows it does not, exactly as `academicYearOf` says.
 */
export function semesterOf(date: Date): Semester {
  const month = date.getMonth();
  if (month >= 8 || month === 0) return "fall";
  if (month <= 5) return "spring";
  return "summer";
}

/** "2026-27": the span a student would write, from the year the Academic Year ends in. */
export function academicYearSpan(academicYear: number): { first: string; second: string } {
  return {
    first: String(academicYear - 1),
    second: String(academicYear % 100).padStart(2, "0"),
  };
}
