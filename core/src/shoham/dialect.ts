/**
 * The Shoham dialect: the Hebrew strings Shoham renders, turned into domain values.
 *
 * Public because two callers need it — a row's own Semester cell, and the Semester
 * buried inside a detail record's key. See docs/research/shoham-raw-shape.md.
 */
import type { Day, Meeting, Semester } from "../catalog/schema.ts";

const SEMESTERS: ReadonlyArray<readonly [string, Semester]> = [
  ["סמסטר א'", "fall"],
  ["סמסטר ב'", "spring"],
  ["סמסטר ק'", "summer"],
];

const DAYS: Readonly<Record<string, Day>> = {
  "א'": "sunday",
  "ב'": "monday",
  "ג'": "tuesday",
  "ד'": "wednesday",
  "ה'": "thursday",
  "ו'": "friday",
};

/** Shoham writes a course number without its hyphen: 89110 is 89-110, 891195 is 89-1195. */
/**
 * A literal pattern, never one built from data: ADR-0007 and the Code guardrails forbid
 * regular expressions assembled from Catalog or Requirements content.
 */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isClockTime(value: string): boolean {
  return CLOCK_TIME.test(value);
}

export function parseCourseNumber(code: string): string {
  return `${code.slice(0, 2)}-${code.slice(2)}`;
}

/**
 * A cell naming two Semesters is how Shoham shows a Year-long Course; there is no שנתי marker.
 *
 * The labels are found wherever they sit rather than by splitting the cell, because the same
 * Year-long cell reaches us both as two lines and as one run-together string, and both have to
 * mean the same thing (ADR-0010). Order follows the cell, not the table above.
 *
 * The hours cell is read the same way and for the same reason, by scanRanges below (#74).
 */
