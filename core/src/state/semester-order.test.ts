import { expect, it } from "vitest";
import { semesterIndex, studyPointAt } from "./semester-order.ts";

it("orders Semesters by Academic Year, then Fall before Spring before Summer", () => {
  const order = [
    { academicYear: 2026, semester: "summer" },
    { academicYear: 2027, semester: "fall" },
    { academicYear: 2027, semester: "spring" },
    { academicYear: 2027, semester: "summer" },
    { academicYear: 2028, semester: "fall" },
  ] as const;

  const indices = order.map(semesterIndex);
  expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  expect(new Set(indices).size).toBe(order.length);
});

it("places a Fall Cohort's study year n in Academic Year cohort + n - 1, every Semester of it", () => {
  const cohort = { academicYear: 2027, semester: "fall" } as const;

  expect(studyPointAt(cohort, { studyYear: 1, semester: "fall" })).toEqual({ academicYear: 2027, semester: "fall" });
  expect(studyPointAt(cohort, { studyYear: 1, semester: "spring" })).toEqual({ academicYear: 2027, semester: "spring" });
  expect(studyPointAt(cohort, { studyYear: 1, semester: "summer" })).toEqual({ academicYear: 2027, semester: "summer" });
  expect(studyPointAt(cohort, { studyYear: 3, semester: "spring" })).toEqual({ academicYear: 2029, semester: "spring" });
});

it("starts a Spring Cohort's study year at its own Semester, so year-1 Fall is the first Fall after it", () => {
  const cohort = { academicYear: 2027, semester: "spring" } as const;

  expect(studyPointAt(cohort, { studyYear: 1, semester: "spring" })).toEqual({ academicYear: 2027, semester: "spring" });
  expect(studyPointAt(cohort, { studyYear: 1, semester: "summer" })).toEqual({ academicYear: 2027, semester: "summer" });
  expect(studyPointAt(cohort, { studyYear: 1, semester: "fall" })).toEqual({ academicYear: 2028, semester: "fall" });
  expect(studyPointAt(cohort, { studyYear: 2, semester: "spring" })).toEqual({ academicYear: 2028, semester: "spring" });
  expect(studyPointAt(cohort, { studyYear: 2, semester: "fall" })).toEqual({ academicYear: 2029, semester: "fall" });
});

it("never places two study points of a layout in one Semester, and none before the Cohort", () => {
  for (const semester of ["fall", "spring", "summer"] as const) {
    const cohort = { academicYear: 2027, semester };
    const placed = [1, 2, 3, 4].flatMap((studyYear) =>
      (["fall", "spring", "summer"] as const).map((s) => semesterIndex(studyPointAt(cohort, { studyYear, semester: s }))),
    );
    expect(new Set(placed).size).toBe(placed.length);
    expect(Math.min(...placed)).toBe(semesterIndex(cohort));
  }
});
