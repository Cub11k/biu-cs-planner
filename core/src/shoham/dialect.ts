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
   * An hours cell holding more than two `-`-separated fields, so not one range: neither
   * `16:00 - 16:00 - 17:00`, whose meaning is not established, nor two ranges run together on
   * one line, whose meaning is plain but whose reading is not this ticket's to settle (#70, #74).
   * Either way no Meeting is made of it rather than a range being picked out of the fields.
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

export function parseGroupMeetings(row: {
  day: string;
  hours: string;
  semester: string;
}): { semesters: Semester[]; meetings: Meeting[]; warnings: MeetingWarning[] } {
  const semesters = parseSemesters(row.semester);
  if (!row.day.trim()) return { semesters, meetings: [], warnings: [] };

  const days = row.day.split(",").map((d) => d.trim());
  const ranges = row.hours.split("\n").map((h) => h.trim()).filter(Boolean);

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
