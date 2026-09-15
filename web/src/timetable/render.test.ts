/**
 * The screen as markup. `renderToStaticMarkup` needs no browser, so the parts of this
 * ticket that are about what actually reaches the page — a tile on the right day at the
 * right minute, Friday only when something meets on it, pencil and nothing but pencil,
 * and a Hebrew screen that is `dir="rtl"` — are checked here rather than by eye.
 *
 * Fixture data is invented: the course numbers are real BIU CS numbers, the names and
 * times are not, and no crawled data is committed to this repo.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Group, Offering } from "./catalog.ts";
import { CoursePicker } from "./CoursePicker.tsx";
import { CatalogNotice, TimetableScreen } from "./TimetableScreen.tsx";
import { WeekGrid } from "./WeekGrid.tsx";

const group = (
  number: string,
  lessonType: string,
  meetings: ReadonlyArray<[Group["meetings"][number]["day"], string, string]>,
): Group => ({
  number,
  lessonType,
  lecturers: [],
  meetings: meetings.map(([day, start, end]) => ({ semester: "fall", day, start, end })),
});

const offering = (groups: Group[]): Offering => ({
  courseNumber: "89-110",
  nameHebrew: "מבוא למדעי המחשב",
  nameEnglish: "Introduction to Computer Science",
  credits: { known: true, total: 5 },
  semesters: ["fall"],
  groups,
  exams: { known: false, sittings: [] },
});

const week = (offer: Offering | undefined, language: "en" | "he" = "en"): string =>
  renderToStaticMarkup(
    createElement(WeekGrid, { language, semester: "fall", offering: offer }),
  );

it("runs Sunday to Thursday, and shows Friday only when a Group meets on it", () => {
  const weekday = week(offering([group("01", "הרצאה", [["tuesday", "15:00", "18:00"]])]));
  expect(weekday).toContain("Sunday");
  expect(weekday).toContain("Thursday");
  expect(weekday).not.toContain("Friday");

  const friday = week(offering([group("01", "ש.מחלקה", [["friday", "08:00", "13:00"]])]));
  expect(friday).toContain("Friday");
});

it("puts a Meeting at its own minutes, and says what it is", () => {
  const markup = week(offering([group("01", "הרצאה", [["tuesday", "15:00", "18:00"]])]));

  // 15:00 in a grid that fits 15:00–21:00 is the top of the column; three hours is 3 rows
  expect(markup).toContain("top:0");
  expect(markup).toContain("height:196px");
  expect(markup).toContain("Introduction to Computer Science");
  expect(markup).toContain("89-110 · Lecture · 01");
  // the time range carries its own direction: an en dash between two clock times is
  // bidi-neutral, so in Hebrew it would otherwise render as 18:00–15:00
  expect(markup).toContain('<bdi dir="ltr">15:00–18:00</bdi>');
});

it("draws every block in pencil, with no ink, red pen or hatching anywhere", () => {
  const markup = week(
    offering([
      group("01", "הרצאה", [["tuesday", "15:00", "18:00"]]),
      group("03", "תרגיל", [["tuesday", "18:00", "20:00"]]),
      group("04", "תרגיל", [["tuesday", "18:00", "20:00"]]),
    ]),
  );

  expect(markup).toContain('class="tile"');
  for (const forbidden of ["pick", "ink", "clash", "hatch", "busy", "blocked"]) {
    expect(markup).not.toContain(forbidden);
  }
});

it("keeps an Untimed Group in the No fixed time strip and off the grid", () => {
  const markup = week(
    offering([
      group("01", "הרצאה", [["tuesday", "15:00", "18:00"]]),
      group("02", "הרצאה", []),
    ]),
  );

  const [grid, strip] = markup.split("No fixed time");
  expect(strip).toBeDefined();
  expect(strip).toContain("89-110 · Lecture · 02");
  expect(grid).not.toContain("· 02");
});

it("says nothing about times when there is no Course chosen yet", () => {
  const markup = week(undefined);

  expect(markup).toContain("Sunday");
  expect(markup).not.toContain("No fixed time");
  expect(markup).not.toContain('class="tile"');
});

it("flips the whole screen to right-to-left in Hebrew", () => {
  const hebrew = renderToStaticMarkup(
    createElement(TimetableScreen, { language: "he", onLanguage: () => {} }),
  );

  expect(hebrew).toContain('dir="rtl"');
  expect(hebrew).toContain("מערכת שעות");
  expect(hebrew).toContain("בחרו קורס");

  const english = renderToStaticMarkup(
    createElement(TimetableScreen, { language: "en", onLanguage: () => {} }),
  );
  expect(english).toContain('dir="ltr"');
  expect(english).toContain("Timetable");
});

it("names the Semester and the Academic Year it opened on", () => {
  const markup = renderToStaticMarkup(
    createElement(TimetableScreen, {
      language: "en",
      onLanguage: () => {},
      today: new Date(2026, 8, 15, 12),
    }),
  );

  expect(markup).toContain("Semester A");
  expect(markup).toContain("2026-27");
});

it("tells the student what is actually wrong when no Catalog is served", () => {
  // a Catalog written by a newer version is there; "import a crawl" would not help
  const markup = renderToStaticMarkup(
    createElement(CatalogNotice, {
      language: "en",
      academicYear: "2026-27",
      warnings: [{ kind: "schema-version-too-new", found: 2 }],
    }),
  );

  expect(markup).toContain("2026-27");
  expect(markup).toContain("could not be read");
  expect(markup).toContain("newer version");
  expect(markup).not.toContain("Import a crawl");
});

it("offers the import only when the year simply has no Catalog", () => {
  const markup = renderToStaticMarkup(
    createElement(CatalogNotice, {
      language: "en",
      academicYear: "2026-27",
      warnings: [{ kind: "no-catalog-for-year", academicYear: 2027 }],
    }),
  );

  expect(markup).toContain("Import a crawl");
});

it("counts one Group as one, in both languages", () => {
  const one = offering([group("01", "סמינריון", [["sunday", "10:00", "12:00"]])]);
  const picker = (language: "en" | "he"): string =>
    renderToStaticMarkup(
      createElement(CoursePicker, {
        language,
        offerings: [one],
        selected: undefined,
        onSelect: () => {},
      }),
    );

  expect(picker("en")).toContain("1 group<");
  expect(picker("he")).toContain("קבוצה אחת");
});
