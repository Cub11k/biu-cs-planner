import { isClockTime, parseCourseNumber, parseSemesters } from "./dialect.ts";
import type { Exam, Semester } from "../catalog/schema.ts";

/**
 * The Course-wide facts: credits and Exams. They are keyed by course number and Semester,
 * and the Semester inside that key is written in more than one way across files, so the
 * key is normalised before anything is matched against it (ADR-0010).
 */
export type RawDetail = {
  points?: string;
  code?: string;
  hours?: string;
  terms?: Array<{ type: string; date: string; hour: string }>;
};

export type DetailKey = { courseNumber: string; semesters: Semester[] };

/** Shoham writes dates as DD/MM/YYYY. Returns undefined unless it really is one. */
function isoDate(date: string): string | undefined {
  const parts = date.split("/");
  if (parts.length !== 3) return undefined;
  const [day, month, year] = parts.map(Number) as [number, number, number];
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1000) return undefined;

  const iso = new Date(Date.UTC(year, month - 1, day));
  // rejects the 31st of a 30-day month, which the range checks above let through
  if (iso.getUTCMonth() !== month - 1 || iso.getUTCDate() !== day) return undefined;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDetailKey(key: string): DetailKey | undefined {
  const separator = key.indexOf("|");
  if (separator < 1) return undefined;
  const code = key.slice(0, separator);
  const semesters = parseSemesters(key.slice(separator + 1));
  if (!semesters.length) return undefined;
  return { courseNumber: parseCourseNumber(code), semesters };
}

export function parseCredits(points: string | undefined): number | undefined {
  if (points === undefined) return undefined;
  const credits = Number(points);
  return Number.isFinite(credits) ? credits : undefined;
}

export function parseExams(detail: RawDetail): { exams: Exam[]; unreadable: number } {
  const exams: Exam[] = [];
  let unreadable = 0;
  for (const term of detail.terms ?? []) {
    const date = isoDate(term.date);
    if (!date || !isClockTime(term.hour)) {
      unreadable += 1;
      continue;
    }
    exams.push({ moed: term.type, date, time: term.hour });
  }
  return { exams, unreadable };
}
