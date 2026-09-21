import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Day, Semester } from "./catalog.ts";
import {
  DEFAULT_HOUR_RANGE,
  daysShown,
  formatClock,
  hourLines,
  hourRange,
  parseClock,
  parseClockAsEnd,
  tileBox,
  tileText,
  tilesFor,
  WEEK_DAYS,
  clashingGroups,
  groupKey,
  weekGroups,
  type WeekGroup,
} from "./week.ts";

const FALL: Semester = "fall";

/** A Group as the week draws it, with its Meetings written the way Shoham writes them. */
function group(
  number: string,
  lessonType: string,
  meetings: ReadonlyArray<[Day, string, string, Semester?]>,
): WeekGroup {
  return {
    courseNumber: "89-110",
    courseName: "Introduction to Computer Science",
    number,
    lessonType,
    picked: false,
    meetings: meetings.map(([day, start, end, semester]) => ({
      semester: semester ?? FALL,
      day,
      start,
      end,
    })),
  };
}

describe("reading and writing a clock time", () => {
  it("reads a time as minutes since the beginning of the day", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("15:30")).toBe(930);
    expect(parseClock("23:59")).toBe(1439);
  });

  /**
   * One spelling of midnight, and the position says which end of the day is meant: an `end`
   * of `00:00` closes the day rather than opening it (issue #48).
   */
  it("reads an end of 00:00 as the end of the day and a start of it as the beginning", () => {
    expect(parseClockAsEnd("00:00")).toBe(24 * 60);
    expect(parseClock("00:00")).toBe(0);
    expect(parseClockAsEnd("15:30")).toBe(930);
  });

  it("refuses a time it cannot place rather than guessing at one", () => {
    for (const refused of ["24:00", "9:00", "", "23:0009:00"]) {
      expect(parseClock(refused)).toBeUndefined();
      expect(parseClockAsEnd(refused)).toBeUndefined();
    }
  });

  it("writes minutes back as a padded clock time", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(930)).toBe("15:30");
  });

  /**
   * The end of the day is written the way it is read. A tile for `22:00`-`00:00` used to be
   * labelled `22:00-24:00` and the hour gutter's last line read `24:00`; `24:00` is a number
   * the grid computes with and a string the student never sees.
   */
  it("writes the end of the day back as 00:00, never as 24:00", () => {
    expect(formatClock(24 * 60)).toBe("00:00");
    expect(formatClock(23 * 60 + 59)).toBe("23:59");
  });
});

