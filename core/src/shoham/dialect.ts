/**
 * The Shoham dialect: the Hebrew strings Shoham renders, turned into domain values.
 *
 * Public because two callers need it — a row's own Semester cell, and the Semester
 * buried inside a detail record's key. See docs/research/shoham-raw-shape.md.
 */
export type Semester = "fall" | "spring" | "summer";

export type Day = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday";

export type Meeting = { semester: Semester; day: Day; start: string; end: string };

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

/** A cell naming two Semesters is how Shoham shows a Year-long Course; there is no שנתי marker. */
export function parseSemesters(cell: string): Semester[] {
  const found: Semester[] = [];
  for (const line of cell.split("\n")) {
    const match = SEMESTERS.find(([label]) => line.trim() === label);
    if (match) found.push(match[1]);
  }
  return found;
}

export function parseGroupSchedule(row: {
  day: string;
  hours: string;
  semester: string;
}): { semesters: Semester[]; meetings: Meeting[] } {
  const semesters = parseSemesters(row.semester);
  if (!row.day.trim()) return { semesters, meetings: [] };

  const days = row.day.split(",").map((d) => d.trim());
  const ranges = row.hours.split("\n").map((h) => h.trim()).filter(Boolean);

  // A Year-long Group repeats its weekly hours once per Semester, so the ranges arrive as
  // one block per Semester. Cut them back into blocks before pairing them with the days.
  const meetings: Meeting[] = [];
  semesters.forEach((semester, blockIndex) => {
    const block = ranges.slice(blockIndex * days.length, (blockIndex + 1) * days.length);
    days.forEach((dayLabel, index) => {
      const day = DAYS[dayLabel];
      const range = block[index];
      if (!day || !range) return;
      const [start, end] = range.split("-").map((t) => t.trim());
      if (start && end) meetings.push({ semester, day, start, end });
    });
  });
  return { semesters, meetings };
}
