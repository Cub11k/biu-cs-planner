import { parseCourseNumber, parseGroupMeetings, type MeetingWarning } from "./dialect.ts";
import {
  parseDetailKey,
  parseExams,
  parseSampledGroup,
  parseWeeklyHours,
  type RawDetail,
} from "./details.ts";
import {
  CURRENT_CATALOG_SCHEMA_VERSION,
  type Catalog,
  type Offering,
  type Provenance,
  type Semester,
} from "../catalog/schema.ts";

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
  provenance?: Provenance;
};

export type Warning =
  | { kind: MeetingWarning | "semester-unreadable"; courseNumber: string; group: string }
  | { kind: "unusual-course-number"; courseNumber: string }
  | { kind: "course-number-unreadable"; code: string }
  | { kind: "detail-key-unreadable"; key: string }
  | { kind: "detail-without-offering"; courseNumber: string; semesters: Semester[] }
  | { kind: "weekly-hours-unreadable"; courseNumber: string }
  | { kind: "detail-group-unknown"; courseNumber: string }
  | { kind: "exam-unreadable"; courseNumber: string }
  | { kind: "academic-year-mismatch"; catalog: number; part: number }
  | { kind: "provenance-missing" };

/** Tails run to three or four digits. Anything else is reported and imported as it stands. */
function hasUnusualTail(code: string): boolean {
  const tail = code.slice(2);
  return tail.length < 3 || tail.length > 4;
}

function lecturersFrom(teachers: string): string[] {
  return teachers.split("\n").map((t) => t.trim()).filter(Boolean);
}

/**
 * Semesters in a fixed order. A cell can name them either way round, and the merge key must
 * not depend on which: otherwise one Year-long Course becomes two Offerings.
 */
const SEMESTER_ORDER: Semester[] = ["fall", "spring", "summer"];

function canonical(semesters: Semester[]): Semester[] {
  return [...semesters].sort((a, b) => SEMESTER_ORDER.indexOf(a) - SEMESTER_ORDER.indexOf(b));
}

/** The key an Offering is merged on: a Course plus the Semesters it spans. */
function offeringKey(courseNumber: string, semesters: Semester[]): string {
  return `${courseNumber}|${canonical(semesters).join("+")}`;
}

/**
 * What the Catalog holds after the import. The import screen shows this, with the Warnings,
 * before anything is written to the Workspace.
 */
export type ImportSummary = {
  offerings: number;
  groups: number;
  meetings: number;
  exams: number;
};

/**
 * An Offering's credits are one Group's weekly hours per Lesson Type, added up. Shoham
 * publishes hours per Group, so this is only settled once every Lesson Type is covered --
 * 89-132 is its lecture's 4 plus a tirgul's 2, and a single detail record cannot say so.
 */
function creditsOf(offering: Offering): Offering["credits"] {
  const perLessonType = new Map<string, number | undefined>();
  for (const group of offering.groups) {
    if (!perLessonType.get(group.lessonType)) {
      perLessonType.set(group.lessonType, group.weeklyHours);
    }
  }

  const hours = [...perLessonType.values()];
  if (!hours.length || hours.some((h) => h === undefined)) return { known: false };
  return { known: true, total: (hours as number[]).reduce((sum, h) => sum + h, 0) };
}

function summarise(catalog: Catalog): ImportSummary {
  let groups = 0;
  let meetings = 0;
  let exams = 0;
  for (const offering of catalog.offerings) {
    groups += offering.groups.length;
    for (const group of offering.groups) meetings += group.meetings.length;
    exams += offering.exams.sittings.length;
  }
  return { offerings: catalog.offerings.length, groups, meetings, exams };
}

export function importRawCrawl(
  crawl: RawCrawl,
  options: { academicYear: number; into?: Catalog },
): { catalog: Catalog; warnings: Warning[]; summary: ImportSummary } {
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

  const warnings: Warning[] = [];
  const reportedNumbers = new Set<string>();

  // A Catalog holds one Academic Year. Merging a part from another year would relabel the
  // Offerings already in it, so the part is refused and the Catalog handed back untouched.
  if (options.into && options.into.academicYear !== options.academicYear) {
    return {
      catalog: options.into,
      warnings: [
        { kind: "academic-year-mismatch", catalog: options.into.academicYear, part: options.academicYear },
      ],
      summary: summarise(options.into),
    };
  }

  // Provenance is optional, because no crawl on hand carries it, but a part that cannot say
  // where it came from is worth saying so about.
  const sources = [...(options.into?.sources ?? [])];
  if (crawl.provenance) sources.push(crawl.provenance);
  else warnings.push({ kind: "provenance-missing" });

  for (const row of crawl.rows ?? []) {
    const { semesters, meetings, warnings: meetingWarnings } = parseGroupMeetings(row);
    const courseNumber = parseCourseNumber(row.code);
    for (const kind of meetingWarnings) {
      warnings.push({ kind, courseNumber, group: row.group });
    }
    if (!semesters.length) {
      warnings.push({ kind: "semester-unreadable", courseNumber, group: row.group });
    }
    if (row.code.length < 3 && !reportedNumbers.has(courseNumber)) {
      reportedNumbers.add(courseNumber);
      warnings.push({ kind: "course-number-unreadable", code: row.code });
    }
    const key = offeringKey(courseNumber, semesters);

    if (hasUnusualTail(row.code) && !reportedNumbers.has(courseNumber)) {
      reportedNumbers.add(courseNumber);
      warnings.push({ kind: "unusual-course-number", courseNumber });
    }

    let offering = offerings.get(key);
    if (!offering) {
      offering = {
        courseNumber,
        nameHebrew: row.name,
        semesters: canonical(semesters),
        groups: [],
        credits: { known: false },
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
    if (!parsed) {
      warnings.push({ kind: "detail-key-unreadable", key });
      continue;
    }
    const offering = offerings.get(offeringKey(parsed.courseNumber, parsed.semesters));
    if (!offering) {
      // Normal when a details-only part arrives before its rows, but the student has to be
      // told, or the import reads as a success that recorded nothing.
      warnings.push({
        kind: "detail-without-offering",
        courseNumber: parsed.courseNumber,
        semesters: canonical(parsed.semesters),
      });
      continue;
    }

    const hours = parseWeeklyHours(detail.points);
    if (hours === undefined && detail.points !== undefined) {
      warnings.push({ kind: "weekly-hours-unreadable", courseNumber: parsed.courseNumber });
    } else if (hours !== undefined) {
      const sampled = parseSampledGroup(detail.code);
      const group = sampled && offering.groups.find((g) => g.number === sampled);
      if (group) group.weeklyHours = hours;
      else warnings.push({ kind: "detail-group-unknown", courseNumber: parsed.courseNumber });
    }

    // An absent Exam list means "not published for the Group this was read from", never
    // "this Offering has no Exam", so only a record that carries Exams settles the question.
    const { exams: sittings, unreadable } = parseExams(detail);
    if (unreadable) warnings.push({ kind: "exam-unreadable", courseNumber: parsed.courseNumber });
    if (sittings.length) offering.exams = { known: true, sittings };
  }

  for (const offering of offerings.values()) offering.credits = creditsOf(offering);

  const catalog: Catalog = {
    schemaVersion: CURRENT_CATALOG_SCHEMA_VERSION,
    academicYear: options.academicYear,
    sources,
    offerings: [...offerings.values()],
  };

  return { catalog, warnings, summary: summarise(catalog) };
}
