import { expect, it } from "vitest";
import type { Day, Group, Semester } from "../catalog/schema.ts";
import { findClashes, type PickedGroup, type WeeklySpan } from "./clashes.ts";

/**
 * Invented fixtures throughout: course numbers 99-xxx exist in no Catalog, so no test here
 * can quietly start depending on real crawl data.
 */
function span(day: Day, start: string, end: string, semester: Semester = "fall"): WeeklySpan {
  return { semester, day, start, end };
}

function group(
  courseNumber: string,
  meetings: readonly WeeklySpan[],
  lessonType = "lecture",
  number = "01",
): PickedGroup {
  return { courseNumber, lessonType, number, meetings };
}

it("reports two Meetings that overlap on the same Day of the same Semester as one Clash", () => {
  const clashes = findClashes([
    group("99-101", [span("sunday", "10:00", "12:00")]),
    group("99-202", [span("sunday", "11:00", "13:00")]),
  ]);

  expect(clashes).toEqual([
    {
      kind: "meeting-meeting",
      overlap: { semester: "fall", day: "sunday", start: "11:00", end: "12:00" },
      first: {
        group: { courseNumber: "99-101", lessonType: "lecture", number: "01" },
        meeting: span("sunday", "10:00", "12:00"),
      },
      second: {
        group: { courseNumber: "99-202", lessonType: "lecture", number: "01" },
        meeting: span("sunday", "11:00", "13:00"),
      },
    },
  ]);
});

it("reports a Meeting wholly inside another as a Clash spanning the shorter one", () => {
  const clashes = findClashes([
    group("99-101", [span("monday", "09:00", "17:00")]),
    group("99-202", [span("monday", "12:00", "13:00")]),
  ]);

  expect(clashes).toHaveLength(1);
  expect(clashes[0]?.overlap).toEqual(span("monday", "12:00", "13:00"));
});

it("does not report Meetings that abut exactly", () => {
  const clashes = findClashes([
    group("99-101", [span("tuesday", "08:00", "10:00")]),
    group("99-202", [span("tuesday", "10:00", "12:00")]),
  ]);

  expect(clashes).toEqual([]);
});

it("does not report Meetings on the same Day of different Semesters", () => {
  const clashes = findClashes([
    group("99-101", [span("wednesday", "10:00", "12:00", "fall")]),
    group("99-202", [span("wednesday", "10:00", "12:00", "spring")]),
  ]);

  expect(clashes).toEqual([]);
});

it("does not report Meetings on different Days at the same hour", () => {
  const clashes = findClashes([
    group("99-101", [span("sunday", "10:00", "12:00")]),
    group("99-202", [span("monday", "10:00", "12:00")]),
  ]);

  expect(clashes).toEqual([]);
});

it("reports a Meeting overlapping a Blocked Time, naming the Blocked Time", () => {
  const blockedTime = span("thursday", "16:00", "20:00");

  const clashes = findClashes([group("99-101", [span("thursday", "14:00", "18:00")])], [blockedTime]);

  expect(clashes).toEqual([
    {
      kind: "meeting-blocked-time",
      overlap: { semester: "fall", day: "thursday", start: "16:00", end: "18:00" },
      group: { courseNumber: "99-101", lessonType: "lecture", number: "01" },
      meeting: span("thursday", "14:00", "18:00"),
      blockedTime,
    },
  ]);
});

it("does not report a Meeting that abuts a Blocked Time or sits in another Semester", () => {
  const clashes = findClashes(
    [
      group("99-101", [span("sunday", "08:00", "10:00")]),
      group("99-202", [span("sunday", "12:00", "14:00", "spring")]),
    ],
    [span("sunday", "10:00", "14:00")],
  );

  expect(clashes).toEqual([]);
});

it("reports only the Meetings of a Group that actually overlap", () => {
  const clashes = findClashes([
    group("99-101", [span("sunday", "10:00", "12:00"), span("tuesday", "10:00", "12:00")]),
    group("99-202", [span("tuesday", "11:00", "12:00")]),
  ]);

  expect(clashes).toHaveLength(1);
  expect(clashes[0]?.overlap).toEqual(span("tuesday", "11:00", "12:00"));
});

it("never reports an Untimed Group", () => {
  const clashes = findClashes(
    [group("99-101", []), group("99-202", [span("sunday", "10:00", "12:00")]), group("99-303", [])],
    [span("sunday", "09:00", "23:00")],
  );

  expect(clashes).toHaveLength(1);
  expect(clashes[0]?.kind).toBe("meeting-blocked-time");
});

it("reports a Group against itself for neither its own Meetings nor a repeated entry", () => {
  const doubled = group("99-101", [
    span("sunday", "10:00", "12:00"),
    span("sunday", "11:00", "13:00"),
  ]);

  expect(findClashes([doubled])).toEqual([]);
  expect(findClashes([doubled, doubled])).toEqual([]);
});

it("reports Clashes between two Lesson Types of the same Course", () => {
  const clashes = findClashes([
    group("99-101", [span("sunday", "10:00", "12:00")], "lecture", "01"),
    group("99-101", [span("sunday", "11:00", "13:00")], "tirgul", "01"),
  ]);

  expect(clashes).toHaveLength(1);
  expect(clashes[0]).toMatchObject({
    kind: "meeting-meeting",
    first: { group: { lessonType: "lecture" } },
    second: { group: { lessonType: "tirgul" } },
  });
});

it("ignores a span whose end does not come after its start, so it occupies no time", () => {
  const clashes = findClashes(
    [
      group("99-101", [span("sunday", "10:00", "10:00")]),
      group("99-202", [span("sunday", "09:00", "12:00")]),
    ],
    [span("sunday", "12:00", "08:00")],
  );

  expect(clashes).toEqual([]);
});

it("reports each pair exactly once, in a stable order", () => {
  const groups = [
    group("99-101", [span("sunday", "10:00", "12:00")]),
    group("99-202", [span("sunday", "10:30", "11:30")]),
    group("99-303", [span("sunday", "11:00", "13:00")]),
  ];
  const blockedTimes = [span("sunday", "09:00", "10:15"), span("sunday", "12:30", "14:00")];

  const clashes = findClashes(groups, blockedTimes);

  expect(
    clashes.map((clash) =>
      clash.kind === "meeting-meeting"
        ? `${clash.first.group.courseNumber}+${clash.second.group.courseNumber}`
        : `${clash.group.courseNumber}+blocked@${clash.blockedTime.start}`,
    ),
  ).toEqual([
    "99-101+99-202",
    "99-101+99-303",
    "99-202+99-303",
    "99-101+blocked@09:00",
    "99-303+blocked@12:30",
  ]);
  expect(findClashes(groups, blockedTimes)).toEqual(clashes);
});

it("finds no Clash in an empty Timetable", () => {
  expect(findClashes([])).toEqual([]);
  expect(findClashes([], [span("sunday", "08:00", "20:00")])).toEqual([]);
});

it("accepts a Catalog Group without either side importing the other", () => {
  const fromCatalog: Group = {
    number: "02",
    lessonType: "tirgul",
    lecturers: ["ד\"ר בדיה"],
    meetings: [{ semester: "fall", day: "sunday", start: "10:00", end: "12:00" }],
  };

  // The Catalog carries no course number on a Group, so the caller supplies the Offering's.
  const picked: PickedGroup = { courseNumber: "99-101", ...fromCatalog };

  expect(findClashes([picked], [span("sunday", "11:00", "13:00")])).toHaveLength(1);
});