export function parseSemesters(cell: string): Semester[] {
  const found: Array<{ at: number; semester: Semester }> = [];
  for (const [label, semester] of SEMESTERS) {
    for (let at = cell.indexOf(label); at !== -1; at = cell.indexOf(label, at + label.length)) {
      found.push({ at, semester });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.semester);
}

/**
 * Why a Group's Meetings could not be read in full: what was wrong with its hours, or with the
 * cell they were written in. Never blocks the import.
 */
export type MeetingWarning =
  | { kind: "hours-do-not-divide" }
  | { kind: "meeting-unreadable" }
  /**
   * An hours cell holding more than two `-`-separated fields, so not one range:
   * `16:00 - 16:00 - 17:00`, whose meaning is not established, so no Meeting is made of it
   * rather than a range being picked out of the fields (#70).
   *
   * Two ranges run together on one line are no longer this. Their meaning is established -- by
   * the repository's own finding, which says a reader has to accept both spellings -- so they
   * read as the two ranges they are (#74). What is left here is the cell that is neither one
   * range nor a run of them, which is still reported rather than guessed at. A cell that holds
   * one range's worth of fields and fails to be one, `1500 - 1800`, is `meeting-unreadable`
   * still: what is wrong with it is the time, not the shape of the cell.
   *
   * `cell` is the text as it stood, so a maintainer can find it on the Shoham page. Where the
   * cell holds a range per line it is the offending line, which is the line no Meeting came of.
   */
  | { kind: "hours-cell-not-one-range"; cell: string };

/**
 * Whether a line of an hours cell holds anything other than one range: more than two
 * `-`-separated fields, however readable each field looks on its own. Written once and asked
 * twice -- of the cell, to report it, and of the line, to refuse a Meeting from it -- because
 * the Warning and the refusal drifting apart is how a dropped field goes quiet again.
 */
function isNotOneRange(text: string): boolean {
  return text.split("-").length > 2;
}

/**
 * A literal pattern, never one built from data: ADR-0007 and the Code guardrails forbid
 * regular expressions assembled from Catalog or Requirements content. One `HH:MM - HH:MM`
 * range, with or without spaces around its own separator, since Shoham's cells carry both.
 *
 * The clock spelling is CLOCK_TIME's, written out again rather than composed, because composing
 * it means building the pattern from a string and a literal is what the guardrail asks for. That
 * makes this the same body ADR-0012 says five files carry without varying, now written twice more
 * inside one of the five. Unlike those five, the pair is not left entirely to review:
 * dialect.test.ts asserts that every time the clock accepts is a time this pattern finds, which
 * is the direction that can go quiet -- narrow this pattern, or widen the clock, and a cell that
 * imported its Meetings stops doing so. The other direction needs no guard, because CLOCK_TIME
 * stays the authority: isClockTime is asked again of every range a scan finds, so a spelling this
 * pattern admits and the clock refuses is reported, never trusted.
 *
 * Only ever read with `matchAll`: `exec` and `test` on a `g` pattern leave a position behind on
 * the pattern itself, and two calls would stop agreeing.
 */
const CLOCK_RANGE = /([01]\d|2[0-3]):[0-5]\d\s*-\s*([01]\d|2[0-3]):[0-5]\d/g;

/**
 * The ranges one line of an hours cell holds, or null when the line is not a run of them.
 *
 * The ranges are found wherever they sit rather than by splitting the line, for the reason
 * parseSemesters scans for its labels: the same cell reaches us both as one range per line and
 * as the ranges run together on one line, and both have to mean the same thing (#74, ADR-0010).
 * A split cannot do it -- a range writes spaces around its own `-`, so splitting on whitespace
 * tears `16:00 - 18:00` into three -- so the occurrences are scanned for instead. (`matchAll`
 * reads a copy of the pattern, so the shared CLOCK_RANGE keeps no position between calls.)
 *
 * A line is a run only when nothing but whitespace lies between the occurrences and at either
 * end -- nothing at all counts, since the artifact's worst form leaves no separator, as the
 * Semester cell's does. That rule is what holds this to the one shape #74 settled:
 * `14:00 - 16:00 - 18:00` has a `-` between its two occurrences, so it is no run and stays what
 * #70 made it, a cell reported as itself. Null says "not a run", leaving the line to be read
 * exactly as it was before #74.
 */
function scanRanges(line: string): string[] | null {
  const ranges: string[] = [];
  let after = 0;
  for (const found of line.matchAll(CLOCK_RANGE)) {
    if (line.slice(after, found.index).trim()) return null;
    ranges.push(found[0]);
    after = found.index + found[0].length;
  }
  if (line.slice(after).trim()) return null;
  // A blank line is a run of no ranges, and cannot arrive here anyway: the caller drops it.
  return ranges;
}

export function parseGroupMeetings(row: {
  day: string;
  hours: string;
  semester: string;
}): { semesters: Semester[]; meetings: Meeting[]; warnings: MeetingWarning[] } {
  const semesters = parseSemesters(row.semester);
  if (!row.day.trim()) return { semesters, meetings: [], warnings: [] };

  const days = row.day.split(",").map((d) => d.trim());
  // One range per line is the clean spelling and a run of ranges on one line is the same cell
  // damaged by a crawl, so both give the ranges they hold. A line that is neither is kept whole
  // and read exactly as it was before #74: as one range if that is what it turns out to be, and
  // otherwise reported -- as the cell it is, or as a time that could not be read.
  const ranges = row.hours
    .split("\n")
    .map((h) => h.trim())
    .filter(Boolean)
    .flatMap((line) => scanRanges(line) ?? [line]);

  // A Year-long Group repeats its weekly hours once per Semester, so the ranges arrive as
  // one block per Semester. Cut them back into blocks before pairing them with the days.
  // A Year-long Group writes its hours one of two ways, and both are common: repeated once
  // per Semester (ranges = days x Semesters), or written once and meant for every Semester
  // (ranges = days). Anything else is reported rather than guessed at.
  const repeated = ranges.length === days.length * semesters.length;
  const shared = ranges.length === days.length;
  const divides = repeated || shared;
  const warnings: MeetingWarning[] = divides ? [] : [{ kind: "hours-do-not-divide" }];

  // Read off the cell here, before the ranges are paired with the days, because what is wrong
  // is the cell rather than any one Meeting. Once per distinct text, whatever repeats it -- a
  // Year-long Group writes its block once per Semester, and two days can carry the same broken
  // line -- since one text to go looking for on the Shoham page is the whole of what this says.
  // Raised however the hours divide: the suppression at the foot of this function rests on an
  // uneven split explaining every missing Meeting, and an uneven split does not explain this.
  for (const cell of new Set(ranges.filter(isNotOneRange))) {
    warnings.push({ kind: "hours-cell-not-one-range", cell });
  }

  const meetings: Meeting[] = [];
  let unreadable = false;
  semesters.forEach((semester, semesterIndex) => {
    // When the counts do not divide either way, nothing past the first block can be trusted,
    // so the later Semesters are left without Meetings rather than given invented ones.
    if (!divides && semesterIndex > 0) return;
    const blockIndex = shared ? 0 : semesterIndex;
    const block = ranges.slice(blockIndex * days.length, (blockIndex + 1) * days.length);
    days.forEach((dayLabel, index) => {
      const day = DAYS[dayLabel];
      const range = block[index];
      if (!day || !range) {
        unreadable = true;
        return;
      }
      // Reported above as the cell it is, and so not counted unreadable here as well, which
      // would say the same thing twice and less precisely. Keeping the first two fields is what
      // this replaces: `16:00 - 16:00 - 17:00` read as 16:00-16:00 drops a field without a word
      // and hands #52's check a Meeting occupying no time, which it explains as a Shoham typo
      // where the same time was written twice -- a confident wrong answer (#70).
      if (isNotOneRange(range)) return;
      const [start, end] = range.split("-").map((t) => t.trim());
      if (!start || !end || !isClockTime(start) || !isClockTime(end)) {
        unreadable = true;
        return;
      }
      meetings.push({ semester, day, start, end });
    });
  });
  // An uneven split already explains every Meeting missing from the short block, so it is
  // not also reported one by one: a Warning nobody can act on is a Warning nobody reads.
  if (unreadable && divides) warnings.push({ kind: "meeting-unreadable" });
  return { semesters, meetings, warnings };
}
