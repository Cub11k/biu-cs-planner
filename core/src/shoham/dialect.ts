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

/** Why a Group's Meetings could not be read in full. Never blocks the import. */
export type MeetingWarning = "hours-do-not-divide" | "meeting-unreadable";

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
  const warnings: MeetingWarning[] = divides ? [] : ["hours-do-not-divide"];

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
  if (unreadable && divides) warnings.push("meeting-unreadable");
  return { semesters, meetings, warnings };
}
