import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { importRawCrawl } from "./import.ts";
import type { Offering } from "../catalog/schema.ts";

/**
 * A real Raw Crawl, trimmed to eight rows of the 2027 CS crawl. Every expected value below
 * was read off the Shoham data by hand, not produced by the Importer.
 */
const crawl = JSON.parse(
  readFileSync(join(import.meta.dirname, "__fixtures__/raw-crawl-2027-trimmed.json"), "utf8"),
);

const { catalog, warnings } = importRawCrawl(crawl, { academicYear: 2027 });

const find = (courseNumber: string): Offering =>
  catalog.offerings.find((o) => o.courseNumber === courseNumber)!;

it("turns eight real rows into six Offerings", () => {
  expect(catalog.offerings.map((o) => [o.courseNumber, o.semesters])).toEqual([
    ["89-081", ["summer"]],
    ["89-099", ["fall", "spring"]],
    ["89-110", ["fall"]],
    ["89-12000", ["fall"]],
    ["89-132", ["fall"]],
    ["89-6878", ["spring"]],
  ]);
});

it("reads 89-110's lecture and tirgul, its credits and both Moadim", () => {
  const offering = find("89-110");

  expect(offering.nameHebrew).toBe("מבוא למדעי המחשב");
  expect(offering.credits).toBe(3);
  expect(offering.groups).toEqual([
    {
      number: "01",
      lessonType: "הרצאה",
      lecturers: ["פרופ' נועה אגמון"],
      meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
    },
    {
      number: "03",
      lessonType: "תרגיל",
      lecturers: ["מר עומרי פרי"],
      meetings: [{ semester: "fall", day: "tuesday", start: "18:00", end: "20:00" }],
    },
  ]);
  expect(offering.exams).toEqual({
    known: true,
    sittings: [
      { moed: "מועד א'", date: "2027-01-21", time: "16:00" },
      { moed: "מועד ב'", date: "2027-02-11", time: "16:00" },
    ],
  });
});

it("spreads 89-099's six ranges over three days and both Semesters, Friday included", () => {
  expect(find("89-099").groups[0]!.meetings).toEqual([
    { semester: "fall", day: "sunday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "thursday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "friday", start: "08:00", end: "13:00" },
    { semester: "spring", day: "sunday", start: "09:00", end: "11:00" },
    { semester: "spring", day: "thursday", start: "09:00", end: "11:00" },
    { semester: "spring", day: "friday", start: "08:00", end: "13:00" },
  ]);
});

it("keeps 89-132's timed and Untimed lecture Groups side by side", () => {
  const offering = find("89-132");

  expect(offering.groups.map((g) => [g.number, g.meetings.length])).toEqual([
    ["01", 2],
    ["02", 0],
  ]);
  expect(offering.groups[0]!.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "13:00", end: "15:00" },
    { semester: "fall", day: "wednesday", start: "09:00", end: "11:00" },
  ]);
});

it("records Exams as unknown where the crawl published none", () => {
  expect(find("89-6878").exams).toEqual({ known: false, sittings: [] });
  expect(find("89-081").exams).toEqual({ known: false, sittings: [] });
  expect(find("89-081").credits).toBe(2);
});

it("reports only the odd course number, and nothing about the schedules", () => {
  expect(warnings).toEqual([{ kind: "unusual-course-number", courseNumber: "89-12000" }]);
});
