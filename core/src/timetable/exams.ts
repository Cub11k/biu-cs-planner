import type { Exam } from "../catalog/schema.ts";

/**
 * Exams belong to the Offering and are shared by all its Groups, so this check reads
 * Offerings rather than Picks: one Course contributes its sittings once however many Lesson
 * Types the student picked. Everything here is arithmetic on three integers and a few
 * strings — no I/O, no wall clock, and no branch on what a `moed` happens to be called.
 */

/** The spacing the design settles on, and what a setting should default to. */
export const DEFAULT_EXAM_SPACING_DAYS = 3;

/**
 * The exam-bearing part of an Offering. A Catalog `Offering` satisfies it, and so does
 * anything else a caller can name a Course and its sittings from, which keeps this module
 * free of the schemas around it.
 */
export interface ExamSource {
  courseNumber: string;
  /** `known: false` means no part has published this Offering's Exams yet. */
  exams: { known: boolean; sittings: readonly Exam[] };
}

/** One sitting, told apart from every other by the Course it belongs to. */
export interface ExamSitting {
  courseNumber: string;
  moed: string;
  date: string;
  time: string;
}

/** A sitting as the exam rail draws it: in date order, carrying the gap behind it. */
export interface RailSitting extends ExamSitting {
  /** Calendar days since the sitting before it, and `undefined` for the first. */
  daysSincePrevious: number | undefined;
}

export type ExamWarning =
  | { kind: "exam-clash"; date: string; sittings: [ExamSitting, ExamSitting] }
  /**
   * One sitting with too little room around it. A Warning per sitting rather than per pair:
   * three Exams on three consecutive days is one crowded stretch, and what the student can
   * act on is "this one has two others close to it", which is also what the rail draws.
   */
  | { kind: "exam-spacing"; sitting: ExamSitting; nearbyCount: number; nearby: ExamSitting[] };

export interface ExamCheck {
  /** Every sitting in date order, so the rail can space its marks without re-deriving them. */
  sittings: RailSitting[];
  warnings: ExamWarning[];
  /**
   * How many Courses had no published Exams, so the screen can admit the picture is partial
   * rather than implying an empty exam period. Courses and not Offerings, because an
   * `ExamSource` names no Semester: within the one Semester a rail draws, a Course is an
   * Offering, and counting entries instead would count a Course once per picked Lesson Type.
   */
  coursesWithUnknownExams: number;
}

export interface ExamCheckOptions {
  /** Exams fewer than this many days apart are a spacing Warning. */
  spacingDays?: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * The calendar day a `YYYY-MM-DD` date names, counted in UTC. UTC midnights are exactly a
 * day apart, so no machine's timezone and no daylight-saving change can shift a gap: the
 * same two dates are the same number of days apart in Jerusalem as on Kiritimati.
 */
function utcDayNumber(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Date first, because that is the rail's axis; the rest are tie-breakers that only make the
 * order stable for equal dates. None of them treats any particular label specially.
 */
function byWhenThenWhose(a: ExamSitting, b: ExamSitting): number {
  return (
    compare(a.date, b.date) ||
    compare(a.time, b.time) ||
    compare(a.courseNumber, b.courseNumber) ||
    compare(a.moed, b.moed)
  );
}

function identity(sitting: ExamSitting): string {
  return `${sitting.courseNumber}|${sitting.moed}|${sitting.date}|${sitting.time}`;
}

/**
 * The sittings to check, each one once. A caller assembling this list from Picks holds one
 * Pick per Lesson Type, so the same Offering can arrive twice; the same sitting listed twice
 * is one Exam, not two, and a Course must never be reported as Clashing with itself. Two
 * Offerings of one Course whose Exams genuinely differ both survive, because the whole
 * sitting is the key and not the course number.
 */
function distinctSittings(offerings: readonly ExamSource[]): ExamSitting[] {
  const seen = new Map<string, ExamSitting>();
  for (const offering of offerings) {
    if (!offering.exams.known) continue;
    for (const exam of offering.exams.sittings) {
      const sitting: ExamSitting = {
        courseNumber: offering.courseNumber,
        moed: exam.moed,
        date: exam.date,
        time: exam.time,
      };
      const key = identity(sitting);
      if (!seen.has(key)) seen.set(key, sitting);
    }
  }
  return [...seen.values()].sort(byWhenThenWhose);
}

/** Courses nobody has published Exams for, counted once however often one is handed in. */
function countCoursesWithUnknownExams(offerings: readonly ExamSource[]): number {
  const courses = new Set<string>();
  for (const offering of offerings) {
    if (!offering.exams.known) courses.add(offering.courseNumber);
  }
  return courses.size;
}

/**
 * Finds the Exam Clashes and the sittings that sit uncomfortably close, and returns the exam
 * rail alongside them.
 *
 * A Clash is any two Exams on the same calendar day, whichever Moed each belongs to: the
 * student decides which sitting they intend to attend, and the app does not guess. Clashes
 * come one per pair, because a pair is what the student has to choose between.
 *
 * Spacing is counted the other way round: one Warning per sitting, naming how many other
 * sittings fall within `spacingDays` of it and which they are. A pair list grows as the
 * square of a crowded stretch and says the same thing three times over; a count per Exam says
 * the thing the student can act on. Same-day sittings are Clashes and are left out of the
 * count, so one problem still raises one Warning.
 *
 * The Clashes come first, then the spacing Warnings in rail order. Both are Warnings in the
 * glossary's sense: this reports, and rejects nothing.
 */
export function checkExams(
  offerings: readonly ExamSource[],
  options: ExamCheckOptions = {},
): ExamCheck {
  const spacingDays = options.spacingDays ?? DEFAULT_EXAM_SPACING_DAYS;
  const sittings = distinctSittings(offerings);
  const days = sittings.map((sitting) => utcDayNumber(sitting.date));

  const clashes: ExamWarning[] = [];
  /** Per sitting, the other sittings crowding it, filled in rail order. */
  const nearby: ExamSitting[][] = sittings.map(() => []);

  for (let first = 0; first < sittings.length; first++) {
    for (let second = first + 1; second < sittings.length; second++) {
      const a = sittings[first]!;
      const b = sittings[second]!;
      const gap = days[second]! - days[first]!;
      if (gap === 0) {
        clashes.push({ kind: "exam-clash", date: a.date, sittings: [a, b] });
      } else if (gap < spacingDays) {
        nearby[first]!.push(b);
        nearby[second]!.push(a);
      }
    }
  }

  const spacing: ExamWarning[] = [];
  for (const [index, sitting] of sittings.entries()) {
    const near = nearby[index]!;
    if (near.length === 0) continue;
    spacing.push({ kind: "exam-spacing", sitting, nearbyCount: near.length, nearby: near });
  }

  return {
    sittings: sittings.map((sitting, index) => ({
      ...sitting,
      daysSincePrevious: index === 0 ? undefined : days[index]! - days[index - 1]!,
    })),
    warnings: [...clashes, ...spacing],
    coursesWithUnknownExams: countCoursesWithUnknownExams(offerings),
  };
}
