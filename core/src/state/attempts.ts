import type { Attempt, AttemptFacts, AttemptId, Grade, State, Status, StudentCohort } from "./schema.ts";
import { semesterIndex, type SemesterAt } from "./semester-order.ts";

/**
 * The Attempt edits (#290): add, update (status and grade), move (Academic Year and Semester),
 * and remove. The Plan is nothing but these Attempts (ADR-0009), so these four are what makes it
 * editable at all.
 *
 * Each is a plain `state -> state` function handed to the guarded writer with its own label, so
 * each is one undo step (ADR-0013), and each hands back the State it was given when nothing moves,
 * which `editStateFile` reads as "nothing to save".
 *
 * **An Attempt is addressed by its id** (`attemptSchema`), never by its position or its Course:
 * a retake makes course number plus Semester non-unique, and a position moves with every add and
 * remove. An id nothing holds — only a client that never read the file could send one, since an
 * edit made on an older read is refused (#90) — changes nothing.
 *
 * **Ids come from an injected source**, so this module stays pure and a test can say which id an
 * add hands out. The app's source is a UUID.
 *
 * Nothing here refuses anything. A duplicate, a grade out of range, a grade on a planned Attempt
 * and an Attempt before the Cohort are each stored as entered and named by `attemptWarnings`.
 */

/** A change to an Attempt's result: a field left out is left alone, and `grade: null` clears it. */
export type AttemptChange = { status?: Status | undefined; grade?: Grade | null | undefined };

/** Which Attempt a Warning is about. */
export type AttemptTarget = { kind: "attempt"; id: AttemptId };

export type AttemptWarning =
  /** A second Attempt of one Course in one Semester; `firstId` is the one before it. */
  | {
      kind: "attempt-duplicate";
      target: AttemptTarget;
      courseNumber: string;
      academicYear: number;
      semester: Attempt["semester"];
      firstId: AttemptId;
    }
  /** A numeric grade below 0 or above 100. */
  | { kind: "grade-out-of-range"; target: AttemptTarget; value: number }
  /** A grade on an Attempt that has no result yet: planned or registered. */
  | { kind: "grade-not-completed"; target: AttemptTarget; status: Status }
  /** An Attempt in a Semester before the student's Cohort started. */
  | { kind: "attempt-before-cohort"; target: AttemptTarget; cohort: StudentCohort };

/** Adds an Attempt, named by the next id `newId` gives. A retake is just another add. */
export function addAttempt(state: State, fields: AttemptFacts, newId: () => AttemptId): State {
  const { courseNumber, academicYear, semester, status, grade } = fields;
  const attempt: Attempt = {
    id: newId(),
    courseNumber,
    academicYear,
    semester,
    status,
    ...(grade === undefined ? {} : { grade: { ...grade } }),
  };
  return { ...state, attempts: [...state.attempts, attempt] };
}

/** The State with the Attempt `id` names replaced by `edit`'s answer, or itself when none moved. */
function editing(state: State, id: AttemptId, edit: (attempt: Attempt) => Attempt): State {
  let moved = false;
  const attempts = state.attempts.map((attempt) => {
    if (attempt.id !== id) return attempt;
    const next = edit(attempt);
    if (next !== attempt) moved = true;
    return next;
  });
  return moved ? { ...state, attempts } : state;
}

const sameGrade = (a: Grade | undefined, b: Grade | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Changes an Attempt's status, its grade, or both: planned to registered, then passed or failed. */
export function updateAttempt(state: State, id: AttemptId, change: AttemptChange): State {
  return editing(state, id, (attempt) => {
    const status = change.status ?? attempt.status;
    const grade = change.grade === undefined ? attempt.grade : (change.grade ?? undefined);
    if (status === attempt.status && sameGrade(grade, attempt.grade)) return attempt;
    const { grade: _old, ...rest } = attempt;
    return { ...rest, status, ...(grade === undefined ? {} : { grade: { ...grade } }) };
  });
}

/** Moves an Attempt to another Semester, of the same Academic Year or another. */
export function moveAttempt(state: State, id: AttemptId, to: SemesterAt): State {
  return editing(state, id, (attempt) =>
    attempt.academicYear === to.academicYear && attempt.semester === to.semester
      ? attempt
      : { ...attempt, academicYear: to.academicYear, semester: to.semester },
  );
}

/** Removes an Attempt. Another Attempt of the same Course, a retake or the try before it, stays. */
export function removeAttempt(state: State, id: AttemptId): State {
  const attempts = state.attempts.filter((attempt) => attempt.id !== id);
  return attempts.length === state.attempts.length ? state : { ...state, attempts };
}

const PENDING: ReadonlySet<Status> = new Set(["planned", "registered"]);
/** Statuses that record something done elsewhere or waived, which may well predate the Cohort. */
const FROM_ELSEWHERE: ReadonlySet<Status> = new Set(["exempt", "credited"]);

/**
 * The Warnings over the Attempts that need no Requirements File, in the order the Attempts are
 * listed. Each points at the Attempt it is about. The Requirements-based Plan checks are
 * `checkPlan` (`../plan/checks.ts`).
 *
 * "Before the Cohort" skips exempt and credited Attempts: an exemption or a transferred Course is
 * exactly the record that can come from before the student started.
 */
export function attemptWarnings(state: State): AttemptWarning[] {
  const warnings: AttemptWarning[] = [];
  const firstIn = new Map<string, AttemptId>();
  const cohort = state.cohort;

  for (const attempt of state.attempts) {
    const target: AttemptTarget = { kind: "attempt", id: attempt.id };
    const slot = `${attempt.courseNumber}\u0000${attempt.academicYear}\u0000${attempt.semester}`;
    const first = firstIn.get(slot);
    if (first === undefined) firstIn.set(slot, attempt.id);
    else {
      warnings.push({
        kind: "attempt-duplicate",
        target,
        courseNumber: attempt.courseNumber,
        academicYear: attempt.academicYear,
        semester: attempt.semester,
        firstId: first,
      });
    }

    const grade = attempt.grade;
    if (grade?.kind === "numeric" && (grade.value < 0 || grade.value > 100)) {
      warnings.push({ kind: "grade-out-of-range", target, value: grade.value });
    }
    if (grade !== undefined && PENDING.has(attempt.status)) {
      warnings.push({ kind: "grade-not-completed", target, status: attempt.status });
    }
    if (
      cohort !== undefined &&
      !FROM_ELSEWHERE.has(attempt.status) &&
      semesterIndex(attempt) < semesterIndex(cohort)
    ) {
      warnings.push({ kind: "attempt-before-cohort", target, cohort });
    }
  }
  return warnings;
}
