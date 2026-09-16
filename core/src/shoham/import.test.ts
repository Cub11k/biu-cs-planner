import { expect, it } from "vitest";
import { importRawCrawl } from "./import.ts";
import type { Catalog, Offering } from "../catalog/schema.ts";

// The Academic Year is not in a Raw Crawl: Shoham's search form takes it, but no
// crawl on hand records it. The caller supplies it.
const YEAR_2027 = 2027;

/**
 * No crawl on hand carries provenance, so every import of these fixtures warns about it.
 * Tests that are not about provenance say so by looking past it.
 */
function exceptProvenance(warnings: ReturnType<typeof importRawCrawl>["warnings"]) {
  return warnings.filter((w) => w.kind !== "provenance-missing");
}

/** A timed lecture row of 89-110; each test overrides only the fields it is about. */
function row(overrides: Partial<Parameters<typeof importRawCrawl>[0]["rows"] extends
  (infer R)[] | undefined ? R : never> = {}) {
  const merged = {
    code: "89110",
    name: "מבוא למדעי המחשב",
    group: "01",
    teachers: "פרופ' נועה אגמון",
    kind: "הרצאה",
    semester: "סמסטר א'",
    day: "ג'",
    hours: "15:00 - 18:00",
    ...overrides,
  };
  // Shoham gives every row its own lid, and `code|group|kind|semester` is unique across all
  // 510 rows of the crawl. A test that says nothing about lids still gets distinct ones, so
  // that two ordinary rows never read as the crawl contradicting itself.
  return {
    ...merged,
    lid: merged.lid ?? `${merged.code}-${merged.group}-${merged.kind}-${merged.semester}`,
  };
}

it("imports a timed lecture row as one Offering with one Group and one Meeting", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row()], details: {} },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([]);
  expect(catalog.academicYear).toBe(YEAR_2027);
  expect(catalog.offerings).toEqual([
    {
      courseNumber: "89-110",
      nameHebrew: "מבוא למדעי המחשב",
      semesters: ["fall"],
      groups: [
        {
          number: "01",
          lessonType: "הרצאה",
          lecturers: ["פרופ' נועה אגמון"],
          meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
        },
      ],
      credits: { known: false },
      exams: { known: false, sittings: [] },
    },
  ]);
});

it("collapses the Groups of one Course and Semester into a single Offering", () => {
  const { catalog } = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה", day: "ג'", hours: "15:00 - 18:00" }),
        row({ group: "03", kind: "תרגיל", day: "ד'", hours: "11:00 - 13:00" }),
      ],
      details: {},
    },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.offerings).toHaveLength(1);
  const offering = catalog.offerings[0]!;
  expect(offering.courseNumber).toBe("89-110");
  expect(offering.groups.map((g) => [g.number, g.lessonType])).toEqual([
    ["01", "הרצאה"],
    ["03", "תרגיל"],
  ]);
});

it("keeps the same Course in two Semesters as two Offerings", () => {
  const { catalog } = importRawCrawl(
    {
      rows: [
        row({ group: "01", semester: "סמסטר א'" }),
        row({ group: "01", semester: "סמסטר ב'" }),
      ],
      details: {},
    },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.offerings.map((o) => o.semesters)).toEqual([["fall"], ["spring"]]);
});

it("splits a Year-long Group's repeated hours across its two Semesters", () => {
  // 89-099 as Shoham really sends it: three days, six ranges, one Group, both Semesters.
  const { catalog, warnings } = importRawCrawl(
    {
      rows: [
        row({
          code: "89099",
          name: "שעות מחלקה לתלמידי תואר ראשון",
          kind: "ש.מחלקה",
          semester: "סמסטר א'\nסמסטר ב'",
          day: "א',ה',ו'",
          hours:
            "09:00 - 11:00\n09:00 - 11:00\n08:00 - 13:00\n09:00 - 11:00\n09:00 - 11:00\n08:00 - 13:00",
        }),
      ],
      details: {},
    },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([]);
  const offering = catalog.offerings[0]!;
  expect(offering.semesters).toEqual(["fall", "spring"]);
  expect(offering.groups[0]!.meetings).toEqual([
    { semester: "fall", day: "sunday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "thursday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "friday", start: "08:00", end: "13:00" },
    { semester: "spring", day: "sunday", start: "09:00", end: "11:00" },
    { semester: "spring", day: "thursday", start: "09:00", end: "11:00" },
    { semester: "spring", day: "friday", start: "08:00", end: "13:00" },
  ]);
});

const DETAIL_89110_FALL = {
  points: "4.00",
  code: "89110-01",
  hours: "סמסטר א' - 4.00",
  terms: [
    { type: "מועד א'", date: "07/02/2027", hour: "16:00" },
    { type: "מועד ב'", date: "26/02/2027", hour: "09:00" },
  ],
};

it("takes weekly hours and Exams from the detail record", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row()], details: { "89110|סמסטר א'": DETAIL_89110_FALL } },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([]);
  const offering = catalog.offerings[0]!;
  // the record was read from Group 01, so its hours belong to that Group
  expect(offering.groups[0]!.weeklyHours).toBe(4);
  // one Lesson Type, and it has hours, so the Offering's credits are settled
  expect(offering.credits).toEqual({ known: true, total: 4 });
  expect(offering.exams).toEqual({
    known: true,
    sittings: [
      { moed: "מועד א'", date: "2027-02-07", time: "16:00" },
      { moed: "מועד ב'", date: "2027-02-26", time: "09:00" },
    ],
  });
});

