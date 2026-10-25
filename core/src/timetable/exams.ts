import type { Exam } from "../catalog/schema.ts";

/**
 * Exams belong to the Offering and are shared by all its Groups, so this check reads
 * Offerings rather than Picks: one Course contributes its sittings once however many Lesson
 * Types the student picked. Everything here is arithmetic on three integers and a few
 * strings — no I/O, no wall clock, and no branch on what a `moed` happens to be called.
 */

/**
 * The spacing the design settles on, and what the setting defaults to: `settingsSchema`'s
 * `examSpacingDays` takes its default from here (`../state/schema.ts`), so a State File that
 * says nothing about Exam spacing and a call below that is given no threshold cannot come to
 * mean two different numbers (#164).
 */
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
  /**
   * The Semesters the Offering is given in, as a Catalog `Offering` names them. Two or more is a
   * Year-long Offering, whose sittings carry no Semester of their own (#214); absent is one
   * Semester, which is what a caller with no Catalog at hand is asking about.
   */
  semesters?: readonly string[];
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
  /**
   * Calendar days since the Semester's sitting before it, and `undefined` for the first — and for
   * every Year-long one, which is not on the Semester's axis at all.
   */
  daysSincePrevious: number | undefined;
  /**
   * A sitting of a Year-long Offering (#214, the maintainer's stopgap of 2026-10-04). A Catalog
   * `Exam` records no Semester and nothing in the Raw Crawl could supply one
   * (`docs/research/shoham-raw-shape.md`, "A sitting carries no Semester"), so such a sitting may
   * be either Semester's. It is listed as Year-long with no Semester recorded, never spaced
   * against the Semester's own sittings, and **left out of the spacing check**, which would
   * otherwise measure gaps across the boundary between two exam periods. It still Clashes: two
   * Exams on one calendar day are in one Semester whichever it is.
   */
  yearLong: boolean;
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
  /**
   * Exams fewer than this many days apart are a spacing Warning. `0` raises none at all, which
   * is a student turning the Warning off: a gap of zero days is a Clash and is reported as one.
   *
   * **Still optional, and the default still reachable** (#164). The app passes the student's
   * stored threshold on every call it makes — `app/src/exams.ts`, and `settingsSchema` gives the
   * field a non-null default, so that path never omits it. This stays optional because the
   * generator ranks combinations by Exam spacing before any State File is involved
   * (`docs/design.md`, "Generator"), and because a pure function in `core` may not require its
   * caller to have read a file. A caller that omits it asks for the design's spacing, which is
   * the same constant the setting defaults to.
   */
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
function distinctSittings(offerings: readonly ExamSource[]): Array<ExamSitting & { yearLong: boolean }> {
  const seen = new Map<string, ExamSitting & { yearLong: boolean }>();
  for (const offering of offerings) {
    if (!offering.exams.known) continue;
    const yearLong = (offering.semesters?.length ?? 0) > 1;
    for (const exam of offering.exams.sittings) {
      const sitting = {
        courseNumber: offering.courseNumber,
        moed: exam.moed,
        date: exam.date,
        time: exam.time,
        yearLong,
      };
      const key = identity(sitting);
      if (!seen.has(key)) seen.set(key, sitting);
    }
  }
  return [...seen.values()].sort(byWhenThenWhose);
}

/** A sitting as a Warning names it: who and when, without the rail's own fields. */
const plain = ({ courseNumber, moed, date, time }: ExamSitting): ExamSitting => ({ courseNumber, moed, date, time });

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
        clashes.push({ kind: "exam-clash", date: a.date, sittings: [plain(a), plain(b)] });
      } else if (gap < spacingDays && !a.yearLong && !b.yearLong) {
        nearby[first]!.push(plain(b));
        nearby[second]!.push(plain(a));
      }
    }
  }

  const spacing: ExamWarning[] = [];
  for (const [index, sitting] of sittings.entries()) {
    const near = nearby[index]!;
    if (near.length === 0) continue;
    spacing.push({ kind: "exam-spacing", sitting: plain(sitting), nearbyCount: near.length, nearby: near });
  }

  /** The day of the Semester's sitting before, which a Year-long sitting never is. */
  let previous: number | undefined;
  return {
    sittings: sittings.map((sitting, index) => {
      if (sitting.yearLong) return { ...sitting, daysSincePrevious: undefined };
      const since = previous === undefined ? undefined : days[index]! - previous;
      previous = days[index]!;
      return { ...sitting, daysSincePrevious: since };
    }),
    warnings: [...clashes, ...spacing],
    coursesWithUnknownExams: countCoursesWithUnknownExams(offerings),
  };
}
