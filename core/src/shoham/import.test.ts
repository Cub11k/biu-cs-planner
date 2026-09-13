import { expect, it } from "vitest";
import { importRawCrawl } from "./import.ts";

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
  return {
    code: "89110",
    name: "מבוא למדעי המחשב",
    group: "01",
    teachers: "פרופ' נועה אגמון",
    kind: "הרצאה",
    semester: "סמסטר א'",
    day: "ג'",
    hours: "15:00 - 18:00",
    lid: "808655",
    ...overrides,
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

it("takes credits and Exams from the Course-wide detail record", () => {
  const { catalog, warnings } = importRawCrawl(
    { rows: [row()], details: { "89110|סמסטר א'": DETAIL_89110_FALL } },
    { academicYear: YEAR_2027 },
  );

  expect(exceptProvenance(warnings)).toEqual([]);
  const offering = catalog.offerings[0]!;
  expect(offering.credits).toBe(4);
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
  expect(catalog.offerings[0]!.credits).toBe(4);
  expect(catalog.offerings[0]!.exams.known).toBe(true);
  // the part that was imported first is left alone
  expect(first.offerings[0]!.exams).toEqual({ known: false, sittings: [] });
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

it("applies a Year-long Group's single schedule to both Semesters", () => {
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

  const { catalog, summary } = importRawCrawl(
    {
      rows: [
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
    { rows: [row({ group: "02", semester: "סמסטר ב'סמסטר א'", day: "", hours: "" })] },
    { academicYear: YEAR_2027, into: first },
  );

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
