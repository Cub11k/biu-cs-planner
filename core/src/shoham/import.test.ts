import { expect, it } from "vitest";
import { importRawCrawl } from "./import.ts";

// The Academic Year is not in a Raw Crawl: Shoham's search form takes it, but no
// crawl on hand records it. The caller supplies it.
const YEAR_2027 = 2027;

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
    {
      rows: [
        {
          code: "89110",
          name: "מבוא למדעי המחשב",
          group: "01",
          teachers: "פרופ' נועה אגמון",
          kind: "הרצאה",
          semester: "סמסטר א'",
          day: "ג'",
          hours: "15:00 - 18:00",
          lid: "808655",
        },
      ],
      details: {},
    },
    { academicYear: YEAR_2027 },
  );

  expect(warnings).toEqual([]);
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

  expect(warnings).toEqual([]);
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

  expect(warnings).toEqual([]);
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