describe("placing a Semester's Meetings", () => {
  it("puts a Meeting on its own day at its own minutes", () => {
    const tiles = tilesFor([group("01", "הרצאה", [["tuesday", "15:00", "18:00"]])], FALL);

    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({
      day: "tuesday",
      startMinutes: 15 * 60,
      endMinutes: 18 * 60,
      lane: 0,
      lanes: 1,
    });
  });

  it("places every Meeting of a Group, so all of them can be highlighted together", () => {
    const lecture = group("01", "הרצאה", [
      ["tuesday", "13:00", "15:00"],
      ["wednesday", "09:00", "11:00"],
    ]);

    const tiles = tilesFor([lecture], FALL);

    expect(tiles).toHaveLength(2);
    expect(new Set(tiles.map((tile) => tile.groupKey))).toEqual(new Set(["89-110|הרצאה|01"]));
  });

  it("leaves the other Semester's Meetings of a Year-long Group off the week", () => {
    const yearLong = group("01", "הרצאה", [
      ["tuesday", "13:00", "15:00", "fall"],
      ["sunday", "13:00", "15:00", "spring"],
    ]);

    expect(tilesFor([yearLong], FALL).map((tile) => tile.day)).toEqual(["tuesday"]);
    expect(tilesFor([yearLong], "spring").map((tile) => tile.day)).toEqual(["sunday"]);
  });

  it("keeps an Untimed Group off the grid entirely", () => {
    expect(tilesFor([group("02", "הרצאה", [])], FALL)).toEqual([]);
  });

  it("leaves a Meeting it cannot read off the grid rather than drawing it somewhere wrong", () => {
    const unreadable = group("01", "הרצאה", [
      ["tuesday", "noon", "18:00"],
      ["wednesday", "18:00", "18:00"],
      ["thursday", "18:00", "16:00"],
    ]);

    expect(tilesFor([unreadable], FALL)).toEqual([]);
  });

  it("runs a Meeting written as ending at 00:00 to the bottom of its day", () => {
    const lateClass = group("01", "הרצאה", [["tuesday", "22:00", "00:00"]]);

    const [tile] = tilesFor([lateClass], FALL);

    expect(tile).toMatchObject({ startMinutes: 22 * 60, endMinutes: 24 * 60 });
  });

  /**
   * A start of `00:00` is the beginning of the day, so a Meeting written `00:00`-`08:00` is
   * the night and a Meeting written `00:00`-`00:00` is the whole day. The reading no longer
   * asks what the start was before deciding what the end means (issue #48).
   */
  it("reads a start of 00:00 as the beginning of the day, whatever the end says", () => {
    const night = group("01", "הרצאה", [["tuesday", "00:00", "08:00"]]);
    const allDay = group("02", "הרצאה", [["wednesday", "00:00", "00:00"]]);

    expect(tilesFor([night], FALL)[0]).toMatchObject({ startMinutes: 0, endMinutes: 8 * 60 });
    expect(tilesFor([allDay], FALL)[0]).toMatchObject({ startMinutes: 0, endMinutes: 24 * 60 });
  });

  it("gives Meetings that overlap a lane each, so none hides another", () => {
    const tiles = tilesFor(
      [
        group("03", "תרגיל", [["tuesday", "18:00", "20:00"]]),
        group("04", "תרגיל", [["tuesday", "18:00", "20:00"]]),
        group("05", "תרגיל", [["tuesday", "18:00", "20:00"]]),
      ],
      FALL,
    );

    expect(tiles.map((tile) => tile.lane).sort()).toEqual([0, 1, 2]);
    expect(tiles.every((tile) => tile.lanes === 3)).toBe(true);
  });

  it("gives back a full width to Meetings that only touch", () => {
    const tiles = tilesFor(
      [
        group("01", "הרצאה", [["sunday", "10:00", "12:00"]]),
        group("11", "תרגיל", [["sunday", "12:00", "14:00"]]),
      ],
      FALL,
    );

    expect(tiles.every((tile) => tile.lanes === 1)).toBe(true);
  });

  it("counts a cluster's lanes together, so the tiles in it line up", () => {
    // 10–12 overlaps 11–13, which overlaps 12–14: one cluster of three, two lanes wide
    const tiles = tilesFor(
      [
        group("01", "הרצאה", [["sunday", "10:00", "12:00"]]),
        group("02", "הרצאה", [["sunday", "11:00", "13:00"]]),
        group("03", "הרצאה", [["sunday", "12:00", "14:00"]]),
      ],
      FALL,
    );

    expect(tiles.every((tile) => tile.lanes === 2)).toBe(true);
    expect(tiles.map((tile) => tile.lane)).toEqual([0, 1, 0]);
  });
});

describe("the days the week shows", () => {
  it("runs Sunday to Thursday when nothing meets on Friday", () => {
    const tiles = tilesFor([group("01", "הרצאה", [["thursday", "10:00", "12:00"]])], FALL);

    expect(daysShown(tiles)).toEqual([...WEEK_DAYS]);
  });

  it("adds Friday only when a shown Group meets on it", () => {
    const tiles = tilesFor([group("01", "הרצאה", [["friday", "08:00", "13:00"]])], FALL);

    expect(daysShown(tiles)).toEqual([...WEEK_DAYS, "friday"]);
  });
});

