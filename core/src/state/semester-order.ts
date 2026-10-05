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

/** A study year and Semester relative to the Cohort, as a Suggested Layout and a deadline name one. */
export type StudyPoint = { studyYear: number; semester: Semester };

/**
 * The Semester a study point falls in for a student who started in `cohort` (#293). The Semester
 * is kept as the point gives it, since a layout's Fall Course is a Fall Course whoever takes it,
 * and **a study year begins at the Cohort's own Semester**: study year 1 is the Cohort's Semester
 * and every Semester after it up to the same Semester a year on.
 *
 * So a Fall Cohort's study year `n` is Academic Year `cohort + n - 1`, every Semester of it. A
 * Spring Cohort starting in 2027 has study year 1 Spring and Summer in 2027 and study year 1 Fall
 * in 2028, the first Fall after it started, and its study year 2 likewise one later.
 *
 * **Whether that is BIU's convention for a Spring Cohort is an open fact** (`docs/design.md`):
 * it keeps every Offering Pattern and never places two study points in one Semester, and the price
 * is that a Spring Cohort's year-1 Fall Courses land after its year-1 Spring ones, which the
 * Prerequisite check will say when it matters.
 */
export function studyPointAt(cohort: SemesterAt, point: StudyPoint): SemesterAt {
  const beforeTheCohortSemester = SEMESTER_ORDER[point.semester] < SEMESTER_ORDER[cohort.semester];
  return {
    academicYear: cohort.academicYear + point.studyYear - 1 + (beforeTheCohortSemester ? 1 : 0),
    semester: point.semester,
  };
}
