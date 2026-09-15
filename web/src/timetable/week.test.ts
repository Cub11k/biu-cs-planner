import { describe, expect, it } from "vitest";
import type { Group, Semester } from "./catalog.ts";
import {
  DEFAULT_HOUR_RANGE,
  daysShown,
  formatClock,
  hourLines,
  hourRange,
  parseClock,
  tileBox,
  tileText,
  tilesFor,
  WEEK_DAYS,
} from "./week.ts";

const FALL: Semester = "fall";

/** A Group as the API hands it over, with its Meetings written the way Shoham writes them. */
function group(
  number: string,
  lessonType: string,
  meetings: ReadonlyArray<[Group["meetings"][number]["day"], string, string, Semester?]>,
): Group {
  return {
    number,
    lessonType,
    lecturers: [],
    meetings: meetings.map(([day, start, end, semester]) => ({
      semester: semester ?? FALL,
      day,
      start,
      end,
    })),
  };
}

describe("reading and writing a clock time", () => {
  it("reads a time as minutes since midnight", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("15:30")).toBe(930);
    expect(parseClock("23:59")).toBe(1439);
  });

  it("refuses a time it cannot place rather than guessing at one", () => {
    expect(parseClock("24:00")).toBeUndefined();
    expect(parseClock("9:00")).toBeUndefined();
    expect(parseClock("")).toBeUndefined();
  });

  it("writes minutes back as a padded clock time", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(930)).toBe("15:30");
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
    expect(new Set(tiles.map((tile) => tile.groupKey))).toEqual(new Set(["הרצאה|01"]));
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
  });

  it("adds the times once the block is tall enough to hold them", () => {
    expect(tileText({ ...base, heightPx: 180 }).detail).toBe(
      "89-110 · Lecture · 01 · 15:00–18:00",
    );
  });

  it("wraps the name to two lines, or one in a short block", () => {
    expect(tileText({ ...base, heightPx: 120 }).nameLines).toBe(2);
    expect(tileText({ ...base, heightPx: 40 }).nameLines).toBe(1);
  });
});
