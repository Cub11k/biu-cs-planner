import { expect, it } from "vitest";
import { isClockTime, parseGroupMeetings } from "./dialect.ts";

/**
 * The hours reader, asked directly about the run-together cell.
 *
 * `docs/research/shoham-raw-shape.md` records the same damage in the Semester cell and in the
 * hours cell: some crawled files write a multi-line cell as one run-together string, "so a
 * reader has to accept both". `parseSemesters` accepts both by scanning for its labels wherever
 * they sit (ADR-0010); #74 rules that the hours cell is read on the same terms. Where a cell has
 * a newline spelling to be compared against, the two are asserted equal to each other rather
 * than only to a value, so the two readings cannot drift apart without a test saying so.
 *
 * What #70 settled is asserted too: a cell that is not a clean run of ranges is still reported
 * as the cell it is and still yields no Meeting.
 */

const FALL = "סמסטר א'";
/** The Year-long cell in its own run-together spelling, which parseSemesters already accepts. */
const YEAR_LONG = "סמסטר א'סמסטר ב'";

it("reads two ranges run together on one line as the two ranges two lines would give", () => {
  const joined = parseGroupMeetings({
    semester: FALL,
    day: "ג',ה'",
    hours: "14:00 - 16:00 18:00 - 20:00",
  });

  expect(joined.warnings).toEqual([]);
  expect(joined.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "14:00", end: "16:00" },
    { semester: "fall", day: "thursday", start: "18:00", end: "20:00" },
  ]);
  // The point of the ruling: one spelling of the cell, one meaning.
  expect(joined).toEqual(
    parseGroupMeetings({
      semester: FALL,
      day: "ג',ה'",
      hours: "14:00 - 16:00\n18:00 - 20:00",
    }),
  );
});

it("reads the six-range form as six ranges, one block per Semester", () => {
  // The shape the older crawl on disk carries twice, with invented times as every fixture here
  // has: a Year-long Group of three days whose block is repeated once per Semester, the whole
  // lot joined onto one line.
  const joined = parseGroupMeetings({
    semester: YEAR_LONG,
    day: "א',ג',ה'",
    hours: "09:00 - 11:00 12:00 - 14:00 16:00 - 18:00 09:00 - 11:00 12:00 - 14:00 16:00 - 18:00",
  });

  expect(joined.warnings).toEqual([]);
  expect(joined.meetings).toEqual([
    { semester: "fall", day: "sunday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "tuesday", start: "12:00", end: "14:00" },
    { semester: "fall", day: "thursday", start: "16:00", end: "18:00" },
    { semester: "spring", day: "sunday", start: "09:00", end: "11:00" },
    { semester: "spring", day: "tuesday", start: "12:00", end: "14:00" },
    { semester: "spring", day: "thursday", start: "16:00", end: "18:00" },
  ]);
  expect(joined).toEqual(
    parseGroupMeetings({
      semester: YEAR_LONG,
      day: "א',ג',ה'",
      hours: [
        "09:00 - 11:00",
        "12:00 - 14:00",
        "16:00 - 18:00",
        "09:00 - 11:00",
        "12:00 - 14:00",
        "16:00 - 18:00",
      ].join("\n"),
    }),
  );
});

it("still reads a single range with spaces around its own separator as one range", () => {
  // Why the reader scans instead of splitting on whitespace: a range writes spaces around its
  // own `-`, so a whitespace split would tear this cell into three pieces.
  const { meetings, warnings } = parseGroupMeetings({
    semester: FALL,
    day: "ג'",
    hours: "16:00 - 18:00",
  });

  expect(warnings).toEqual([]);
  expect(meetings).toEqual([{ semester: "fall", day: "tuesday", start: "16:00", end: "18:00" }]);
});

it("reads a run written without spaces around its separators as the same ranges", () => {
  // The scan does not depend on the spacing inside a range, only on the ranges themselves, so
  // the tight spelling the clock already accepted keeps reading the same when joined.
  const { meetings, warnings } = parseGroupMeetings({
    semester: FALL,
    day: "ג',ה'",
    hours: "14:00-16:00 18:00-20:00",
  });

  expect(warnings).toEqual([]);
  expect(meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "14:00", end: "16:00" },
    { semester: "fall", day: "thursday", start: "18:00", end: "20:00" },
  ]);
});