it("merges a details-only part into a Catalog already imported", () => {
  const first = importRawCrawl({ rows: [row()] }, { academicYear: YEAR_2027 }).catalog;
  expect(first.offerings[0]!.exams).toEqual({ known: false, sittings: [] });

  const { catalog } = importRawCrawl(
    { details: { "89110|סמסטר א'": DETAIL_89110_FALL } },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings).toHaveLength(1);
  expect(catalog.offerings[0]!.groups[0]!.weeklyHours).toBe(4);
  expect(catalog.offerings[0]!.exams.known).toBe(true);
  // the part that was imported first is left alone
  expect(first.offerings[0]!.exams).toEqual({ known: false, sittings: [] });
});

// --- a part imported twice: a Group is its number and its Lesson Type (issue #9) ---

it("updates the Group a repeated row names rather than holding it twice", () => {
  // Re-crawling before a registration window and importing the result over last month's
  // Catalog is the routine path, not an edge case: every row of it has been seen before.
  const first = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה" }),
        row({ group: "03", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
    },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog } = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה" }),
        row({ group: "03", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
    },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings).toHaveLength(1);
  expect(catalog.offerings[0]!.groups.map((g) => [g.number, g.lessonType])).toEqual([
    ["01", "הרצאה"],
    ["03", "תרגיל"],
  ]);
});

it("holds one Group per number and Lesson Type, so one number in two types stays two", () => {
  // The pair is the identity, not the number alone: Shoham numbers a Course's lecture and
  // its tirgul independently, and 01 of each is two Groups a student picks separately.
  // This one guards the shape of the identity rather than the duplication bug -- a key of
  // the number alone would collapse these two into one, and no re-import is needed to see it.
  const { catalog } = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה" }),
        row({ group: "01", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
    },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.offerings[0]!.groups.map((g) => [g.number, g.lessonType])).toEqual([
    ["01", "הרצאה"],
    ["01", "תרגיל"],
  ]);
});

it("moves a Group whose repeated row moved it, and re-staffs one that changed lecturers", () => {
  const first = importRawCrawl(
    { rows: [row({ day: "ג'", hours: "15:00 - 18:00", teachers: "פרופ' נועה אגמון" })] },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog } = importRawCrawl(
    { rows: [row({ day: "ד'", hours: "10:00 - 13:00", teachers: "ד\"ר יהודית גל-עזר" })] },
    { academicYear: YEAR_2027, into: first },
  );

  const group = catalog.offerings[0]!.groups[0]!;
  expect(group.meetings).toEqual([
    { semester: "fall", day: "wednesday", start: "10:00", end: "13:00" },
  ]);
  expect(group.lecturers).toEqual(['ד"ר יהודית גל-עזר']);
  // the Catalog merged into is left untouched, as every other merge leaves it (ADR-0010)
  expect(first.offerings[0]!.groups[0]!.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
  ]);
});

it("keeps weekly hours already known when a repeated row carries none", () => {
  // A row never carries hours -- only a detail record does -- so a part of rows alone must
  // not undo what an earlier part settled, or credits would come and go with each import.
  const first = importRawCrawl(
    {
      rows: [row({ group: "01", kind: "הרצאה", lid: "808655" })],
      sections: { "808655": { points: "3.00", code: "89110-01" } },
    },
    { academicYear: YEAR_2027 },
  ).catalog;
  expect(first.offerings[0]!.credits).toEqual({ known: true, total: 3 });

  const { catalog } = importRawCrawl(
    { rows: [row({ group: "01", kind: "הרצאה", lid: "808655" })] },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings[0]!.groups).toHaveLength(1);
  expect(catalog.offerings[0]!.groups[0]!.weeklyHours).toBe(3);
  expect(catalog.offerings[0]!.credits).toEqual({ known: true, total: 3 });
});

it("adds a Group a later part brings that the Catalog did not hold", () => {
  const first = importRawCrawl(
    { rows: [row({ group: "01", kind: "הרצאה" })] },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog } = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה" }),
        row({ group: "05", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
    },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings[0]!.groups.map((g) => [g.number, g.lessonType])).toEqual([
    ["01", "הרצאה"],
    ["05", "תרגיל"],
  ]);
  expect(first.offerings[0]!.groups).toHaveLength(1);
});

it("warns when a Year-long Group's hours do not divide evenly across its Semesters", () => {
  // Three days and four ranges divides no way at all: neither one block per Semester nor
  // one block shared by both. Three ranges would have been the legitimate shared form.
  const { catalog, warnings } = importRawCrawl(
    {
      rows: [
        row({
          code: "89099",
          group: "01",
          semester: "סמסטר א'\nסמסטר ב'",
          day: "א',ה',ו'",
          hours: "09:00 - 11:00\n09:00 - 11:00\n08:00 - 13:00\n10:00 - 12:00",
        }),
      ],
    },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "hours-do-not-divide", courseNumber: "89-099", group: "01" },
  ]);
  // what could be read is kept; the edit is never blocked
  expect(catalog.offerings[0]!.groups[0]!.meetings).toEqual([
    { semester: "fall", day: "sunday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "thursday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "friday", start: "08:00", end: "13:00" },
  ]);
});

it("warns on a Meeting it cannot read, and keeps the rest of the Group", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ day: "ג',ז'", hours: "15:00 - 18:00\n10:00 - 12:00" })] },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "meeting-unreadable", courseNumber: "89-110", group: "01" },
  ]);
  expect(catalog.offerings[0]!.groups[0]!.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
  ]);
});

