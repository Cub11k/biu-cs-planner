/**
 * Everything the week grid decides, with no DOM in sight: which days the week shows, which
 * hours it spans, where a Meeting's block sits and how much of it fits in the block. The
 * components in this folder turn these answers into elements and nothing more, which is
 * what lets the ticket's acceptance criteria be tested without a browser
 * (vitest.config.ts; docs/design.md, "Development").
 */
import { meetingsInSemester, type Day, type Meeting, type Offering, type Semester } from "./catalog.ts";
import type { Clash, GroupPick } from "./picks.ts";

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

/**
 * The end of the day in minutes. A number the grid computes with and never a string: `24:00`
 * is spelled nowhere, and `formatClock` writes this back as `00:00`.
 */
const END_OF_DAY = 24 * 60;

/**
 * Minutes since midnight, or undefined for a time the grid cannot place. This is the reading
 * of a `start`: `00:00` is the beginning of the day, 0 minutes in, so a Meeting written
 * `00:00`-`08:00` is the night and not the whole day. An `end` is read by `parseClockAsEnd`.
 */
export function parseClock(clock: string): number | undefined {
  if (!CLOCK_TIME.test(clock)) return undefined;
  const [hours, minutes] = clock.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * A clock string read as the `end` of a range: `00:00` is the end of the day, 1440 minutes
 * in, so a Meeting written `22:00`-`00:00` runs to the bottom of its day rather than ending
 * before it began. One spelling of midnight, and the position is what says which end of the
 * day is meant; `core` reads the same clock the same way and `fixtures/clock-ranges.json` is
 * the table both are tested against (issue #48).
 *
 * A second function rather than a flag on `parseClock`: the position is the caller's and is
 * fixed at the call site, and a flag invites `asEnd: someCondition` — which is the conditional
 * reading this ticket came from.
 */
export function parseClockAsEnd(clock: string): number | undefined {
  const read = parseClock(clock);
  if (read === undefined) return undefined;

  return read === 0 ? END_OF_DAY : read;
}

/**
 * Minutes back as a clock string. The end of the day comes back as `00:00`, the spelling it
 * went in as: a tile for `22:00`-`00:00` reads `22:00-00:00`, and the hour gutter's last line
 * over a day that runs to the bottom reads `00:00` rather than a `24:00` no clock has.
 */
export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * A Group as the week draws it.
 *
 * Not a Catalog Group: a Pick carries its own snapshot of the Meetings it was made from
 * and no Catalog entry at all, so a week that could only draw Catalog Groups could not
 * draw a Pick whose Course has since left the Catalog — which is the Pick a student most
 * needs to see. The Course travels with the Group for the same reason: one week can show
 * Picks from several Courses at once, and a tile has to say which.
 */
export type WeekGroup = {
  courseNumber: string;
  /** What a tile writes first; the course number alone when nothing can name the Course. */
  courseName: string;
  lessonType: string;
  number: string;
  meetings: readonly Meeting[];
  /**
   * Ink rather than pencil: this Group is a Pick (docs/design.md, "Visual language").
   *
   * `undefined` is **unknown**, and is not `false`: until the first Timetable answer lands
   * the page has not read the State File, so it cannot say whether this Group is a Pick.
   * A `false` there would let the week draw a Pick as an option and let a click decide
   * between recording and removing on a guess (#111).
   */
  picked: boolean | undefined;
};

/**
 * One Meeting of one Group, ready to be drawn. `lane` and `lanes` are how Meetings that
 * overlap within a day sit side by side instead of hiding one another — three tirgul
 * Groups of 89-110 really are offered at the same hour, so this is the common case and
 * not the exception (docs/design.md, "Clashes").
 */
export type Tile = {
  /** Stable across renders, so React keeps the element a hover is happening on. */
  key: string;
  /** The Group a tile belongs to; every Meeting of one Group shares it. */
  groupKey: string;
  day: Day;
  group: WeekGroup;
  startMinutes: number;
  endMinutes: number;
  lane: number;
  lanes: number;
};

/**
 * Group identity is the number and the Lesson Type together (CONTEXT.md, "Group"), under
 * the Course — each Lesson Type is numbered from 01, so every Course has a lecture 01 and
 * the Course is what tells two of them apart on one week.
 */
export function groupKey(group: {
  courseNumber: string;
  lessonType: string;
  number: string;
}): string {
  return `${group.courseNumber}|${group.lessonType}|${group.number}`;
}

/**
 * The Groups one week shows: every Pick in the Variant, plus the Groups of the Course the
 * student is looking at as options they have not taken.
 *
 * A Group that is both — an option of the chosen Course that is also the Pick for its
 * Lesson Type — appears once, as the Pick. Drawing it twice would stack a pencil block
 * exactly over its own ink and halve the width of both.
 */
export function weekGroups(input: {
  /** The Course whose Groups are on the week as options; none until one is chosen. */
  offering: Offering | undefined;
  /**
   * Every Pick in the Variant, whichever Course it belongs to — or `undefined` while the
   * State File has not been read, which is not the same as a Variant with no Picks in it.
   */
  picks: readonly GroupPick[] | undefined;
  /** The Course as the student should read it; its number when nothing can name it. */
  nameOf: (courseNumber: string) => string;
}): WeekGroup[] {
  const picked: WeekGroup[] = (input.picks ?? []).map((pick) => ({
    courseNumber: pick.courseNumber,
    courseName: input.nameOf(pick.courseNumber),
    lessonType: pick.lessonType,
    number: pick.groupNumber,
    meetings: pick.meetings,
    picked: true,
  }));

  const already = new Set(picked.map(groupKey));
  const offering = input.offering;
  // An option is only known *not* to be a Pick once the Picks are known. Before that the
  // Group is on the week — it is in the Catalog, which has been read — with its pick state
  // left unsaid rather than answered `false`.
  const unpicked = input.picks === undefined ? undefined : false;
  const options: WeekGroup[] =
    offering === undefined
      ? []
      : offering.groups.map((group) => ({
          courseNumber: offering.courseNumber,
          courseName: input.nameOf(offering.courseNumber),
          lessonType: group.lessonType,
          number: group.number,
          meetings: group.meetings,
          picked: unpicked,
        }));

  return [...picked, ...options.filter((group) => !already.has(groupKey(group)))];
}

/**
 * Whether this exact Group is among these Picks. Identity is the `groupKey` — the Course,
 * the Lesson Type and the Group number together (CONTEXT.md, "Group") — so a Pick of
 * another Group in the same slot is not this Group.
 *
 * Asked of the Picks rather than read off `WeekGroup.picked`, because the one caller that
 * needs it is a click made when `picked` was still unknown: the answer that arrived
 * afterwards is what knows, and the tile does not.
 */
export function isPicked(
  picks: readonly GroupPick[],
  group: { courseNumber: string; lessonType: string; number: string },
): boolean {
  const wanted = groupKey(group);
  return picks.some(
    (pick) =>
      groupKey({
        courseNumber: pick.courseNumber,
        lessonType: pick.lessonType,
        number: pick.groupNumber,
      }) === wanted,
  );
}

/**
 * The Groups a Clash touches, as keys a tile can be looked up by. Red pen is a property of
 * the Group and not of the one Meeting that overlaps: a Group is picked whole, so the
 * student has to see which Group to change, not only which hour is double-booked.
 */
export function clashingGroups(clashes: readonly Clash[]): Set<string> {
  const keys = new Set<string>();
  for (const clash of clashes) {
    if (clash.kind === "meeting-meeting") {
      keys.add(groupKey(clash.first.group));
      keys.add(groupKey(clash.second.group));
    } else {
      keys.add(groupKey(clash.group));
    }
  }
  return keys;
}

/**
 * The Meetings of these Groups in this Semester, placed. A Meeting whose times cannot be
 * read, or that ends before it starts, is left off the grid rather than drawn somewhere
 * wrong; the Catalog schema makes both rare, and a tile at midnight would be a lie.
 */
export function tilesFor(groups: readonly WeekGroup[], semester: Semester): Tile[] {
  const placed: Tile[] = [];

  groups.forEach((group, groupIndex) => {
    meetingsInSemester(group, semester).forEach((meeting, meetingIndex) => {
      // Each end read in its own position, unconditionally, so that `core` and this agree on
      // every range: "22:00 - 00:00" is a Meeting that runs to midnight, "00:00 - 08:00" one
      // that runs from it, and "00:00 - 00:00" the whole day (issue #48).
      //
      // No Offering in the 2027 Catalog needs any of that. The sweep recorded on #48 found 15
      // distinct clock strings across all four 2027 workbooks, none of them 00:00 or 24:00,
      // and the latest any Meeting ends is 21:00 — so this rule is here because a Blocked Time
      // is student-entered and a Day has to end somewhere, not because Shoham was observed
      // writing it. The crawl lives outside this repo (ADR-0005), so nothing here re-checks
      // that count; it is what the data said when the rule was decided.
      const startMinutes = parseClock(meeting.start);
      const endMinutes = parseClockAsEnd(meeting.end);
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

/** Two decimals: enough to keep a Meeting on its own minute, short enough to read. */
const round = (value: number): number => Math.round(value * 100) / 100;

export function tileBox(tile: Tile, range: HourRange, hourPx: number): TileBox {
  const fromTop = tile.startMinutes - range.startHour * 60;
  const height = ((tile.endMinutes - tile.startMinutes) * hourPx) / 60;

  return {
    topPx: round((fromTop * hourPx) / 60),
    heightPx: round(Math.max(height - BLOCK_GAP_PX, 1)),
    startPercent: round((tile.lane / tile.lanes) * 100),
    widthPercent: round(100 / tile.lanes),
  };
}

/** Taller than this and the times fit under the name. */
export const TIMES_FIT_ABOVE_PX = 104;

/** Shorter than this and the name gets one line rather than two. */
export const ONE_LINE_BELOW_PX = 86;

export type TileText = {
  /** The Course name, first, because that is what a student scans for. */
  name: string;
  /** course number · Lesson Type · Group. */
  detail: string;
  /**
   * The times, once the block is tall enough to hold them. Separate from `detail` because
   * they have to be rendered inside their own direction isolate: the dash between two
   * clock times is bidi-neutral, so in a Hebrew paragraph "15:00–18:00" would otherwise
   * be reordered into "18:00–15:00".
   */
  times: string | undefined;
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
  const fits = input.heightPx >= TIMES_FIT_ABOVE_PX;

  return {
    name: input.name,
    detail: [input.courseNumber, input.lessonTypeName, input.groupNumber].join(" · "),
    times: fits
      ? `${formatClock(input.startMinutes)}–${formatClock(input.endMinutes)}`
      : undefined,
    nameLines: input.heightPx < ONE_LINE_BELOW_PX ? 1 : 2,
  };
}
