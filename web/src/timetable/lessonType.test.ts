import { expect, it } from "vitest";
import { lessonSlot, lessonTypeName } from "./lessonType.ts";

it("gives the Lesson Types of a CS week a colour slot of their own", () => {
  expect(lessonSlot("הרצאה")).toBe("lecture");
  expect(lessonSlot("תרגיל")).toBe("tirgul");
  expect(lessonSlot("מעבדה")).toBe("lab");
});

it("puts every other Lesson Type in the fourth slot rather than losing it", () => {
  expect(lessonSlot("סמינריון")).toBe("other");
  expect(lessonSlot("ש.מחלקה")).toBe("other");
  expect(lessonSlot("משהו חדש לגמרי")).toBe("other");
});

it("reads a Lesson Type in the language the screen is in", () => {
  expect(lessonTypeName("הרצאה", "en")).toBe("Lecture");
  expect(lessonTypeName("הרצאה", "he")).toBe("הרצאה");
  expect(lessonTypeName("קולוקויום רשות", "en")).toBe("Colloquium (elective)");
});

it("shows a Lesson Type nobody has seen before as the Catalog wrote it", () => {
  expect(lessonTypeName("סיור לימודי", "en")).toBe("סיור לימודי");
});

it("treats a Lesson Type named after a prototype member as data, not as a lookup", () => {
  for (const hostile of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    expect(lessonSlot(hostile)).toBe("other");
    expect(lessonTypeName(hostile, "en")).toBe(hostile);
  }
});
