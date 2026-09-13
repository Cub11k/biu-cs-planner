import { parseSemesters } from "./dialect.ts";
import type { Exam, Semester } from "../catalog/schema.ts";

export type { Exam };

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

/** Shoham writes dates as DD/MM/YYYY. */
function isoDate(date: string): string | undefined {
  const parts = date.split("/");
  if (parts.length !== 3) return undefined;
  const [day, month, year] = parts as [string, string, string];
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function parseDetailKey(key: string): DetailKey | undefined {
  const separator = key.indexOf("|");
  if (separator < 1) return undefined;
  const code = key.slice(0, separator);
  const semesters = parseSemesters(key.slice(separator + 1));
  if (!semesters.length) return undefined;
  return { courseNumber: `${code.slice(0, 2)}-${code.slice(2)}`, semesters };
}

export function parseCredits(points: string | undefined): number | undefined {
  if (points === undefined) return undefined;
  const credits = Number(points);
  return Number.isFinite(credits) ? credits : undefined;
}

export function parseExams(detail: RawDetail): Exam[] {
  return (detail.terms ?? []).flatMap((term) => {
    const date = isoDate(term.date);
    return date ? [{ moed: term.type, date, time: term.hour }] : [];
  });
}
