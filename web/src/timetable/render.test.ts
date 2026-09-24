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
import { courseName, type Group, type Offering } from "./catalog.ts";
import type { GroupPick } from "./picks.ts";
import { weekGroups } from "./week.ts";
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

/** A Pick of one of `offering`'s Groups, with the snapshot the student's file would hold. */
const pick = (
  lessonType: string,
  groupNumber: string,
  meetings: ReadonlyArray<[Group["meetings"][number]["day"], string, string]>,
): GroupPick => ({
  courseNumber: "89-110",
  lessonType,
  groupNumber,
  meetings: meetings.map(([day, start, end]) => ({ semester: "fall", day, start, end })),
});

const week = (
  offer: Offering | undefined,
  options: {
    language?: "en" | "he";
    picks?: readonly GroupPick[];
    clashing?: ReadonlySet<string>;
  } = {},
): string => {
  const language = options.language ?? "en";
  const picks = options.picks ?? [];

  return renderToStaticMarkup(
    createElement(WeekGrid, {
      language,
      semester: "fall",
      groups: weekGroups({
        offering: offer,
        picks,
        nameOf: (courseNumber) =>
          offer !== undefined && offer.courseNumber === courseNumber
            ? courseName(offer, language)
            : courseNumber,
      }),
      ...(options.clashing === undefined ? {} : { clashing: options.clashing }),
      onPick: () => {},
    }),
  );
};

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

const LECTURE_MEETINGS: Array<[Group["meetings"][number]["day"], string, string]> = [
  ["tuesday", "15:00", "18:00"],
];

const THREE_GROUPS = [
  group("01", "הרצאה", LECTURE_MEETINGS),
  group("03", "תרגיל", [["tuesday", "18:00", "20:00"]]),
  group("04", "תרגיל", [["tuesday", "18:00", "20:00"]]),
];

it("draws a Group nobody picked in pencil, with no ink and no red pen", () => {
  const markup = week(offering(THREE_GROUPS));

  expect(markup).toContain('class="tile"');
  expect(markup).toContain('aria-pressed="false"');
  for (const forbidden of ["is-picked", "is-clashing", "hatch", "blocked"]) {
    expect(markup).not.toContain(forbidden);
  }
});

it("draws a Pick in ink, once, rather than over the option it replaced", () => {
  const markup = week(offering(THREE_GROUPS), {
    picks: [pick("הרצאה", "01", LECTURE_MEETINGS)],
  });

  expect(markup).toContain("tile is-picked");
  expect(markup).toContain('aria-pressed="true"');
  // the Group is on the week once: as the Pick, and not also as the pencil option it is,
  // which would stack a dashed block exactly over its own ink and halve the width of both
  expect(markup.match(/89-110 · Lecture · 01/g)).toHaveLength(1);
});

it("draws a Pick that Clashes in red pen, and still draws it", () => {
  const markup = week(offering(THREE_GROUPS), {
    picks: [pick("הרצאה", "01", LECTURE_MEETINGS)],
    // the key `week.ts` builds: the Course, the Lesson Type and the Group number
    clashing: new Set(["89-110|הרצאה|01"]),
  });

  expect(markup).toContain("is-clashing");
  expect(markup).toContain("is-picked");
  expect(markup).toContain("89-110 · Lecture · 01");
});

it("shows a Pick whose Course is not the one being browsed, and can name it", () => {
  // the Pick carries its own snapshot, so a week can draw it with no Catalog entry at all
  const markup = week(offering(THREE_GROUPS), {
    picks: [
      {
        courseNumber: "89-210",
        lessonType: "הרצאה",
        groupNumber: "02",
        meetings: [{ semester: "fall", day: "monday", start: "09:00", end: "11:00" }],
      },
    ],
  });

  expect(markup).toContain("89-210 · Lecture · 02");
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
        picks: [],
        selected: undefined,
        onSelect: () => {},
      }),
    );

  expect(picker("en")).toContain("1 group<");
  expect(picker("he")).toContain("קבוצה אחת");
});

it("says which Group is picked for a Course, beside the Course", () => {
  const one = offering([
    group("01", "הרצאה", [["sunday", "10:00", "12:00"]]),
    group("03", "תרגיל", [["monday", "10:00", "12:00"]]),
  ]);

  const markup = renderToStaticMarkup(
    createElement(CoursePicker, {
      language: "en",
      offerings: [one],
      picks: [pick("הרצאה", "01", [["sunday", "10:00", "12:00"]])],
      selected: undefined,
      onSelect: () => {},
    }),
  );

  expect(markup).toContain("Picked:");
  expect(markup).toContain("Lecture 01");
  // one Pick per Lesson Type, so the Tirgul it has not chosen is simply absent
  expect(markup).not.toContain("Tirgul 03");
});