it("reads ranges joined with no separator at all as the ranges they are", () => {
  // A deliberate consequence rather than observed data: no crawl on disk holds this cell, and
  // the ones that hold the damage put a space between the ranges. It is pinned because it is the
  // artifact's own worst form -- the Semester cell arrives as "סמסטר א'סמסטר ב'", with nothing
  // between the labels either -- and because a scan cannot tell the two apart: a range is fixed
  // width, so nothing else can be meant. Nothing but whitespace between two occurrences
  // includes nothing.
  const { meetings, warnings } = parseGroupMeetings({
    semester: FALL,
    day: "ג',ה'",
    hours: "14:00 - 16:0018:00 - 20:00",
  });

  expect(warnings).toEqual([]);
  expect(meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "14:00", end: "16:00" },
    { semester: "fall", day: "thursday", start: "18:00", end: "20:00" },
  ]);
});

it("pairs a run-together Year-long block of one day with each of its Semesters", () => {
  // The other real shape on disk: one day, two ranges, one per Semester.
  const { meetings, warnings } = parseGroupMeetings({
    semester: YEAR_LONG,
    day: "ו'",
    hours: "10:00 - 12:00 10:00 - 12:00",
  });

  expect(warnings).toEqual([]);
  expect(meetings).toEqual([
    { semester: "fall", day: "friday", start: "10:00", end: "12:00" },
    { semester: "spring", day: "friday", start: "10:00", end: "12:00" },
  ]);
});

it("warns that a run-together cell's ranges do not divide by its days, and invents nothing", () => {
  // The safety net the ruling leans on: scanning finds four ranges where three days and one
  // Semester can account for three, so the mismatch is reported exactly as it is for four lines.
  const joined = parseGroupMeetings({
    semester: FALL,
    day: "א',ג',ה'",
    hours: "09:00 - 11:00 09:00 - 11:00 08:00 - 13:00 10:00 - 12:00",
  });

  expect(joined.warnings).toEqual([{ kind: "hours-do-not-divide" }]);
  expect(joined.meetings).toEqual([
    { semester: "fall", day: "sunday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "tuesday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "thursday", start: "08:00", end: "13:00" },
  ]);
  expect(joined).toEqual(
    parseGroupMeetings({
      semester: FALL,
      day: "א',ג',ה'",
      hours: "09:00 - 11:00\n09:00 - 11:00\n08:00 - 13:00\n10:00 - 12:00",
    }),
  );
});

it("treats a run of two ranges against one day as the uneven split the two-line form is", () => {
  // The input an import test used to hold, kept because the answer to it changed: while the run
  // was refused, one day and this cell gave `hours-cell-not-one-range` naming the text. Now the
  // cell holds two ranges and the Group one day, so it is the same uneven split two lines have
  // always been -- reported without the text, since what is wrong is the count, and the first
  // range still read. Consistency with the two-line spelling is the whole of the ruling, so the
  // Warning changing kind here is the point rather than a loss. None of the 13 cells of this
  // shape on disk divides unevenly.
  const joined = parseGroupMeetings({
    semester: FALL,
    day: "ג'",
    hours: "14:00 - 16:00 18:00 - 20:00",
  });

  expect(joined.warnings).toEqual([{ kind: "hours-do-not-divide" }]);
  expect(joined.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "14:00", end: "16:00" },
  ]);
  expect(joined).toEqual(
    parseGroupMeetings({ semester: FALL, day: "ג'", hours: "14:00 - 16:00\n18:00 - 20:00" }),
  );
});

it("reads a cell mixing a run-together line with a line of its own", () => {
  const { meetings, warnings } = parseGroupMeetings({
    semester: FALL,
    day: "א',ג',ה'",
    hours: "09:00 - 11:00 12:00 - 14:00\n16:00 - 18:00",
  });

  expect(warnings).toEqual([]);
  expect(meetings).toEqual([
    { semester: "fall", day: "sunday", start: "09:00", end: "11:00" },
    { semester: "fall", day: "tuesday", start: "12:00", end: "14:00" },
    { semester: "fall", day: "thursday", start: "16:00", end: "18:00" },
  ]);
});

