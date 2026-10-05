import type { Semester } from "../catalog/schema.ts";

/**
 * The order Semesters fall in: by Academic Year, and within one Fall < Spring < Summer
 * (`CONTEXT.md`, Academic Year). One place says it, because the Requirement engine's `latest`
 * policy, the Plan checks and the Attempt Warnings all compare Semesters and must agree.
 */
const SEMESTER_ORDER: Readonly<Record<Semester, number>> = { fall: 0, spring: 1, summer: 2 };

/** A Semester of an Academic Year, the way an Attempt and a Cohort both name one. */
export type SemesterAt = { academicYear: number; semester: Semester };

/** Where a Semester falls in time: a larger number is later. */
export function semesterIndex(point: SemesterAt): number {
  return point.academicYear * 3 + SEMESTER_ORDER[point.semester];
}