it("imports an Untimed Group without complaint", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ group: "05", kind: "פרויקט", day: "", hours: "" })] },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([]);
  expect(catalog.offerings[0]!.groups[0]!.meetings).toEqual([]);
});

it("keeps Exams once known, even if a later part carries none", () => {
  const withExams = importRawCrawl(
    { rows: [row()], details: { "89110|סמסטר א'": DETAIL_89110_FALL } },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog } = importRawCrawl(
    { details: { "89110|סמסטר א'": { points: "4.00", code: "89110-07", terms: [] } } },
    { academicYear: YEAR_2027, into: withExams },
  );

  expect(catalog.offerings[0]!.exams.sittings).toHaveLength(2);
});

it("matches a Year-long detail key written without a separator", () => {
  const yearLong = importRawCrawl(
    { rows: [row({ code: "89385", semester: "סמסטר א'\nסמסטר ב'", day: "", hours: "" })] },
    { academicYear: YEAR_2027 },
  ).catalog;
  expect(yearLong.offerings[0]!.semesters).toEqual(["fall", "spring"]);

  const { catalog } = importRawCrawl(
    { details: { "89385|סמסטר א'סמסטר ב'": DETAIL_89110_FALL } },
    { academicYear: YEAR_2027, into: yearLong },
  );

  expect(catalog.offerings[0]!.exams.known).toBe(true);
});

it("warns about a course number with an unusual tail, and imports it as its own Course", () => {
  // 8912000 is מבני נתונים alongside the ordinary 891200. The Importer stays faithful; an
  // Equivalence in a Requirements File is how the two are declared to be one Course.
  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ code: "8912000" }), row({ code: "8912000", group: "02", kind: "תרגיל" })] },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "unusual-course-number", courseNumber: "89-12000" },
  ]);
  expect(catalog.offerings[0]!.courseNumber).toBe("89-12000");
});

it("applies a Year-long Group's single set of Meetings to both Semesters", () => {
  // 89-1100 as Shoham sends it: both Semesters, one day, one range, no repetition.
  // Eight of the fifteen timed Year-long rows look like this, not like 89-099.
  const { catalog, warnings } = importRawCrawl(
    {
      rows: [
        row({
          code: "891100",
          semester: "סמסטר א'\nסמסטר ב'",
          day: "ב'",
          hours: "15:00 - 18:00",
        }),
      ],
    },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([]);
  expect(catalog.offerings[0]!.groups[0]!.meetings).toEqual([
    { semester: "fall", day: "monday", start: "15:00", end: "18:00" },
    { semester: "spring", day: "monday", start: "15:00", end: "18:00" },
  ]);
});

it("warns when a part carries no provenance, and keeps it when it does", () => {
  const without = importRawCrawl({ rows: [row()] }, { academicYear: YEAR_2027 });
  expect(without.warnings).toEqual([{ kind: "provenance-missing" }]);
  expect(without.catalog.sources).toEqual([]);

  const provenance = {
    query: "department=84&year=2027",
    crawledAt: "2026-09-13T10:00:00Z",
    crawlerVersion: "2",
  };
  const withIt = importRawCrawl({ rows: [row()], provenance }, { academicYear: YEAR_2027 });
  expect(withIt.warnings).toEqual([]);
  expect(withIt.catalog.sources).toEqual([provenance]);
});

it("keeps the provenance of every part it merges", () => {
  const first = importRawCrawl(
    { rows: [row()], provenance: { crawlerVersion: "2" } },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog } = importRawCrawl(
    { details: { "89110|סמסטר א'": DETAIL_89110_FALL }, provenance: { crawlerVersion: "3" } },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.sources).toEqual([{ crawlerVersion: "2" }, { crawlerVersion: "3" }]);
});

it("merges a second rows part, adding a Group here and an Offering there", () => {
  const first = importRawCrawl({ rows: [row()] }, { academicYear: YEAR_2027 }).catalog;

  // The second part re-carries 89-110's lecture beside the tirgul it brings. A part speaks
  // for the Offerings it carries rows for (ADR-0011), so a part naming the tirgul alone
  // would be saying the lecture is gone rather than adding to it.
  const { catalog, summary } = importRawCrawl(
    {
      rows: [
        row(),
        row({ group: "03", kind: "תרגיל", hours: "18:00 - 20:00" }),
        // another department entirely: this is how a double major is covered
        row({ code: "10123", name: "יסודות", group: "01", teachers: "" }),
      ],
    },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings.map((o) => [o.courseNumber, o.groups.length])).toEqual([
    ["89-110", 2],
    ["10-123", 1],
  ]);
  expect(summary).toEqual({ offerings: 2, groups: 3, meetings: 3, exams: 0 });
});

// --- findings from the review: the import path dropped things quietly ---------

it("warns when a detail record matches no Offering, instead of importing nothing quietly", () => {
  // ADR-0010 makes this a supported flow: a details-only part can arrive before its rows.
  const { catalog, summary, warnings } = importRawCrawl(
    { details: { "89110|סמסטר א'": DETAIL_89110_FALL } },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.offerings).toEqual([]);
  expect(summary.offerings).toBe(0);
  expect(exceptProvenance(warnings)).toEqual([
    { kind: "detail-without-offering", courseNumber: "89-110", semesters: ["fall"] },
  ]);
});

it("warns on a detail key it cannot read", () => {
  const { warnings } = importRawCrawl(
    { rows: [row()], details: { "no-separator-here": DETAIL_89110_FALL } },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "detail-key-unreadable", key: "no-separator-here" },
  ]);
});

