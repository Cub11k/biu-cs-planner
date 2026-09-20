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

it("finds no overlap with a Meeting written without its leading zero, which is no time at all", () => {
  // #14 read an unpadded hour; #54 ruled that reading out (ADR-0012), because the Shoham
  // dialect refuses a time that lacks its leading zero and drops the Meeting, so nothing the
  // Importer produces can reach here unpadded. A Meeting written that way now occupies no
  // time, and a Meeting occupying no time overlaps nothing -- the same answer the zero-length
  // Meeting gets further down, and reached the same way.
  const morning = meeting({ start: "9:00", end: "11:00" });
  const late = meeting({ start: "10:00", end: "12:00" });

  expect(overlappingMeetings([morning, late])).toEqual([]);
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
