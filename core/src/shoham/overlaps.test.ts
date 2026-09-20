import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Meeting } from "../catalog/schema.ts";
import { meetingsOccupyingNoTime, overlappingMeetings } from "./overlaps.ts";

/**
 * The shared table of clock ranges, read the way `clashes.ts` reads it. `meetingsOccupyingNoTime`
 * restates the half-open comparison that decides whether a range occupies time at all, so it is
 * a third reader of the rule this table exists to stop drifting (#48) and is held to it here.
 * Every case in the table is zero-padded, which is what a Catalog lets in; the unpadded hour the
 * table deliberately leaves out is the Importer's own business, pinned in `import.test.ts`.
 */
const clockRanges: {
  cases: { start: string; end: string; startMinutes: number; endMinutes: number; why: string }[];
} = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../fixtures/clock-ranges.json"), "utf8"),
);

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
  // with nothing. Such a Meeting does deserve a Warning of its own, which is #52's, and it is
  // `meetingsOccupyingNoTime` below that gives it -- overlap still has nothing to say here.
  expect(
    overlappingMeetings([
      meeting({ start: "15:00", end: "18:00" }),
      meeting({ start: "16:00", end: "16:00" }),
    ]),
  ).toEqual([]);
});

it("reports no Meeting of a Group whose hours all advance", () => {
  expect(meetingsOccupyingNoTime([])).toEqual([]);
  expect(meetingsOccupyingNoTime([meeting({ start: "16:00", end: "17:00" })])).toEqual([]);
});

it("reports a Meeting whose end is its start as a range that does not advance", () => {
  const still = meeting({ start: "16:00", end: "16:00" });

  expect(meetingsOccupyingNoTime([still])).toEqual([
    { meeting: still, shape: "does-not-advance" },
  ]);
});

it("reports a Meeting whose end falls before its start as one that reads as wrapping", () => {
  // 23:00-01:00 is the shape a night class takes when something read it as a single range.
  // It is told apart from a range that does not advance because the causes differ: this one
  // is likelier the crawl, the other likelier the Shoham page.
  const wrapping = meeting({ start: "23:00", end: "01:00" });

  expect(meetingsOccupyingNoTime([wrapping])).toEqual([
    { meeting: wrapping, shape: "reads-as-wrapping" },
  ]);
});

it("reports nothing about an evening Meeting ending at 00:00, which is the end of the Day", () => {
  // #48's ruling, and the reason this reads the clock through `clockAsEnd` rather than
  // comparing the two strings: 22:00-00:00 is the evening, not a range that wraps.
  expect(meetingsOccupyingNoTime([meeting({ start: "22:00", end: "00:00" })])).toEqual([]);
});

it("reports nothing about a Meeting of 00:00-00:00, which is the whole Day", () => {
  expect(meetingsOccupyingNoTime([meeting({ start: "00:00", end: "00:00" })])).toEqual([]);
});

it("reports every such Meeting, in the order the Group holds them", () => {
  const wrapping = meeting({ start: "23:00", end: "01:00" });
  const still = meeting({ start: "16:00", end: "16:00" });

  expect(meetingsOccupyingNoTime([wrapping, meeting(), still])).toEqual([
    { meeting: wrapping, shape: "reads-as-wrapping" },
    { meeting: still, shape: "does-not-advance" },
  ]);
});

it("reports nothing about a Meeting whose clock cannot be read at all", () => {
  // "25:00" is not a time, so nothing here can say whether its range advances. What a Group's
  // unreadable hours get said about them is the dialect's `meeting-unreadable`, not this.
  expect(meetingsOccupyingNoTime([meeting({ start: "25:00", end: "25:00" })])).toEqual([]);
});

it("reports a plainly backwards range as reading like a wrap, which is the line #52 drew", () => {
  // 12:00-08:00 is a swapped pair rather than a night class, and the table calls it "plainly
  // backwards" for that reason. #52 asked for two shapes, so it shares the bucket with a real
  // wrap; pinned here so that the choice is on the record rather than incidental.
  const backwards = meeting({ start: "12:00", end: "08:00" });

  expect(meetingsOccupyingNoTime([backwards])).toEqual([
    { meeting: backwards, shape: "reads-as-wrapping" },
  ]);
});

it("reports nothing about a Meeting whose end alone cannot be read", () => {
  // The start reads fine and the end does not, so nothing here can say whether the range
  // advances. Without this the unreadable end would compare as `undefined > 960`, come out
  // false, and be reported as a wrap -- a Warning naming a shape it never determined.
  expect(meetingsOccupyingNoTime([meeting({ start: "16:00", end: "25:00" })])).toEqual([]);
  expect(meetingsOccupyingNoTime([meeting({ start: "25:00", end: "16:00" })])).toEqual([]);
});

it("reports exactly those ranges in the shared table that occupy no time", () => {
  expect(clockRanges.cases.length).toBeGreaterThan(0);

  for (const range of clockRanges.cases) {
    const read = `${range.start}-${range.end}: ${range.why}`;
    const occupiesTime = range.endMinutes > range.startMinutes;

    expect([read, meetingsOccupyingNoTime([meeting({ start: range.start, end: range.end })])])
      .toEqual([
        read,
        occupiesTime
          ? []
          : [
              {
                meeting: meeting({ start: range.start, end: range.end }),
                shape: range.endMinutes === range.startMinutes
                  ? "does-not-advance"
                  : "reads-as-wrapping",
              },
            ],
      ]);
  }
});