it("warns on a Semester cell it cannot read", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ semester: "שנתי" })] },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "semester-unreadable", courseNumber: "89-110", group: "01" },
  ]);
  expect(catalog.offerings[0]!.semesters).toEqual([]);
});

it("warns on a course code it cannot read", () => {
  const { warnings } = importRawCrawl({ rows: [row({ code: "" })] }, { academicYear: YEAR_2027 });

  expect(exceptProvenance(warnings)).toContainEqual({ kind: "course-number-unreadable", code: "" });
});

it("merges a Year-long Offering however its Semester labels are ordered", () => {
  const first = importRawCrawl(
    { rows: [row({ semester: "סמסטר א'\nסמסטר ב'", day: "", hours: "" })] },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog } = importRawCrawl(
    {
      rows: [
        row({ group: "01", semester: "סמסטר ב'סמסטר א'", day: "", hours: "" }),
        row({ group: "02", semester: "סמסטר ב'סמסטר א'", day: "", hours: "" }),
      ],
    },
    { academicYear: YEAR_2027, into: first },
  );

  // one Offering, not two: the key must not depend on which way round the cell names them
  expect(catalog.offerings).toHaveLength(1);
  expect(catalog.offerings[0]!.semesters).toEqual(["fall", "spring"]);
  expect(catalog.offerings[0]!.groups.map((g) => g.number)).toEqual(["01", "02"]);
});

it("refuses to merge a part into a Catalog of another Academic Year", () => {
  const first = importRawCrawl({ rows: [row()] }, { academicYear: YEAR_2027 }).catalog;

  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ group: "03" })] },
    { academicYear: 2030, into: first },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "academic-year-mismatch", catalog: YEAR_2027, part: 2030 },
  ]);
  // the Catalog is left exactly as it was rather than relabelled
  expect(catalog.academicYear).toBe(YEAR_2027);
  expect(catalog.offerings[0]!.groups).toHaveLength(1);
});

it("warns on a time that is not a real clock time, rather than storing it", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ day: "ג'", hours: "25:99 - 30:00" })] },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "meeting-unreadable", courseNumber: "89-110", group: "01" },
  ]);
  expect(catalog.offerings[0]!.groups[0]!.meetings).toEqual([]);
});

it("warns on an Exam date it cannot read, rather than storing it", () => {
  const { catalog, warnings } = importRawCrawl(
    {
      rows: [row()],
      details: {
        "89110|סמסטר א'": {
          points: "3.00",
          code: "89110-01",
          terms: [
            { type: "מועד א'", date: "32/13/2027", hour: "09:00" },
            { type: "מועד ב'", date: "11/02/2027", hour: "16:00" },
          ],
        },
      },
    },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "exam-unreadable", courseNumber: "89-110" },
  ]);
  // the readable sitting still lands
  expect(catalog.offerings[0]!.exams).toEqual({
    known: true,
    sittings: [{ moed: "מועד ב'", date: "2027-02-11", time: "16:00" }],
  });
});

it("leaves credits unknown while a Lesson Type has no hours of its own", () => {
  // A detail record covers the one Group it was read from. 89-132's real credits are the
  // lecture's 4 plus a tirgul's 2; one record cannot say that, so it must not pretend to.
  const { catalog } = importRawCrawl(
    {
      rows: [
        row({ code: "89132", group: "01", kind: "הרצאה" }),
        row({ code: "89132", group: "03", kind: "תרגיל" }),
      ],
      details: {
        "89132|סמסטר א'": { points: "4.00", code: "89132-01", terms: [] },
      },
    },
    { academicYear: YEAR_2027 },
  );

  const offering = catalog.offerings[0]!;
  expect(offering.groups.map((g) => [g.number, g.weeklyHours])).toEqual([
    ["01", 4],
    ["03", undefined],
  ]);
  expect(offering.credits).toEqual({ known: false });
});

it("settles credits once every Lesson Type has hours, summing one per type", () => {
  const first = importRawCrawl(
    {
      rows: [
        row({ code: "89132", group: "01", kind: "הרצאה" }),
        row({ code: "89132", group: "03", kind: "תרגיל" }),
      ],
      details: { "89132|סמסטר א'": { points: "4.00", code: "89132-01", terms: [] } },
    },
    { academicYear: YEAR_2027 },
  ).catalog;

  // a later part, read from the tirgul Group this time
  const { catalog } = importRawCrawl(
    { details: { "89132|סמסטר א'": { points: "2.00", code: "89132-03", terms: [] } } },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings[0]!.credits).toEqual({ known: true, total: 6 });
});

it("refuses a sampled record's hours when its number names two Groups, and says so", () => {
  // A course-wide record names its Group by number alone, which the lecture and the tirgul
  // can share. Guessing would put the lecture's 4.00 on whichever came first and hand the
  // Offering a wrong credit total; a Group whose hours nobody published stays unsettled.
  const { catalog, warnings } = importRawCrawl(
    {
      rows: [
        row({ code: "89132", group: "01", kind: "הרצאה" }),
        row({ code: "89132", group: "01", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
      details: { "89132|סמסטר א'": { points: "4.00", code: "89132-01", terms: [] } },
    },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "detail-group-ambiguous", courseNumber: "89-132", group: "01" },
  ]);
  const offering = catalog.offerings[0]!;
  expect(offering.groups.map((g) => g.weeklyHours)).toEqual([undefined, undefined]);
  expect(offering.credits).toEqual({ known: false });
});

it("still lands a sampled record's hours when its number names exactly one Group", () => {
  const { catalog, warnings } = importRawCrawl(
    {
      rows: [
        row({ code: "89132", group: "01", kind: "הרצאה" }),
        row({ code: "89132", group: "03", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
      details: { "89132|סמסטר א'": { points: "4.00", code: "89132-01", terms: [] } },
    },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([]);
  expect(catalog.offerings[0]!.groups.map((g) => g.weeklyHours)).toEqual([4, undefined]);
});

it("warns when a detail record does not say which Group it came from", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row()], details: { "89110|סמסטר א'": { points: "4.00", terms: [] } } },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    { kind: "detail-group-unknown", courseNumber: "89-110" },
  ]);
  expect(catalog.offerings[0]!.groups[0]!.weeklyHours).toBeUndefined();
});

