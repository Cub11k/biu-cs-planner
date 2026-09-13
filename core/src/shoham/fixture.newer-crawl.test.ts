import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { importRawCrawl } from "./import.ts";
import type { Offering } from "../catalog/schema.ts";

/**
 * The 2026-09-13 crawl, trimmed to ten real rows of four Courses. It is the shape the older
 * fixture next to it does not have: a `meta` block, and a detail record per Group -- which
 * the crawl keeps in a block it calls `sections`, keyed by each Group's own `lid`.
 *
 * The four were chosen for what each one proves. 89-110 has three Lesson Types, one of them
 * reading 0.00 weekly hours; 89-132 has a Group no detail record was read from, beside two
 * that have one; 89-100's Lesson Type reads 0.00 on its first Group and nothing on its
 * second; 89-385 is Year-long.
 *
 * The counters the crawl's meta block also carries (reported_total, captured, pages_walked,
 * rows_per_page and the detail counts) are dropped, because a trimmed file would state them
 * falsely. Every field the Importer reads is exactly as the crawl wrote it.
 *
 * Expected values below were read off the Shoham data and the department's yedion by hand,
 * not produced by the Importer.
 */
const crawl = JSON.parse(
  readFileSync(join(import.meta.dirname, "__fixtures__/raw-crawl-2027-newer-trimmed.json"), "utf8"),
);

const { catalog, warnings, summary } = importRawCrawl(crawl, { academicYear: 2027 });

const find = (courseNumber: string): Offering =>
  catalog.offerings.find((o) => o.courseNumber === courseNumber)!;

it("imports the newer crawl without a single Warning", () => {
  // Nothing about provenance: the meta block carries it. Nothing about the per-Group records either --
  // all seven match a row, and the three rows without one are ordinary.
  expect(warnings).toEqual([]);
});

it("records where the crawl came from, from its meta block", () => {
  expect(catalog.sources).toEqual([
    {
      query: "2027-cs",
      crawledAt: "2026-09-13T13:53:03.017Z",
      crawlerVersion: "scripts/crawl/v1-crawl.js",
      source: "https://courses.biu.ac.il/CoursesView.aspx",
      complete: true,
    },
  ]);
});

it("states the credits of every Offering, and agrees with the yedion on all four", () => {
  // yedion: 89-110 lecture_h 3.0 + exercise_h 2.0 = total_h 5.0; 89-132 4.0 + 2.0 = 6.0;
  // 89-385 is listed once per Semester at 2.0, so its year total is 4.0. 89-100 it gives
  // no hours for, and Shoham reads 0.00 -- a real figure, not a blank.
  expect(catalog.offerings.map((o) => [o.courseNumber, o.credits])).toEqual([
    ["89-100", { known: true, total: 0 }],
    ["89-110", { known: true, total: 5 }],
    ["89-132", { known: true, total: 6 }],
    ["89-385", { known: true, total: 4 }],
  ]);
});

it("gives every Offering the English name its per-Group records carry", () => {
  expect(catalog.offerings.map((o) => [o.courseNumber, o.nameEnglish])).toEqual([
    ["89-100", "Tutoring Project for First Year Students"],
    ["89-110", "Intro to Computers"],
    ["89-132", "Infinitesimal Math"],
    ["89-385", "Project Lab"],
  ]);
  // the Hebrew name still comes from the row, and is what the UI falls back to
  expect(find("89-132").nameHebrew).toBe("חשבון אינפיניטסימלי 1");
});

it("gives each of 89-110's three Lesson Types the hours of its own detail record", () => {
  // Three separate lids: 808655 reads 3.00, 822335 reads 2.00, 821467 reads 0.00. The older
  // crawl could only reach the lecture's, which left this Offering unable to state credits.
  expect(find("89-110").groups.map((g) => [g.number, g.lessonType, g.weeklyHours])).toEqual([
    ["01", "הרצאה", 3],
    ["03", "תרגיל", 2],
    ["10", "תגבור", 0],
  ]);
});

it("leaves a Group no detail record was read from without hours of its own", () => {
  // 89-132 group 02 is a real lecture Group that the crawl never fetched a page for. Its
  // Lesson Type is already settled by group 01, so the Offering's credits stand regardless.
  expect(find("89-132").groups.map((g) => [g.number, g.weeklyHours])).toEqual([
    ["01", 4],
    ["02", undefined],
    ["03", 2],
  ]);
});

it("carries hours and an English name onto a Year-long Offering", () => {
  const offering = find("89-385");

  expect(offering.semesters).toEqual(["fall", "spring"]);
  // `points` on a Year-long record is the year's total, not one Semester's
  expect(offering.groups.map((g) => [g.number, g.weeklyHours])).toEqual([
    ["01", 4],
    ["02", undefined],
  ]);
  // both Groups are Untimed, and both are taught by the same two lecturers
  expect(offering.groups[0]!.meetings).toEqual([]);
  expect(offering.groups[0]!.lecturers).toEqual(["ד\"ר אריאל רוט", "ד\"ר הדר פרנקל"]);
});

it("still reads Meetings and Exams the way it always did", () => {
  expect(find("89-110").groups[0]!.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
  ]);
  expect(find("89-110").exams).toEqual({
    known: true,
    sittings: [
      { moed: "מועד א'", date: "2027-01-21", time: "16:00" },
      { moed: "מועד ב'", date: "2027-02-11", time: "16:00" },
    ],
  });
  // no detail record published Exams for these two, so the question stays open
  expect(find("89-100").exams).toEqual({ known: false, sittings: [] });
  expect(find("89-385").exams).toEqual({ known: false, sittings: [] });
});

it("summarises the import for the preview shown before anything is written", () => {
  // Counted off the fixture by hand: 4 Offerings over 10 Groups. Meetings are 89-110's three
  // and 89-132's three; the four Untimed Groups add none. Exams are two Moadim each for
  // 89-110 and 89-132.
  expect(summary).toEqual({ offerings: 4, groups: 10, meetings: 6, exams: 4 });
});