describe("the hours the week spans", () => {
  it("spans a teaching day when there is nothing to fit", () => {
    expect(hourRange([])).toEqual(DEFAULT_HOUR_RANGE);
  });

  it("fits the Meetings on screen, on whole hours", () => {
    const tiles = tilesFor(
      [
        group("01", "הרצאה", [["sunday", "09:30", "11:00"]]),
        group("02", "הרצאה", [["monday", "16:00", "18:30"]]),
      ],
      FALL,
    );

    expect(hourRange(tiles)).toEqual({ startHour: 9, endHour: 19 });
  });

  it("does not shrink the week to a strip around one short Meeting", () => {
    const tiles = tilesFor([group("01", "הרצאה", [["sunday", "10:00", "11:00"]])], FALL);

    expect(hourRange(tiles)).toEqual({ startHour: 10, endHour: 16 });
  });

  it("grows upwards when there is no room left in the evening", () => {
    const tiles = tilesFor([group("01", "הרצאה", [["sunday", "21:00", "23:00"]])], FALL);

    expect(hourRange(tiles)).toEqual({ startHour: 18, endHour: 24 });
  });

  it("carries an hour line for every hour, the last one included", () => {
    expect(hourLines({ startHour: 8, endHour: 11 })).toEqual([8, 9, 10, 11]);
  });
});

describe("where a tile sits", () => {
  const range = { startHour: 8, endHour: 20 };

  it("measures from the top of the grid, at the Meeting's exact minutes", () => {
    const [tile] = tilesFor([group("01", "הרצאה", [["sunday", "09:30", "11:00"]])], FALL);
    const box = tileBox(tile!, range, 60);

    expect(box.topPx).toBe(90);
    expect(box.heightPx).toBe(88);
  });

  it("splits the day between the lanes of a cluster", () => {
    const tiles = tilesFor(
      [
        group("03", "תרגיל", [["tuesday", "18:00", "20:00"]]),
        group("04", "תרגיל", [["tuesday", "18:00", "20:00"]]),
      ],
      FALL,
    );
    const boxes = tiles.map((tile) => tileBox(tile, range, 60));

    expect(boxes.map((box) => box.widthPercent)).toEqual([50, 50]);
    expect(boxes.map((box) => box.startPercent)).toEqual([0, 50]);
  });
});

describe("what a tile says", () => {
  const base = {
    name: "Introduction to Computer Science",
    courseNumber: "89-110",
    lessonTypeName: "Lecture",
    groupNumber: "01",
    startMinutes: 15 * 60,
    endMinutes: 18 * 60,
  };

  it("reads the Course name first, then course number, Lesson Type and Group", () => {
    const text = tileText({ ...base, heightPx: 60 });

    expect(text.name).toBe("Introduction to Computer Science");
    expect(text.detail).toBe("89-110 · Lecture · 01");
    expect(text.times).toBeUndefined();
  });

  it("adds the times once the block is tall enough to hold them", () => {
    const text = tileText({ ...base, heightPx: 180 });

    expect(text.detail).toBe("89-110 · Lecture · 01");
    // kept out of the detail line so the component can isolate their direction
    expect(text.times).toBe("15:00–18:00");
  });

  it("wraps the name to two lines, or one in a short block", () => {
    expect(tileText({ ...base, heightPx: 120 }).nameLines).toBe(2);
    expect(tileText({ ...base, heightPx: 40 }).nameLines).toBe(1);
  });
});

/**
 * `core` reads this same clock when it looks for Clashes, and `web` never imports `core`, so
 * the rule is necessarily written twice and this table is the one place it is written down.
 * `core/src/timetable/clashes.test.ts` asserts the same file against its own reading: a range
 * whose two readings drift apart fails here, there, or both — which is the whole of issue #48.
 *
 * Both the reading and what it draws are checked, so that agreeing on the minutes while
 * disagreeing on the tile is not a way to pass. The `00:00`-`00:00` row is the load-bearing
 * one: it is what fails if the end reading is ever made conditional on the start again, the
 * way it was before issue #48. What the table deliberately leaves out — an unpadded hour, a
 * refusal, the writing back of minutes — is written down in the file itself.
 */
const clockRanges: {
  cases: { start: string; end: string; startMinutes: number; endMinutes: number; why: string }[];
} = JSON.parse(
  readFileSync(new URL("../../../fixtures/clock-ranges.json", import.meta.url), "utf8"),
);