// --- what the 2026-09-13 crawl added: per-Group records, English names, provenance ---

it("takes a Group's weekly hours from the detail record keyed by its own lid", () => {
  // 89-110 Fall as the crawl really sends it: the lecture reads 3.00 and the tirgul 2.00,
  // and the department's yedion gives the Course lecture_h 3.0, exercise_h 2.0, total_h 5.0.
  const { catalog, warnings } = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה", lid: "808655" }),
        row({ group: "03", kind: "תרגיל", hours: "18:00 - 20:00", lid: "822335" }),
      ],
      sections: {
        "808655": { points: "3.00", code: "89110-01" },
        "822335": { points: "2.00", code: "89110-03" },
      },
    },
    { academicYear: YEAR_2027 },
  );

  const offering = catalog.offerings[0]!;
  expect(exceptProvenance(warnings)).toEqual([]);
  expect(offering.groups.map((g) => [g.number, g.weeklyHours])).toEqual([
    ["01", 3],
    ["03", 2],
  ]);
  expect(offering.credits).toEqual({ known: true, total: 5 });
});

it("lets a per-Group record's hours win over the figure a sampled record gave", () => {
  // A course-wide record speaks for whichever Group Shoham happened to hand back; a
  // per-Group record names its Group outright. Where they disagree, the one that knows wins.
  const { catalog } = importRawCrawl(
    {
      rows: [row({ group: "01", lid: "808655" })],
      details: { "89110|סמסטר א'": { points: "4.00", code: "89110-01", terms: [] } },
      sections: { "808655": { points: "3.00", code: "89110-01" } },
    },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.offerings[0]!.groups[0]!.weeklyHours).toBe(3);
});

it("warns about a detail record whose lid matches no Group, rather than dropping it", () => {
  // A Group carries no lid of its own, so a part of records alone has nothing to match on.
  // ADR-0010 allows such a part to arrive, and it must say it recorded nothing.
  const first = importRawCrawl({ rows: [row({ lid: "808655" })] }, { academicYear: YEAR_2027 })
    .catalog;

  const { catalog, warnings } = importRawCrawl(
    { sections: { "808655": { points: "3.00", code: "89110-01" } } },
    { academicYear: YEAR_2027, into: first },
  );

  expect(exceptProvenance(warnings)).toEqual([{ kind: "detail-without-group", lid: "808655" }]);
  expect(catalog.offerings[0]!.groups[0]!.weeklyHours).toBeUndefined();
});

it("takes an Offering's English name from its per-Group records, and leaves it out otherwise", () => {
  // The results grid has no English column, so these records are the only source of one.
  const { catalog } = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה", lid: "808655" }),
        row({ group: "03", kind: "תרגיל", lid: "822335" }),
      ],
      sections: {
        "808655": { points: "3.00", code: "89110-01", name_en: "Intro to Computers" },
        "822335": { points: "2.00", code: "89110-03", name_en: "Intro to Computers" },
      },
    },
    { academicYear: YEAR_2027 },
  );

  const offering = catalog.offerings[0]!;
  expect(offering.nameHebrew).toBe("מבוא למדעי המחשב");
  expect(offering.nameEnglish).toBe("Intro to Computers");

  // a crawl from before the field was captured leaves the Offering with its Hebrew name only
  const older = importRawCrawl({ rows: [row()] }, { academicYear: YEAR_2027 }).catalog;
  expect(older.offerings[0]!.nameEnglish).toBeUndefined();
});

it("treats a blank English name as absent rather than storing an empty one", () => {
  const { catalog } = importRawCrawl(
    {
      rows: [row({ lid: "808655" })],
      sections: { "808655": { points: "3.00", code: "89110-01", name_en: "  " } },
    },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.offerings[0]!.nameEnglish).toBeUndefined();
});

/** The meta block of the 2026-09-13 crawl, with the counters that say nothing here left off. */
const META = {
  schema: 1,
  script: "scripts/crawl/v1-crawl.js",
  label: "2027-cs",
  mode: "all",
  scraped_at: "2026-09-13T13:53:03.017Z",
  source: "https://courses.biu.ac.il/CoursesView.aspx",
  complete: true,
};

it("reads a part's provenance from its meta block, and stops warning about it", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row()], meta: META },
    { academicYear: YEAR_2027 },
  );

  expect(warnings).toEqual([]);
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

it("records a crawl that stopped early as the partial part it is", () => {
  const { catalog } = importRawCrawl(
    { rows: [row()], meta: { ...META, complete: false } },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.sources[0]!.complete).toBe(false);
});

it("keeps whatever a thin meta block does say, without inventing the rest", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row()], meta: { scraped_at: "2026-09-13T13:53:03.017Z" } },
    { academicYear: YEAR_2027 },
  );

  expect(warnings).toEqual([]);
  expect(catalog.sources).toEqual([{ crawledAt: "2026-09-13T13:53:03.017Z" }]);
});

