import { expect, it } from "vitest";
import type { Meeting } from "../catalog/schema.ts";
import { overlappingMeetings } from "./overlaps.ts";

/** A Tuesday afternoon Meeting in Fall; each test overrides only what it is about. */
function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return { semester: "fall", day: "tuesday", start: "15:00", end: "18:00", ...overrides };
}

it("finds nothing in a Group with no Meetings at all", () => {
  expect(overlappingMeetings([])).toEqual([]);
});

it("finds nothing in a Group with a single Meeting, which cannot overlap itself", () => {
  expect(overlappingMeetings([meeting()])).toEqual([]);
});

it("reports two Meetings of one Group that overlap on the same Day", () => {
  const first = meeting({ start: "15:00", end: "18:00" });
  const second = meeting({ start: "16:00", end: "17:00" });

  expect(overlappingMeetings([first, second])).toEqual([{ first, second }]);
});

it("keeps the pair in the order the Meetings were given", () => {
  const early = meeting({ start: "15:00", end: "18:00" });
  const late = meeting({ start: "17:00", end: "19:00" });

  expect(overlappingMeetings([late, early])).toEqual([{ first: late, second: early }]);
});

it("does not report Meetings that merely abut, one ending where the next starts", () => {
  expect(
    overlappingMeetings([
      meeting({ start: "15:00", end: "17:00" }),
      meeting({ start: "17:00", end: "19:00" }),
    ]),
  ).toEqual([]);
});

it("does not report the same hours on different Days", () => {
  expect(
    overlappingMeetings([meeting({ day: "tuesday" }), meeting({ day: "wednesday" })]),
  ).toEqual([]);
});

it("does not report the same Day and hours in different Semesters, as a Year-long Group has", () => {
  expect(
    overlappingMeetings([meeting({ semester: "fall" }), meeting({ semester: "spring" })]),
  ).toEqual([]);
});

it("compares times as minutes, so one written without its leading zero still overlaps", () => {
  // The rule is #14's, and #14 reads minutes rather than comparing the strings because a
  // Blocked Time is student-entered: "9:00" sorts after "10:00". Today's Shoham dialect only
  // ever emits a padded time, so this is the rule holding rather than a case the Importer
  // meets -- which is the point of testing it here, where the rule is, and not there.
  const morning = meeting({ start: "9:00", end: "11:00" });
  const late = meeting({ start: "10:00", end: "12:00" });

  expect(overlappingMeetings([morning, late])).toEqual([{ first: morning, second: late }]);
});

it("reports each overlapping pair once when three Meetings sit on top of each other", () => {
  const first = meeting({ start: "15:00", end: "18:00" });
  const second = meeting({ start: "16:00", end: "19:00" });
  const third = meeting({ start: "17:00", end: "20:00" });

  expect(overlappingMeetings([first, second, third])).toEqual([
    { first, second },
    { first, second: third },
    { first: second, second: third },
  ]);
});

it("reports a Meeting duplicated exactly, which claims the same hour twice", () => {
  const first = meeting();
  const second = meeting();

  expect(overlappingMeetings([first, second])).toEqual([{ first, second }]);
});

it("ignores a Meeting whose range occupies no time, which collides with nothing", () => {
  // Inherited from #14, where a span that does not advance occupies no time and so Clashes
  // with nothing. Whether such a Meeting deserves a Warning of its own is a separate
  // question from overlap, and not one this ticket asked.
  expect(
    overlappingMeetings([
      meeting({ start: "15:00", end: "18:00" }),
      meeting({ start: "16:00", end: "16:00" }),
    ]),
  ).toEqual([]);
});
