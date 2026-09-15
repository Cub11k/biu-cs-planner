import { expect, it } from "vitest";
import { academicYearOf, academicYearSpan, semesterOf } from "./calendar.ts";

/** Local noon, so a timezone never moves a date across a month boundary. */
const on = (year: number, month: number, day: number): Date =>
  new Date(year, month - 1, day, 12);

it("names an Academic Year by the Gregorian year it ends in", () => {
  expect(academicYearOf(on(2026, 9, 15))).toBe(2027);
  expect(academicYearOf(on(2026, 12, 31))).toBe(2027);
  expect(academicYearOf(on(2027, 1, 1))).toBe(2027);
  expect(academicYearOf(on(2027, 6, 30))).toBe(2027);
});

it("keeps a Summer Semester in the Academic Year it belongs to", () => {
  // Summer of 2026-27 runs in July and August 2027, before 2027-28 begins
  expect(academicYearOf(on(2027, 7, 1))).toBe(2027);
  expect(semesterOf(on(2027, 7, 1))).toBe("summer");
});

it("opens on the Semester being registered for or sat in", () => {
  expect(semesterOf(on(2026, 9, 15))).toBe("fall");
  expect(semesterOf(on(2027, 1, 20))).toBe("fall");
  expect(semesterOf(on(2027, 2, 1))).toBe("spring");
  expect(semesterOf(on(2027, 6, 30))).toBe("spring");
  expect(semesterOf(on(2027, 8, 31))).toBe("summer");
});

it("writes the year as the span a student would", () => {
  expect(academicYearSpan(2027)).toEqual({ first: "2026", second: "27" });
  expect(academicYearSpan(2100)).toEqual({ first: "2099", second: "00" });
});
