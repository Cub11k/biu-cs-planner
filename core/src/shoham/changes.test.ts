import { expect, it } from "vitest";
import { offeringChanges } from "./changes.ts";
import type { Group, Meeting, Offering } from "../catalog/schema.ts";

const TUESDAY: Meeting = { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" };
const WEDNESDAY: Meeting = { semester: "fall", day: "wednesday", start: "10:00", end: "13:00" };

function group(overrides: Partial<Group> = {}): Group {
  return { number: "01", lessonType: "הרצאה", lecturers: [], meetings: [TUESDAY], ...overrides };
}

function offering(overrides: Partial<Offering> = {}): Offering {
  return {
    courseNumber: "89-110",
    nameHebrew: "מבוא למדעי המחשב",
    semesters: ["fall"],
    groups: [group()],
    credits: { known: false },
    exams: { known: false, sittings: [] },
    ...overrides,
  };
}

it("says nothing about two Catalogs holding the same Offerings and Groups", () => {
  expect(offeringChanges([offering()], [offering()])).toEqual([]);
});

it("reports a Group the part brought that the Offering did not hold", () => {
  const after = offering({ groups: [group(), group({ number: "03", lessonType: "תרגיל" })] });

  expect(offeringChanges([offering()], [after])).toEqual([
    {
      courseNumber: "89-110",
      semesters: ["fall"],
      added: [{ number: "03", lessonType: "תרגיל", meetings: [TUESDAY] }],
      removed: [],
      moved: [],
      offeringRemoved: false,
    },
  ]);
});

it("reports a Group the Offering held and no longer does", () => {
  const before = offering({ groups: [group(), group({ number: "03", lessonType: "תרגיל" })] });

  expect(offeringChanges([before], [offering()])).toEqual([
    {
      courseNumber: "89-110",
      semesters: ["fall"],
      added: [],
      removed: [{ number: "03", lessonType: "תרגיל", meetings: [TUESDAY] }],
      moved: [],
      offeringRemoved: false,
    },
  ]);
});

it("reports a Group whose Meetings changed as moved, carrying both sets", () => {
  // Both sets, because what a Variant needs to show is the old time beside the new one.
  const after = offering({ groups: [group({ meetings: [WEDNESDAY] })] });

  expect(offeringChanges([offering()], [after])).toEqual([
    {
      courseNumber: "89-110",
      semesters: ["fall"],
      added: [],
      removed: [],
      moved: [
        { number: "01", lessonType: "הרצאה", before: [TUESDAY], after: [WEDNESDAY] },
      ],
      offeringRemoved: false,
    },
  ]);
});

it("does not call a Group moved for listing the same Meetings in another order", () => {
  // A Year-long row names its days in one cell, and nothing promises the cell's order is
  // stable between crawls. A reordering is not something a student should be told about.
  const before = offering({ groups: [group({ meetings: [TUESDAY, WEDNESDAY] })] });
  const after = offering({ groups: [group({ meetings: [WEDNESDAY, TUESDAY] })] });

  expect(offeringChanges([before], [after])).toEqual([]);
});

it("reports an Offering that is gone, with every Group it held", () => {
  expect(offeringChanges([offering()], [])).toEqual([
    {
      courseNumber: "89-110",
      semesters: ["fall"],
      added: [],
      removed: [{ number: "01", lessonType: "הרצאה", meetings: [TUESDAY] }],
      moved: [],
      offeringRemoved: true,
    },
  ]);
});

it("reports every Group of an Offering the part brought for the first time", () => {
  expect(offeringChanges([], [offering()])).toEqual([
    {
      courseNumber: "89-110",
      semesters: ["fall"],
      added: [{ number: "01", lessonType: "הרצאה", meetings: [TUESDAY] }],
      removed: [],
      moved: [],
      offeringRemoved: false,
    },
  ]);
});

it("matches an Offering to itself however its Semesters are ordered", () => {
  const before = offering({ semesters: ["spring", "fall"] });
  const after = offering({ semesters: ["fall", "spring"] });

  expect(offeringChanges([before], [after])).toEqual([]);
});

it("keeps a Course's two Offerings apart rather than reading them as one that changed", () => {
  const fall = offering({ semesters: ["fall"] });
  const yearLong = offering({ semesters: ["fall", "spring"], groups: [group({ number: "02" })] });

  expect(offeringChanges([fall], [yearLong])).toEqual([
    {
      courseNumber: "89-110",
      semesters: ["fall"],
      added: [],
      removed: [{ number: "01", lessonType: "הרצאה", meetings: [TUESDAY] }],
      moved: [],
      offeringRemoved: true,
    },
    {
      courseNumber: "89-110",
      semesters: ["fall", "spring"],
      added: [{ number: "02", lessonType: "הרצאה", meetings: [TUESDAY] }],
      removed: [],
      moved: [],
      offeringRemoved: false,
    },
  ]);
});

it("reads one number in two Lesson Types as two Groups, not one that changed", () => {
  const before = offering({ groups: [group({ lessonType: "הרצאה" })] });
  const after = offering({ groups: [group({ lessonType: "תרגיל", meetings: [WEDNESDAY] })] });

  const [change] = offeringChanges([before], [after]);
  expect(change!.added).toEqual([{ number: "01", lessonType: "תרגיל", meetings: [WEDNESDAY] }]);
  expect(change!.removed).toEqual([{ number: "01", lessonType: "הרצאה", meetings: [TUESDAY] }]);
  expect(change!.moved).toEqual([]);
});

it("reads a Catalog holding one Offering twice the way the merge reads it", () => {
  // A hand-edited Catalog can name one Course and Semester set twice. The merge seeds by
  // key, so the later entry is the one that survives; a report reading the earlier one would
  // tell a student the part removed Groups the merge never saw.
  const twice = [offering({ groups: [group({ number: "07" })] }), offering()];

  expect(offeringChanges(twice, [offering()])).toEqual([]);
});

it("hands back Meetings of its own rather than the Catalog's arrays", () => {
  const before = offering();
  const after = offering({ groups: [] });

  const [change] = offeringChanges([before], [after]);
  expect(change!.removed[0]!.meetings).not.toBe(before.groups[0]!.meetings);
  expect(change!.removed[0]!.meetings).toEqual([TUESDAY]);
});