it("still warns when a meta block carries nothing worth recording", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row()], meta: { reported_total: 513 } },
    { academicYear: YEAR_2027 },
  );

  expect(warnings).toEqual([{ kind: "provenance-missing" }]);
  expect(catalog.sources).toEqual([]);
});

it("warns when two rows claim one lid, instead of letting one Group lose its record", () => {
  // A row's identity is its lid. Two rows claiming one is the crawl contradicting itself,
  // and the Group that loses the match would otherwise be left short of its hours silently.
  const { catalog, warnings } = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה", lid: "808655" }),
        row({ group: "03", kind: "תרגיל", lid: "808655" }),
      ],
      sections: { "808655": { points: "2.00", code: "89110-03" } },
    },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([{ kind: "lid-not-unique", lid: "808655" }]);
  // the later row keeps the lid, so its Group is the one the record reaches
  expect(catalog.offerings[0]!.groups.map((g) => [g.number, g.weeklyHours])).toEqual([
    ["01", undefined],
    ["03", 2],
  ]);
});

it("settles credits at zero hours, rather than letting a later Group unsettle them", () => {
  // 89-100 Fall as the crawl sends it: two הדרכה Groups, the first reading 0.00 and the
  // second never read at all. Zero weekly hours is a real figure here, not a blank.
  const { catalog } = importRawCrawl(
    {
      rows: [
        row({ code: "89100", group: "03", kind: "הדרכה", day: "", hours: "", lid: "820000" }),
        row({ code: "89100", group: "04", kind: "הדרכה", day: "", hours: "", lid: "820001" }),
      ],
      sections: { "820000": { points: "0.00", code: "89100-03" } },
    },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.offerings[0]!.credits).toEqual({ known: true, total: 0 });
});

it("prefers the meta block over a provenance handed in already shaped", () => {
  const { catalog } = importRawCrawl(
    { rows: [row()], meta: META, provenance: { crawlerVersion: "2" } },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.sources).toHaveLength(1);
  expect(catalog.sources[0]!.crawlerVersion).toBe("scripts/crawl/v1-crawl.js");
});

it("warns when a Group's own Meetings overlap, naming the Course, the Group and both", () => {
  // The crawl sends this Group as meeting twice on Tuesday, once 15:00-18:00 and once
  // 16:00-17:00. #14 ruled that is not a Clash; it is a Catalog problem, and this is where
  // it gets said.
  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ day: "ג', ג'", hours: "15:00 - 18:00\n16:00 - 17:00" })] },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([
    {
      kind: "group-meetings-overlap",
      courseNumber: "89-110",
      semesters: ["fall"],
      group: "01",
      lessonType: "הרצאה",
      first: { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
      second: { semester: "fall", day: "tuesday", start: "16:00", end: "17:00" },
    },
  ]);
  // the Warning never blocks: both Meetings are imported exactly as they were read
  expect(catalog.offerings[0]!.groups[0]!.meetings).toHaveLength(2);
});

it("names the Semesters too, since one Course can hold two Offerings numbered from 01", () => {
  // 89-110 given Year-long and again in Fall only is two Offerings, each with its own 01
  // lecture. Without the Semesters the two Warnings would read identically and a maintainer
  // could not tell which Shoham page to open.
  const { warnings } = importRawCrawl(
    {
      rows: [
        row({ semester: "סמסטר א'סמסטר ב'", day: "ג', ג'", hours: "15:00 - 18:00\n16:00 - 17:00" }),
        row({ day: "ג', ג'", hours: "15:00 - 18:00\n16:00 - 17:00" }),
      ],
    },
    { academicYear: YEAR_2027 },
  );

  const overlaps = exceptProvenance(warnings).filter((w) => w.kind === "group-meetings-overlap");
  expect(overlaps.map((w) => (w as { semesters: string[] }).semesters)).toEqual([
    ["fall", "spring"],
    ["fall", "spring"],
    ["fall"],
  ]);
});

it("does not warn about a Group whose Meetings merely abut", () => {
  const { warnings } = importRawCrawl(
    { rows: [row({ day: "ג', ג'", hours: "15:00 - 17:00\n17:00 - 19:00" })] },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([]);
});

it("does not warn about a Year-long Group for meeting at one hour in both Semesters", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ semester: "סמסטר א'סמסטר ב'" })] },
    { academicYear: YEAR_2027 },
  );

  expect(catalog.offerings[0]!.groups[0]!.meetings).toHaveLength(2);
  expect(exceptProvenance(warnings)).toEqual([]);
});

it("says nothing about a Group this part never carried, however the Catalog holds it", () => {
  // Every Warning this Importer produces speaks about the part being imported. The
  // overlapping Group below came from an earlier part, which is where it was reported;
  // re-reading it out of the Catalog would repeat that Warning on every later merge.
  const { warnings } = importRawCrawl(
    { rows: [row({ code: "89132", group: "02" })] },
    {
      academicYear: YEAR_2027,
      into: {
        schemaVersion: 1,
        academicYear: YEAR_2027,
        sources: [],
        offerings: [
          {
            courseNumber: "89-210",
            nameHebrew: "מבני נתונים",
            semesters: ["fall"],
            credits: { known: false },
            exams: { known: false, sittings: [] },
            groups: [
              {
                number: "04",
                lessonType: "תרגיל",
                lecturers: [],
                meetings: [
                  { semester: "fall", day: "monday", start: "10:00", end: "12:00" },
                  { semester: "fall", day: "monday", start: "11:00", end: "13:00" },
                ],
              },
            ],
          },
        ],
      },
    },
  );

  expect(exceptProvenance(warnings)).toEqual([]);
});

