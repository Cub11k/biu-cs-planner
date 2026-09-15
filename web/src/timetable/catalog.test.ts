import { expect, it } from "vitest";
import { courseName, isUntimedIn, meetingsInSemester, type Group, type Offering } from "./catalog.ts";

const meeting = (semester: Group["meetings"][number]["semester"]) =>
  ({ semester, day: "sunday", start: "10:00", end: "12:00" }) as const;

const offering = (extra: Partial<Offering>): Offering => ({
  courseNumber: "89-110",
  nameHebrew: "מבוא למדעי המחשב",
  credits: { known: true, total: 3 },
  semesters: ["fall"],
  groups: [],
  exams: { known: false, sittings: [] },
  ...extra,
});

it("shows a Course with no English name in Hebrew rather than not at all", () => {
  const noEnglish = offering({});
  expect(courseName(noEnglish, "en")).toBe("מבוא למדעי המחשב");
  expect(courseName(noEnglish, "he")).toBe("מבוא למדעי המחשב");
});

it("shows the English name in English when Shoham published one", () => {
  const both = offering({ nameEnglish: "Introduction to Computer Science" });
  expect(courseName(both, "en")).toBe("Introduction to Computer Science");
  expect(courseName(both, "he")).toBe("מבוא למדעי המחשב");
});

it("asks a Year-long Group for one Semester's Meetings at a time", () => {
  const group: Group = {
    number: "01",
    lessonType: "הרצאה",
    lecturers: [],
    meetings: [meeting("fall"), meeting("spring")],
  };

  expect(meetingsInSemester(group, "fall")).toHaveLength(1);
  expect(isUntimedIn(group, "summer")).toBe(true);
  expect(isUntimedIn(group, "fall")).toBe(false);
});
