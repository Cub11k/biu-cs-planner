/**
 * Everything the week grid decides, with no DOM in sight: which days the week shows, which
 * hours it spans, where a Meeting's block sits and how much of it fits in the block. The
 * components in this folder turn these answers into elements and nothing more, which is
 * what lets the ticket's acceptance criteria be tested without a browser
 * (vitest.config.ts; docs/design.md, "Development").
 */
import { meetingsInSemester, type Day, type Group, type Semester } from "./catalog.ts";

/** Sunday to Thursday, always. Friday joins them only when something meets on it. */
export const WEEK_DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
] as const satisfies readonly Day[];

const FRIDAY = "friday" satisfies Day;

/** Every day a Meeting can fall on, in the order the week reads. */
const ALL_DAYS: readonly Day[] = [...WEEK_DAYS, FRIDAY];

/** A literal pattern, never one built from data (ADR-0007). Mirrors the Catalog schema. */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes since midnight, or undefined for a time the grid cannot place. */
export function parseClock(clock: string): number | undefined {
  if (!CLOCK_TIME.test(clock)) return undefined;
  const [hours, minutes] = clock.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * One Meeting of one Group, ready to be drawn. `lane` and `lanes` are how Meetings that
 * overlap within a day sit side by side instead of hiding one another — three tirgul
 * Groups of 89-110 really are offered at the same hour, so this is the common case and
 * not the exception (docs/design.md, "Clashes").
 */
export type Tile = {
  /** Stable across renders, so React keeps the element a hover is happening on. */
  key: string;
  /** The Group a tile belongs to. Its number and Lesson Type together identify it. */
  groupKey: string;
  day: Day;
  group: Group;
  startMinutes: number;
  endMinutes: number;
  lane: number;
  lanes: number;
};

/** Group identity is the number and the Lesson Type together (CONTEXT.md, "Group"). */
export function groupKey(group: Group): string {
  return `${group.lessonType}|${group.number}`;
}

/**
 * The Meetings of these Groups in this Semester, placed. A Meeting whose times cannot be
 * read, or that ends before it starts, is left off the grid rather than drawn somewhere
 * wrong; the Catalog schema makes both rare, and a tile at midnight would be a lie.
 */
export function tilesFor(groups: readonly Group[], semester: Semester): Tile[] {
  const placed: Tile[] = [];

  groups.forEach((group, groupIndex) => {
    meetingsInSemester(group, semester).forEach((meeting, meetingIndex) => {
      const startMinutes = parseClock(meeting.start);
      const endMinutes = parseClock(meeting.end);
      if (startMinutes === undefined || endMinutes === undefined) return;
      if (endMinutes <= startMinutes) return;

      placed.push({
        key: `${groupIndex}:${meetingIndex}`,
        groupKey: groupKey(group),
        day: meeting.day,
        group,
        startMinutes,
        endMinutes,
        lane: 0,
        lanes: 1,
      });
    });
  });

  return ALL_DAYS.flatMap((day) =>
    intoLanes(placed.filter((tile) => tile.day === day)),
  );
}

/**
 * Overlapping tiles share the width of their day. A run of tiles that overlap — directly
 * or through a neighbour — is one cluster, and every tile in it is given the same number
 * of lanes so their edges line up.
 */
function intoLanes(tiles: Tile[]): Tile[] {
  const sorted = [...tiles].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes,
  );

  const done: Tile[] = [];
  let cluster: Tile[] = [];
  let laneEnds: number[] = [];

  const closeCluster = (): void => {
    for (const tile of cluster) done.push({ ...tile, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };

  for (const tile of sorted) {
    // nothing still running reaches this tile, so a new cluster starts here
    if (laneEnds.length > 0 && laneEnds.every((end) => end <= tile.startMinutes)) closeCluster();

    const free = laneEnds.findIndex((end) => end <= tile.startMinutes);
    const lane = free === -1 ? laneEnds.length : free;
    laneEnds[lane] = tile.endMinutes;
    cluster.push({ ...tile, lane });
  }
  closeCluster();

  return done;
}

/**
 * Friday appears only when a shown Group meets on Friday, which is most weeks' answer:
 * a CS week that does not run to Friday should not spend a column saying so.
 */
export function daysShown(tiles: readonly Tile[]): Day[] {
  const days: Day[] = [...WEEK_DAYS];
  if (tiles.some((tile) => tile.day === FRIDAY)) days.push(FRIDAY);
  return days;
}

export type HourRange = { startHour: number; endHour: number };

/** What an empty week spans: a normal teaching day, so the grid is not a thin band. */
export const DEFAULT_HOUR_RANGE: HourRange = { startHour: 8, endHour: 20 };

/** Below this the grid stops being a week and starts being a strip. */
export const MIN_HOURS = 6;

/**
 * An hour range that fits what is on screen: whole hours around the shown Meetings, grown
 * downwards in the evening and then upwards in the morning until the week has room to
 * read as one (docs/design.md, "Grid and Picks").
 */
export function hourRange(tiles: readonly Tile[]): HourRange {
  if (tiles.length === 0) return DEFAULT_HOUR_RANGE;

  let startHour = Math.floor(Math.min(...tiles.map((tile) => tile.startMinutes)) / 60);
  let endHour = Math.ceil(Math.max(...tiles.map((tile) => tile.endMinutes)) / 60);

  while (endHour - startHour < MIN_HOURS && endHour < 24) endHour += 1;
  while (endHour - startHour < MIN_HOURS && startHour > 0) startHour -= 1;

  return { startHour, endHour };
}

/** The hour lines a grid of this range carries, top to bottom. */
export function hourLines(range: HourRange): number[] {
  const lines: number[] = [];
  for (let hour = range.startHour; hour <= range.endHour; hour += 1) lines.push(hour);
  return lines;
}

/**
 * Where a tile sits. Top and height are pixels, because the row height is what makes a
 * Meeting's exact minutes visible; the lane is a percentage of the day, so the column can
 * be any width. Both are given as logical values — `start` is the right in Hebrew.
 */
export type TileBox = {
  topPx: number;
  heightPx: number;
  startPercent: number;
  widthPercent: number;
};

/** A hairline between stacked blocks, so two back-to-back Meetings read as two. */
const BLOCK_GAP_PX = 2;

export function tileBox(tile: Tile, range: HourRange, hourPx: number): TileBox {
  const pxPerMinute = hourPx / 60;
  const fromTop = tile.startMinutes - range.startHour * 60;
  const height = (tile.endMinutes - tile.startMinutes) * pxPerMinute;

  return {
    topPx: fromTop * pxPerMinute,
    heightPx: Math.max(height - BLOCK_GAP_PX, 1),
    startPercent: (tile.lane / tile.lanes) * 100,
    widthPercent: 100 / tile.lanes,
  };
}

/** Taller than this and the times fit under the name. */
export const TIMES_FIT_ABOVE_PX = 104;

/** Shorter than this and the name gets one line rather than two. */
export const ONE_LINE_BELOW_PX = 86;

export type TileText = {
  /** The Course name, first, because that is what a student scans for. */
  name: string;
  /** course number · Lesson Type · Group, with the times when the block is tall enough. */
  detail: string;
  nameLines: 1 | 2;
};

export function tileText(input: {
  name: string;
  courseNumber: string;
  lessonTypeName: string;
  groupNumber: string;
  startMinutes: number;
  endMinutes: number;
  heightPx: number;
}): TileText {
  const parts = [input.courseNumber, input.lessonTypeName, input.groupNumber];
  if (input.heightPx >= TIMES_FIT_ABOVE_PX) {
    parts.push(`${formatClock(input.startMinutes)}–${formatClock(input.endMinutes)}`);
  }

  return {
    name: input.name,
    detail: parts.join(" · "),
    nameLines: input.heightPx < ONE_LINE_BELOW_PX ? 1 : 2,
  };
}