// --- what a part supersedes, and what it reports changing (issue #22) ---------
//
// #9 settled a repeated row updating the Group it names. The other half of a re-crawl is a
// Group the new crawl no longer carries, and the rule this section holds to is the one
// ADR-0011 records: a part speaks for the Offerings it carries rows for, and for the same
// Course's other Offerings whose Semesters its rows overlap. It speaks for nothing else.

/** A Catalog holding exactly the Offerings given, as an earlier import would have left it. */
function catalogOf(...offerings: Offering[]): Catalog {
  return { schemaVersion: 1, academicYear: YEAR_2027, sources: [], offerings };
}

it("removes a Group from an Offering the part carries rows for and does not name", () => {
  const first = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה" }),
        row({ group: "03", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
    },
    { academicYear: YEAR_2027 },
  ).catalog;

  // January's crawl: BIU cancelled the tirgul, so no row carries it any more.
  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ group: "01", kind: "הרצאה" })] },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings[0]!.groups.map((g) => [g.number, g.lessonType])).toEqual([
    ["01", "הרצאה"],
  ]);
  expect(exceptProvenance(warnings)).toEqual([
    {
      kind: "group-superseded",
      courseNumber: "89-110",
      semesters: ["fall"],
      group: "03",
      lessonType: "תרגיל",
    },
  ]);
  // the Catalog merged into is left as it was, as every other merge leaves it (ADR-0010)
  expect(first.offerings[0]!.groups).toHaveLength(2);
});

it("leaves an Offering's Groups alone when the part carries no row for it", () => {
  // A part crawled for another department carries no CS row at all, and must not empty the
  // Catalog on the first double-major import.
  const first = importRawCrawl({ rows: [row()] }, { academicYear: YEAR_2027 }).catalog;

  const { catalog, warnings, changes } = importRawCrawl(
    { rows: [row({ code: "10123", name: "יסודות", group: "01", teachers: "" })] },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings.map((o) => [o.courseNumber, o.groups.length])).toEqual([
    ["89-110", 1],
    ["10-123", 1],
  ]);
  expect(exceptProvenance(warnings)).toEqual([]);
  expect(changes.map((c) => c.courseNumber)).toEqual(["10-123"]);
});

it("removes nothing at all when the part carries no rows", () => {
  // A details-only part is how an Academic Year already imported gains its Exams (ADR-0010).
  // It speaks for no Offering, so it supersedes nothing.
  const first = importRawCrawl(
    { rows: [row({ group: "01" }), row({ group: "03", kind: "תרגיל", hours: "11:00 - 13:00" })] },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog, warnings, changes } = importRawCrawl(
    { details: { "89110|סמסטר א'": DETAIL_89110_FALL } },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings[0]!.groups).toHaveLength(2);
  expect(exceptProvenance(warnings).filter((w) => w.kind === "group-superseded")).toEqual([]);
  expect(changes).toEqual([]);
});

it("supersedes a Fall Offering when the same Course comes back Year-long", () => {
  // 89-385 is the kind of Course this happens to. Keyed on Course plus Semesters, the
  // Year-long rows form a second Offering; without this the Catalog would hold the Course
  // twice with nothing to say which of the two is dead.
  const first = importRawCrawl(
    { rows: [row({ code: "89385", name: "מעבדת פרויקט", group: "01", semester: "סמסטר א'" })] },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog, warnings, changes } = importRawCrawl(
    {
      rows: [
        row({ code: "89385", name: "מעבדת פרויקט", group: "01", semester: "סמסטר א'\nסמסטר ב'" }),
      ],
    },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings.map((o) => [o.courseNumber, o.semesters])).toEqual([
    ["89-385", ["fall", "spring"]],
  ]);
  expect(exceptProvenance(warnings)).toEqual([
    {
      kind: "group-superseded",
      courseNumber: "89-385",
      semesters: ["fall"],
      group: "01",
      lessonType: "הרצאה",
    },
  ]);
  expect(changes.find((c) => c.offeringRemoved)).toMatchObject({
    courseNumber: "89-385",
    semesters: ["fall"],
  });
});

it("leaves a Course's Spring Offering alone when the part carries only its Fall rows", () => {
  // The other direction of the same rule: Semesters that do not overlap are not spoken for,
  // so a part of one Semester never empties another's.
  const first = importRawCrawl(
    {
      rows: [
        row({ group: "01", semester: "סמסטר א'" }),
        row({ group: "02", semester: "סמסטר ב'" }),
      ],
    },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog, warnings } = importRawCrawl(
    { rows: [row({ group: "01", semester: "סמסטר א'" })] },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings.map((o) => [o.semesters, o.groups.map((g) => g.number)])).toEqual([
    [["fall"], ["01"]],
    [["spring"], ["02"]],
  ]);
  expect(exceptProvenance(warnings)).toEqual([]);
});

