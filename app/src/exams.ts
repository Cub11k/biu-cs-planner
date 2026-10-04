import {
  checkExams,
  DEFAULT_VARIANT_NAME,
  variantAt,
  type ExamCheck,
  type ExamSource,
  type StateFileVersion,
  type StateFileWarning,
} from "@biu-cs-planner/core";
import { readStateFile, type EditRefusal } from "./edit.ts";
import { DEFAULT_STATE_FILE, type TimetableRef } from "./picks.ts";
import { listOfferings, type QueryWarning } from "./queries.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The exam period of one Semester's Variant: the sittings in date order, the Clashes among them
 * and the spacing Warnings — at the threshold **this student stored** (#164).
 *
 * `core`'s `checkExams` has taken a `spacingDays` threshold since it was written and nothing
 * passed one, so `docs/design.md`'s "adjustable in settings" was adjustable and settled nothing:
 * `examSpacingDays` was readable and writable (#115) and reached no check. This is the caller
 * that closes that, and it is the only one.
 *
 * **Why a use case of its own rather than part of `readTimetable`.** Picks carry a snapshot of
 * their Group's Meetings and nothing about Exams — an Exam belongs to the Offering and is shared
 * by all its Groups (CONTEXT.md) — so this answer needs the Catalog as well as the State File,
 * while a Pick needs neither. Folding it into `TimetableView` would put a Catalog read behind
 * every Pick and every undo, each of which answers with that same view, and would leave every
 * write route carrying Warnings about a file it never wrote to. The exam rail is its own panel on
 * the Timetable screen (`docs/design.md`, "Screens"), and this is its own read.
 *
 * Two lists of Warnings, because they are about two files and their `kind`s overlap: a
 * `file-unreadable` is a different piece of news depending on whether the State File or the
 * Catalog is the one that could not be read, and one merged list could not say which.
 */
export type ExamsResult =
  | {
      kind: "served";
      exams: ExamCheck;
      /**
       * The threshold the check above was given, which is the student's stored `examSpacingDays`.
       * It travels with the answer so that whatever draws the rail can say what "too close" means
       * here rather than repeating a default it would be free to get wrong.
       */
      spacingDays: number;
      /** The revision of the State File the Picks and the threshold were read from. */
      version: StateFileVersion | undefined;
      /** About the State File: the Picks and the preferences. */
      warnings: StateFileWarning[];
      /** About the Catalog the Exams came from, which is a different file. */
      catalogWarnings: QueryWarning[];
    }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

/**
 * The Courses the student has picked something for, each once and in the order they were picked.
 *
 * A Course needs one Pick per Lesson Type, so a lecture and a tirgul of one Course are two Picks
 * and one exam-bearing Offering. `checkExams` tolerates the same sitting arriving twice, but
 * `coursesWithUnknownExams` counts what it is handed, so a Course whose Exams are unknown would
 * otherwise be counted once per Lesson Type.
 */
const pickedCourses = (courseNumbers: readonly string[]): string[] => [...new Set(courseNumbers)];

/**
 * What the exam check is asked about: one entry per picked Course, carrying that Course's
 * sittings out of the Catalog.
 *
 * A Course the Catalog cannot answer for is handed in with `known: false` rather than left out,
 * and that one rule covers every way of not knowing: no Catalog imported for the year, a Catalog
 * the Workspace refused, a Course that is not in it, and an Offering whose Exams nobody has
 * published. Left out, those Courses would simply be missing from a rail that implied it was
 * complete; handed in this way they are what `coursesWithUnknownExams` counts, which is the
 * number the screen uses to admit the picture is partial.
 */
function sourcesFor(courseNumbers: readonly string[], offerings: readonly ExamSource[]): ExamSource[] {
  const known = new Map(offerings.map((offering) => [offering.courseNumber, offering]));
  return pickedCourses(courseNumbers).map(
    (courseNumber) =>
      known.get(courseNumber) ?? { courseNumber, exams: { known: false, sittings: [] } },
  );
}

/**
 * The exam period for one Variant of one Semester, checked at the student's own threshold.
 *
 * The threshold is the **stored** one and never a caller-supplied one: it is a preference, and a
 * caller that could override it would be a second opinion about a student's own setting. The
 * value is always there to pass — `settingsSchema` gives the field a non-null default — so
 * `checkExams`'s own default is not what this path relies on; that default stays for the callers
 * which have no State File to read, the generator among them (`core/src/timetable/exams.ts`).
 *
 * Refused only for the State File, as `readTimetable` is: the Picks and the threshold are in it,
 * so without it there is no question to answer. A Catalog that cannot be served is not a refusal —
 * it is an exam period nobody has published yet, which is a Warning and a partial rail.
 */
export async function readExams(workspace: Workspace, at: TimetableRef): Promise<ExamsResult> {
  const loaded = await readStateFile(workspace, at.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }

  const variant = variantAt(loaded.state, {
    academicYear: at.academicYear,
    semester: at.semester,
    variant: at.variant ?? DEFAULT_VARIANT_NAME,
  });
  const courseNumbers = (variant?.picks ?? []).map((pick) => pick.courseNumber);

  const catalog = await listOfferings(workspace, {
    academicYear: at.academicYear,
    semester: at.semester,
  });

  const spacingDays = loaded.state.settings.examSpacingDays;
  return {
    kind: "served",
    exams: checkExams(sourcesFor(courseNumbers, catalog.offerings ?? []), { spacingDays }),
    spacingDays,
    version: loaded.version,
    warnings: loaded.warnings,
    catalogWarnings: catalog.warnings,
  };
}