it("finds a range for every time the clock accepts, and no range in one it refuses", () => {
  // ADR-0012: the clock spelling is written once per file that reads a clock, keeping the five
  // spellings equal is "a judgement made in review, not a guarded invariant", and a test closing
  // that "is worth its own ticket". CLOCK_RANGE writes the same body twice more, inside a file the
  // ADR already lists, so the drift that can go quiet is pinned here: narrow the scan, or widen
  // the clock, and a run-together cell stops importing the Meetings it holds -- silently, as an
  // unreadable time. Widening the scan alone needs no guard and gets none, because isClockTime is
  // asked again of every range it finds, so the clock refuses what the scan should not have taken.
  for (let minutes = 0; minutes < 24 * 60; minutes += 1) {
    const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
    const time = `${hour}:${String(minutes % 60).padStart(2, "0")}`;
    expect(isClockTime(time)).toBe(true);
    // Two ranges, because one alone would read whether or not the scan found anything in it.
    const cell = `${time} - ${time} ${time} - ${time}`;
    expect(parseGroupMeetings({ semester: FALL, day: "ג',ה'", hours: cell }).meetings).toHaveLength(2);
  }

  for (const refused of ["9:00", "0:00", "24:00", "23:60", "12:5", "1500"]) {
    expect(isClockTime(refused)).toBe(false);
    // The scan finds no range, so the line falls to the clock and is reported as a time that
    // could not be read -- not as a cell of the wrong shape.
    expect(parseGroupMeetings({ semester: FALL, day: "ג'", hours: `${refused} - ${refused}` }))
      .toEqual({ semesters: ["fall"], meetings: [], warnings: [{ kind: "meeting-unreadable" }] });
  }
});

it("still reports a three-field cell as the cell it is, and makes no Meeting of it (#70)", () => {
  // `16:00 - 16:00 - 17:00` is not a run of ranges: a `-` sits between the two occurrences a
  // scan can find, so the cell stays what #70 made it -- reported, not guessed at.
  const { meetings, warnings } = parseGroupMeetings({
    semester: FALL,
    day: "ג'",
    hours: "16:00 - 16:00 - 17:00",
  });

  expect(warnings).toEqual([{ kind: "hours-cell-not-one-range", cell: "16:00 - 16:00 - 17:00" }]);
  expect(meetings).toEqual([]);
});

it("still reports a chain of ranges sharing their separators, which is not a run", () => {
  // Where the ruling deliberately stops. `14:00 - 16:00 - 18:00` could be read as two ranges
  // sharing 16:00, and that meaning is exactly what #70 says is not established. A run has
  // nothing but whitespace between its ranges, so this is not one.
  const { meetings, warnings } = parseGroupMeetings({
    semester: FALL,
    day: "ג',ה'",
    hours: "14:00 - 16:00 - 18:00",
  });

  expect(warnings).toEqual([
    { kind: "hours-do-not-divide" },
    { kind: "hours-cell-not-one-range", cell: "14:00 - 16:00 - 18:00" },
  ]);
  expect(meetings).toEqual([]);
});

it("still reports a chain of four times, where a scan could pick two ranges out of the ends", () => {
  // The case the whitespace-only rule between occurrences is for, and the one that would be
  // quietly wrong without it: a scan finds `14:00 - 16:00` and `18:00 - 20:00` in this cell and
  // could pair them with the two days, dropping the `-` that joins 16:00 to 18:00 and the
  // reading it implies. That is the silent field-dropping #70 exists to stop, so a `-` between
  // two occurrences means the line is not a run and the cell is reported as itself.
  const { meetings, warnings } = parseGroupMeetings({
    semester: FALL,
    day: "ג',ה'",
    hours: "14:00 - 16:00 - 18:00 - 20:00",
  });

  expect(warnings).toEqual([
    { kind: "hours-do-not-divide" },
    { kind: "hours-cell-not-one-range", cell: "14:00 - 16:00 - 18:00 - 20:00" },
  ]);
  expect(meetings).toEqual([]);
});

it("still reports a cell ending in a separator rather than reading the range before it", () => {
  const { meetings, warnings } = parseGroupMeetings({
    semester: FALL,
    day: "ג'",
    hours: "15:00 - 18:00 -",
  });

  expect(warnings).toEqual([{ kind: "hours-cell-not-one-range", cell: "15:00 - 18:00 -" }]);
  expect(meetings).toEqual([]);
});

it("still calls a two-field cell that is not a time unreadable, rather than not one range", () => {
  // The scan finds no range here, which must leave the cell to the clock exactly as before:
  // `1500 - 1800` is one range's worth of fields, so what is wrong with it is the time.
  const { meetings, warnings } = parseGroupMeetings({
    semester: FALL,
    day: "ג'",
    hours: "1500 - 1800",
  });

  expect(warnings).toEqual([{ kind: "meeting-unreadable" }]);
  expect(meetings).toEqual([]);
});