it("keeps a Course held in four Semester spellings at once, since every one carries rows", () => {
  // 89-100 is really crawled this way: Fall, Spring, Summer and Year-long in the one part.
  // Each Offering is spoken for by its own rows, so none of the four supersedes another.
  const spellings = ["סמסטר א'", "סמסטר ב'", "סמסטר ק'", "סמסטר א'\nסמסטר ב'"];
  const rows = spellings.map((semester, i) =>
    row({ code: "89100", name: "פרויקט חונכות", group: `0${i + 1}`, semester, day: "", hours: "" })
  );

  const { catalog, warnings } = importRawCrawl({ rows }, { academicYear: YEAR_2027 });
  const { catalog: again, warnings: againWarnings, changes } = importRawCrawl(
    { rows },
    { academicYear: YEAR_2027, into: catalog },
  );

  expect(again.offerings.map((o) => o.semesters)).toEqual([
    ["fall"],
    ["spring"],
    ["summer"],
    ["fall", "spring"],
  ]);
  expect(exceptProvenance(warnings)).toEqual([]);
  expect(exceptProvenance(againWarnings)).toEqual([]);
  expect(changes).toEqual([]);
});

it("reports the Groups a part adds, removes and moves, per Offering", () => {
  const first = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה", day: "ג'", hours: "15:00 - 18:00" }),
        row({ group: "03", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
    },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { changes } = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה", day: "ד'", hours: "10:00 - 13:00" }),
        row({ group: "05", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
    },
    { academicYear: YEAR_2027, into: first },
  );

  expect(changes).toEqual([
    {
      courseNumber: "89-110",
      semesters: ["fall"],
      added: [
        {
          number: "05",
          lessonType: "תרגיל",
          meetings: [{ semester: "fall", day: "tuesday", start: "11:00", end: "13:00" }],
        },
      ],
      removed: [
        {
          number: "03",
          lessonType: "תרגיל",
          meetings: [{ semester: "fall", day: "tuesday", start: "11:00", end: "13:00" }],
        },
      ],
      moved: [
        {
          number: "01",
          lessonType: "הרצאה",
          before: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
          after: [{ semester: "fall", day: "wednesday", start: "10:00", end: "13:00" }],
        },
      ],
      offeringRemoved: false,
    },
  ]);
});

it("reports every Offering a first import brings as added", () => {
  const { changes } = importRawCrawl({ rows: [row()] }, { academicYear: YEAR_2027 });

  expect(changes).toEqual([
    {
      courseNumber: "89-110",
      semesters: ["fall"],
      added: [
        {
          number: "01",
          lessonType: "הרצאה",
          meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
        },
      ],
      removed: [],
      moved: [],
      offeringRemoved: false,
    },
  ]);
});

it("reports no change when a part is imported over the Catalog it built", () => {
  const rows = [
    row({ group: "01", kind: "הרצאה" }),
    row({ group: "03", kind: "תרגיל", hours: "11:00 - 13:00" }),
    row({ code: "89385", name: "מעבדת פרויקט", group: "01", semester: "סמסטר א'\nסמסטר ב'" }),
  ];
  const first = importRawCrawl({ rows }, { academicYear: YEAR_2027 }).catalog;

  const { changes, warnings } = importRawCrawl({ rows }, { academicYear: YEAR_2027, into: first });

  expect(changes).toEqual([]);
  expect(exceptProvenance(warnings)).toEqual([]);
});

it("reports no change when a part carries no rows at all and nothing was there", () => {
  const { changes } = importRawCrawl({}, { academicYear: YEAR_2027 });

  expect(changes).toEqual([]);
});

it("refuses a part of another Academic Year without reporting a change", () => {
  const first = importRawCrawl({ rows: [row()] }, { academicYear: YEAR_2027 }).catalog;

  const { changes } = importRawCrawl(
    { rows: [row({ group: "03" })] },
    { academicYear: 2030, into: first },
  );

  expect(changes).toEqual([]);
});

it("does not let a superseded Group take a detail record's hours with it", () => {
  // The Groups are settled before the details are read, so a stale Group cannot make a
  // sampled record ambiguous, nor take hours that belong to the Group that replaced it.
  const first = importRawCrawl(
    {
      rows: [
        row({ group: "01", kind: "הרצאה" }),
        row({ group: "01", kind: "תרגיל", hours: "11:00 - 13:00" }),
      ],
    },
    { academicYear: YEAR_2027 },
  ).catalog;

  const { catalog, warnings } = importRawCrawl(
    {
      rows: [row({ group: "01", kind: "הרצאה" })],
      details: { "89110|סמסטר א'": { points: "3.00", code: "89110-01" } },
    },
    { academicYear: YEAR_2027, into: first },
  );

  expect(catalog.offerings[0]!.groups.map((g) => [g.lessonType, g.weeklyHours])).toEqual([
    ["הרצאה", 3],
  ]);
  expect(exceptProvenance(warnings).filter((w) => w.kind === "detail-group-ambiguous")).toEqual([]);
});

it("leaves an Offering the Catalog holds without Groups where it is", () => {
  // Only supersession removes an Offering, and only by taking its last Group off it. An
  // Offering that already held none -- a hand-written Catalog naming Exams and nothing else
  // -- has nothing taken from it, so it stays, Exams and all.
  const { catalog, changes } = importRawCrawl(
    { rows: [row({ code: "89110", semester: "סמסטר א'\nסמסטר ב'" })] },
    {
      academicYear: YEAR_2027,
      into: catalogOf({
        courseNumber: "89-110",
        nameHebrew: "מבוא למדעי המחשב",
        semesters: ["fall"],
        credits: { known: false },
        exams: { known: true, sittings: [{ moed: "מועד א'", date: "2027-01-21", time: "16:00" }] },
        groups: [],
      }),
    },
  );

  expect(catalog.offerings.map((o) => [o.semesters, o.groups.length])).toEqual([
    [["fall"], 0],
    [["fall", "spring"], 1],
  ]);
  expect(changes.map((c) => c.semesters)).toEqual([["fall", "spring"]]);
});
