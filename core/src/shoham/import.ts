import { parseGroupSchedule, type Meeting, type Semester } from "./dialect.ts";
import { parseCredits, parseDetailKey, parseExams, type Exam, type RawDetail } from "./details.ts";

export type RawCrawlRow = {
  code: string;
  name: string;
  group: string;
  teachers: string;
  kind: string;
  semester: string;
  day: string;
  hours: string;
  lid: string;
};

export type RawCrawl = {
  rows?: RawCrawlRow[];
  details?: Record<string, RawDetail>;
};

export type Group = {
  number: string;
  lessonType: string;
  lecturers: string[];
  meetings: Meeting[];
};

/**
 * Exams are `known: false` until a detail record read from the course's first lecture
 * Group says otherwise: an absent Exam list elsewhere means "not shown", not "none".
 */
export type Exams = { known: boolean; sittings: Exam[] };

export type Offering = {
  courseNumber: string;
  nameHebrew: string;
  credits?: number;
  semesters: Semester[];
  groups: Group[];
  exams: Exams;
};

export type Catalog = { academicYear: number; offerings: Offering[] };

export type Warning = { message: string };

/** Shoham writes a course number without its hyphen: 89110 is 89-110, 891195 is 89-1195. */
function courseNumberFrom(code: string): string {
  return `${code.slice(0, 2)}-${code.slice(2)}`;
}

function lecturersFrom(teachers: string): string[] {
  return teachers.split("\n").map((t) => t.trim()).filter(Boolean);
}

/** The key an Offering is merged on: a Course plus the Semesters it spans. */
function offeringKey(courseNumber: string, semesters: Semester[]): string {
  return `${courseNumber}|${semesters.join("+")}`;
}

export function importRawCrawl(
  crawl: RawCrawl,
  options: { academicYear: number; into?: Catalog },
): { catalog: Catalog; warnings: Warning[] } {
  // One Offering per Course and Semester set. A Year-long row names two Semesters and so
  // forms its own Offering, separate from the same Course given only in Fall.
  // A part is merged into what is already there rather than replacing it, and the Catalog
  // it is merged into is left untouched (ADR-0010).
  const offerings = new Map<string, Offering>();
  for (const existing of options.into?.offerings ?? []) {
    offerings.set(offeringKey(existing.courseNumber, existing.semesters), {
      ...existing,
      semesters: [...existing.semesters],
      groups: existing.groups.map((group) => ({ ...group, meetings: [...group.meetings] })),
      exams: { ...existing.exams, sittings: [...existing.exams.sittings] },
    });
  }

  for (const row of crawl.rows ?? []) {
    const { semesters, meetings } = parseGroupSchedule(row);
    const courseNumber = courseNumberFrom(row.code);
    const key = offeringKey(courseNumber, semesters);

    let offering = offerings.get(key);
    if (!offering) {
      offering = {
        courseNumber,
        nameHebrew: row.name,
        semesters,
        groups: [],
        exams: { known: false, sittings: [] },
      };
      offerings.set(key, offering);
    }

    offering.groups.push({
      number: row.group,
      lessonType: row.kind,
      lecturers: lecturersFrom(row.teachers),
      meetings,
    });
  }

  for (const [key, detail] of Object.entries(crawl.details ?? {})) {
    const parsed = parseDetailKey(key);
    if (!parsed) continue;
    const offering = offerings.get(offeringKey(parsed.courseNumber, parsed.semesters));
    if (!offering) continue;

    const credits = parseCredits(detail.points);
    if (credits !== undefined) offering.credits = credits;

    // An absent Exam list means "not published for the Group this was read from", never
    // "this Offering has no Exam", so only a record that carries Exams settles the question.
    const sittings = parseExams(detail);
    if (sittings.length) offering.exams = { known: true, sittings };
  }

  return {
    catalog: { academicYear: options.academicYear, offerings: [...offerings.values()] },
    warnings: [],
  };
}