describe("the clock the shared table says core and web both read", () => {
  it("reads every range in the table the way the table says", () => {
    expect(clockRanges.cases.length).toBeGreaterThan(0);

    for (const range of clockRanges.cases) {
      const read = `${range.start}-${range.end}: ${range.why}`;

      expect([read, parseClock(range.start)]).toEqual([read, range.startMinutes]);
      expect([read, parseClockAsEnd(range.end)]).toEqual([read, range.endMinutes]);
    }
  });

  it("draws exactly those ranges in the table that occupy time, at the minutes it gives", () => {
    for (const range of clockRanges.cases) {
      const read = `${range.start}-${range.end}: ${range.why}`;
      const occupiesTime = range.endMinutes > range.startMinutes;
      const meeting = group("01", "הרצאה", [["sunday", range.start, range.end]]);

      const drawn = tilesFor([meeting], FALL).map((tile) => [tile.startMinutes, tile.endMinutes]);

      expect([read, drawn]).toEqual([
        read,
        occupiesTime ? [[range.startMinutes, range.endMinutes]] : [],
      ]);
    }
  });
});

describe("what the week shows", () => {
  const PICK = {
    courseNumber: "89-210",
    lessonType: "הרצאה",
    groupNumber: "02",
    meetings: [{ semester: FALL, day: "monday" as const, start: "09:00", end: "11:00" }],
  };

  const offering = {
    courseNumber: "89-110",
    nameHebrew: "מבוא למדעי המחשב",
    credits: { known: true, total: 5 },
    semesters: [FALL],
    exams: { known: false, sittings: [] },
    groups: [
      { number: "01", lessonType: "הרצאה", lecturers: [], meetings: [] },
      { number: "03", lessonType: "תרגיל", lecturers: [], meetings: [] },
    ],
  };

  const nameOf = (courseNumber: string): string =>
    courseNumber === "89-110" ? "Introduction to Computer Science" : courseNumber;

  it("shows every Pick and the chosen Course's Groups, and says which are picked", () => {
    const shown = weekGroups({ offering, picks: [PICK], nameOf });

    expect(shown.map((group) => [group.courseNumber, group.number, group.picked])).toEqual([
      ["89-210", "02", true],
      ["89-110", "01", false],
      ["89-110", "03", false],
    ]);
  });

  it("names a picked Course by its number when the Catalog no longer names it", () => {
    const [shown] = weekGroups({ offering: undefined, picks: [PICK], nameOf });

    // the Pick carries its own snapshot, so it is still drawn — with the one name it has
    expect(shown).toMatchObject({ courseName: "89-210", meetings: PICK.meetings });
  });

  it("draws a Group that is both an option and the Pick for its slot once, as the Pick", () => {
    const picked = { ...PICK, courseNumber: "89-110", lessonType: "הרצאה", groupNumber: "01" };

    const shown = weekGroups({ offering, picks: [picked], nameOf });

    expect(shown.filter((group) => group.number === "01")).toHaveLength(1);
    expect(shown.find((group) => group.number === "01")?.picked).toBe(true);
  });

  it("keeps two Courses' lecture 01 apart, because a Group key carries its Course", () => {
    const mine = { courseNumber: "89-110", lessonType: "הרצאה", number: "01" };
    const theirs = { courseNumber: "89-210", lessonType: "הרצאה", number: "01" };

    expect(groupKey(mine)).not.toBe(groupKey(theirs));
  });

  it("marks both Groups of a Clash, and the one Group of a Blocked Time Clash", () => {
    const first = { courseNumber: "89-110", lessonType: "הרצאה", number: "01" };
    const second = { courseNumber: "89-210", lessonType: "הרצאה", number: "01" };
    const span = { semester: FALL, day: "tuesday" as const, start: "16:00", end: "17:00" };

    const keys = clashingGroups([
      { kind: "meeting-meeting", overlap: span, first: { group: first, meeting: span }, second: { group: second, meeting: span } },
      { kind: "meeting-blocked-time", overlap: span, group: first, meeting: span, blockedTime: span },
    ]);

    expect([...keys].sort()).toEqual([groupKey(first), groupKey(second)].sort());
  });
});
