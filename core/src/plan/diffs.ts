import type { Semester } from "../catalog/schema.ts";
import { addAttempt, moveAttempt, removeAttempt } from "../state/attempts.ts";
import { variantAt, type VariantRef } from "../state/picks.ts";
import type { Attempt, AttemptId, State } from "../state/schema.ts";

/**
 * Plan Diffs (#295; ADR-0008): where one Variant and the Plan disagree, each resolved only by an
 * explicit "apply to Plan".
 *
 * Nothing keeps the Plan and a Timetable alike on its own. A Variant is compared with the Plan's **planned**
 * Attempts in its Academic Year and Semester and with that year's Catalog, and every divergence is
 * reported as one of five kinds:
 *
 * - `add`: a Course in the Variant — added to its Tray or picked in it — that the Plan does not
 *   have in the Semester at all, nor planned in another Semester of the year, and that this year's
 *   Catalog, when there is one, gives in it;
 * - `move-here`: a Course in the Variant that the Plan has planned in one other Semester of the
 *   same Academic Year (#355). Applying it moves that Attempt here, where an `add` would have left
 *   the Course planned twice, and for a Year-long Course adds the other half it lacks. A Course
 *   planned in more than one other Semester — a Year-long unit seen from the summer, or a double
 *   the file already holds — gets no Plan Diff here, since moving one would split or keep it;
 * - `drop`: a planned Attempt of a Course that is not in the Variant;
 * - `move`: a planned Course this year's Catalog offers, but not in this Semester. When the
 *   Semester it would move to already holds the Course it is still reported, with `targetHolds`
 *   and nothing to apply, since moving it would put the Course there twice (#355);
 * - `not-offered`: a planned Course this year's Catalog does not have at all. Reported, with
 *   nothing to apply.
 *
 * **No apply plans a Course twice in one Academic Year** (#355): an `add` is never offered for a
 * Course planned elsewhere in the year, a `move-here` takes the Attempt rather than copying it, and
 * a `move` into a Semester that has the Course is not applicable. A Year-long Course is planned
 * once per half, which is its one unit, not two.
 *
 * **Only planned Attempts are diffed.** Registered, passed and the rest are history, and nothing
 * here ever moves or drops one; an Attempt of any status in the Semester does count as the Plan
 * having the Course, so a Course once registered is not offered to be added again. **No Plan, no
 * Plan Diffs**: a State File with no planned Attempt anywhere in the Academic Year gets none, so a
 * Timetable works exactly as it does without a Plan (ADR-0008).
 *
 * **Which Plan Diff applies to a planned Attempt is decided in that order**: not offered, then
 * move, then drop. A Course the Catalog does not have is not offered whether or not the Variant
 * holds it, and a Course it offers only in another Semester is a move rather than a drop, since
 * moving is what keeps it in the Plan. Without a Catalog — none for the year, or one that cannot be
 * read — neither of the first two can be told, and only `add` and `drop` are reported: "not in this
 * year's Catalog" said of every planned Course would be untrue of all of them.
 *
 * **Courses are compared through Equivalences** when the student's Requirements Files declare any,
 * so a renumbered Course is the same Course on both sides and not an `add` and a `drop`. Each Plan
 * Diff still names the course number as its side wrote it: the Variant's for an `add` and a
 * `move-here`, which are about a Course in the Variant, and the Attempt's for the rest.
 *
 * **A Year-long Course is one unit across Fall and Spring** (CONTEXT.md: two Attempts, a Fall half
 * and a Spring half of one Academic Year). Adding one adds every half the Plan lacks; dropping one
 * drops both planned halves, so neither half is left behind as a split the Plan checks would then
 * report. A planned half that some Variant of the other half's Timetable holds is never a drop:
 * the Course is scheduled, as the one unit it is, so a Spring week not built yet does not offer to
 * take away the Course the Fall week holds. Whether a Course is Year-long is the Catalog's to say when there is one — every Offering
 * of it given in the Variant's Semester spans Fall and Spring — and otherwise the Requirements
 * Files' Offering Pattern.
 *
 * **A Plan Diff is identified by its kind and its Course** within the Variant's Semester, which a
 * page can send back after a refresh and mean the same divergence (`PlanDiffKey`). It is computed
 * afresh on every read and never stored.
 */

/** What the comparison needs of an Offering. A Catalog Offering satisfies it. */
export type PlanDiffOffering = { courseNumber: string; semesters: readonly Semester[] };

/** An Equivalence as a Requirements File declares it: `from` counts as `to`. */
export type PlanDiffEquivalence = { from: string; to: string };

/** Everything besides the State that a Plan Diff is computed from. */
export type PlanDiffContext = {
  /**
   * Every Offering of the Variant's Academic Year — every Semester, not only the Variant's — or
   * `undefined` when there is no Catalog to ask.
   */
  offerings: readonly PlanDiffOffering[] | undefined;
  /** The Equivalences of the student's Requirements Files, if any. */
  equivalences?: readonly PlanDiffEquivalence[] | undefined;
  /**
   * Course numbers the Requirements Files give a Year-long Offering Pattern: what says a Course is
   * Year-long when there is no Catalog to say it.
   */
  yearLong?: readonly string[] | undefined;
};

export type PlanDiffKind = "add" | "move-here" | "drop" | "move" | "not-offered";

type PlanDiffAt = { courseNumber: string; academicYear: number; semester: Semester };

export type PlanDiff =
  /** The Course is in the Variant and not in the Plan; `semesters` are the Attempts to add. */
  | ({ kind: "add"; semesters: Semester[] } & PlanDiffAt)
  /**
   * The Course is in the Variant and planned in `from`, another Semester of the year: move it here.
   * For a Year-long Course, `alsoAdds` names the other half the Plan lacks, added in the same apply.
   */
  | ({ kind: "move-here"; from: Semester; attemptIds: AttemptId[]; alsoAdds?: Semester[] } & PlanDiffAt)
  /** The Plan's planned Attempts of a Course the Variant does not hold, both halves of a Year-long one. */
  | ({ kind: "drop"; attemptIds: AttemptId[] } & PlanDiffAt)
  /**
   * Planned here, offered this year only in `to`. `targetHolds` when `to` already has an Attempt
   * of the Course: then there is nothing to apply, because moving would plan it there twice.
   * `alsoAdds` is the other half of a Year-long Course moved into one half, added in the same apply.
   */
  | ({ kind: "move"; to: Semester; attemptIds: AttemptId[]; targetHolds?: true; alsoAdds?: Semester[] } & PlanDiffAt)
  /** Planned here, and not in this year's Catalog at all. Nothing to apply. */
  | ({ kind: "not-offered"; attemptIds: AttemptId[] } & PlanDiffAt);

/** What names one Plan Diff within a Variant's Semester: its kind and its Course. */
export type PlanDiffKey = { kind: PlanDiffKind; courseNumber: string };

const SEMESTERS: readonly Semester[] = ["fall", "spring", "summer"];
const HALVES: readonly Semester[] = ["fall", "spring"];

/**
 * The course number an Equivalence chain ends at. A chain that loops reads as its smallest member,
 * which is the answer the Requirement engine gives, so a loop the Requirements File reader already
 * reports cannot make one Course two here.
 */
export function canonicalizer(equivalences: readonly PlanDiffEquivalence[]): (courseNumber: string) => string {
  const next = new Map<string, string>();
  for (const { from, to } of equivalences) if (!next.has(from)) next.set(from, to);
  return (courseNumber) => {
    const visited: string[] = [];
    let current = courseNumber;
    while (next.has(current)) {
      if (visited.includes(current)) return [...visited.slice(visited.indexOf(current))].sort()[0]!;
      visited.push(current);
      current = next.get(current)!;
    }
    return current;
  };
}

/**
 * Whether a Plan Diff has an "apply to Plan": every kind but `not-offered`, and every `move` but one
 * whose target Semester already holds the Course.
 */
export const isActionable = (diff: PlanDiff): boolean =>
  diff.kind !== "not-offered" && !(diff.kind === "move" && diff.targetHolds === true);

/**
 * A digest of a list of Plan Diffs, equal for two lists exactly when they say the same thing: every
 * field of every Plan Diff, in order. What "apply all" carries back from the preview the student
 * read (#355), so that a list changed since — by a Catalog, which no State File revision covers —
 * is refused rather than applied unseen.
 *
 * A canonical rendering rather than a hash, so two different lists can never share a digest. Each
 * Plan Diff is written as an array in a fixed field order, so nothing depends on the order its
 * object's keys were made in.
 */
export function planDiffsDigest(diffs: readonly PlanDiff[]): string {
  return JSON.stringify(
    diffs.map((diff) => {
      const head = [diff.kind, diff.courseNumber, diff.academicYear, diff.semester];
      switch (diff.kind) {
        case "add":
          return [...head, diff.semesters];
        case "move-here":
          return [...head, diff.from, diff.attemptIds, diff.alsoAdds ?? []];
        case "move":
          return [...head, diff.to, diff.attemptIds, diff.targetHolds === true, diff.alsoAdds ?? []];
        case "drop":
        case "not-offered":
          return [...head, diff.attemptIds];
      }
    }),
  );
}

/** The Plan Diffs between the Variant `at` names and the Plan, in the order they are listed. */
export function planDiffs(state: State, at: VariantRef, context: PlanDiffContext): PlanDiff[] {
  const { academicYear, semester } = at;
  const inYear = state.attempts.filter((attempt) => attempt.academicYear === academicYear);
  if (!inYear.some((attempt) => attempt.status === "planned")) return [];

  const canonical = canonicalizer(context.equivalences ?? []);
  const of = (attempt: Attempt): string => canonical(attempt.courseNumber);

  /** The Semesters this year's Catalog offers each Course in, or none without a Catalog. */
  const offered =
    context.offerings === undefined
      ? undefined
      : context.offerings.reduce((map, offering) => {
          const course = canonical(offering.courseNumber);
          map.set(course, [...(map.get(course) ?? []), ...offering.semesters]);
          return map;
        }, new Map<string, Semester[]>());

  const yearLongByPattern = new Set((context.yearLong ?? []).map(canonical));
  /** Whether the Course is Year-long as given in `where` — the Variant's Semester unless a `move` asks about its target. */
  const isYearLong = (course: string, where: Semester = semester): boolean => {
    if (where === "summer") return false;
    if (context.offerings === undefined) return yearLongByPattern.has(course);
    const here = context.offerings.filter(
      (offering) => canonical(offering.courseNumber) === course && offering.semesters.includes(where),
    );
    return here.length > 0 && here.every((offering) => HALVES.every((half) => offering.semesters.includes(half)));
  };

  /** The Courses in the Variant, as the Variant spells each first: added, then picked. */
  const variant = variantAt(state, at);
  const scheduled = new Map<string, string>();
  for (const courseNumber of [...(variant?.tray ?? []), ...(variant?.picks.map((pick) => pick.courseNumber) ?? [])]) {
    const course = canonical(courseNumber);
    if (!scheduled.has(course)) scheduled.set(course, courseNumber);
  }

  /** Whether any Variant of the other half's Timetable, this Academic Year, holds the Course. */
  const heldInOtherHalf = (course: string): boolean =>
    state.timetables.some(
      (timetable) =>
        timetable.academicYear === academicYear &&
        timetable.semester !== semester &&
        HALVES.includes(timetable.semester) &&
        timetable.variants.some((other) =>
          [...other.tray, ...other.picks.map((pick) => pick.courseNumber)].some((held) => canonical(held) === course),
        ),
    );

  const diffs: PlanDiff[] = [];

  const plannedHere = inYear.filter((attempt) => attempt.status === "planned" && attempt.semester === semester);
  const plannedCourses = [...new Set(plannedHere.map(of))];
  for (const course of plannedCourses) {
    const attempts = plannedHere.filter((attempt) => of(attempt) === course);
    const where = { courseNumber: attempts[0]!.courseNumber, academicYear, semester };
    const attemptIds = attempts.map((attempt) => attempt.id);

    const semesters = offered?.get(course);
    // an Offering listing no Semester is given in none, which is what not offered means
    if (offered !== undefined && (semesters === undefined || semesters.length === 0)) {
      diffs.push({ kind: "not-offered", ...where, attemptIds });
      continue;
    }
    if (semesters !== undefined && !semesters.includes(semester)) {
      const to = SEMESTERS.find((other) => other !== semester && semesters.includes(other))!;
      // the Semester it would go to has the Course already: moving would plan it there twice
      const targetHolds = inYear.some((attempt) => attempt.semester === to && of(attempt) === course);
      // moved into one half of a Year-long Course, it brings the other half the Plan lacks
      const alsoAdds = isYearLong(course, to)
        ? HALVES.filter((half) => half !== to && !inYear.some((attempt) => attempt.semester === half && of(attempt) === course))
        : [];
      diffs.push({
        kind: "move",
        ...where,
        to,
        attemptIds,
        ...(targetHolds ? { targetHolds: true as const } : {}),
        ...(alsoAdds.length > 0 && !targetHolds ? { alsoAdds } : {}),
      });
      continue;
    }
    if (scheduled.has(course)) continue;
    // A Year-long Course a Variant of its other half holds is scheduled, as one unit: the half
    // here is not missing, and dropping both would take the half the other Timetable holds.
    if (isYearLong(course) && heldInOtherHalf(course)) continue;

    const otherHalf = isYearLong(course)
      ? inYear.filter(
          (attempt) =>
            attempt.status === "planned" &&
            attempt.semester !== semester &&
            HALVES.includes(attempt.semester) &&
            of(attempt) === course,
        )
      : [];
    diffs.push({ kind: "drop", ...where, attemptIds: [...attemptIds, ...otherHalf.map((attempt) => attempt.id)] });
  }

  for (const [course, courseNumber] of scheduled) {
    const held = (where: Semester): boolean =>
      inYear.some((attempt) => attempt.semester === where && of(attempt) === course);
    if (held(semester)) continue;
    // a Course the Catalog does not give in this Semester is not added to it: the next read would
    // offer to move it straight back out, or call it not offered
    if (offered !== undefined && !(offered.get(course) ?? []).includes(semester)) continue;
    const yearLong = isYearLong(course);
    // Planned in another Semester of the year — and not as the other half of a Year-long Course,
    // which is the same unit — so it is moved here rather than planned a second time (#355).
    const elsewhere = inYear.filter(
      (attempt) =>
        attempt.status === "planned" &&
        attempt.semester !== semester &&
        !(yearLong && HALVES.includes(attempt.semester)) &&
        of(attempt) === course,
    );
    if (elsewhere.length > 0) {
      // Planned in more than one other Semester: a Year-long unit seen from the summer, or a Course
      // the file already plans twice. Moving one of them would split the unit or keep the double,
      // so there is nothing to apply here (review of #358).
      const from = elsewhere[0]!.semester;
      if (elsewhere.some((attempt) => attempt.semester !== from)) continue;
      const attemptIds = elsewhere.map((attempt) => attempt.id);
      // a Year-long Course moved into one half brings the other half it lacks, so it stays one unit
      const alsoAdds = yearLong ? HALVES.filter((half) => half !== semester && !held(half)) : [];
      diffs.push({
        kind: "move-here",
        courseNumber,
        academicYear,
        semester,
        from,
        attemptIds,
        ...(alsoAdds.length > 0 ? { alsoAdds } : {}),
      });
      continue;
    }
    const semesters = yearLong ? HALVES.filter((half) => !held(half)) : [semester];
    diffs.push({ kind: "add", courseNumber, academicYear, semester, semesters });
  }

  return diffs;
}

/** Moves a Plan Diff's Attempts to `to`, then plans the Year-long half it says the Plan lacks. */
function moveThenAdd(
  state: State,
  diff: { courseNumber: string; academicYear: number; attemptIds: AttemptId[]; alsoAdds?: Semester[] | undefined },
  to: Semester,
  newId: () => AttemptId,
): State {
  const moved = diff.attemptIds.reduce(
    (next, id) => moveAttempt(next, id, { academicYear: diff.academicYear, semester: to }),
    state,
  );
  return (diff.alsoAdds ?? []).reduce(
    (next, semester) =>
      addAttempt(next, { courseNumber: diff.courseNumber, academicYear: diff.academicYear, semester, status: "planned" }, newId),
    moved,
  );
}

/** The Plan Diff a key names among `diffs`, or `undefined` when there is none like it any more. */
export function findPlanDiff(diffs: readonly PlanDiff[], key: PlanDiffKey): PlanDiff | undefined {
  return diffs.find((diff) => diff.kind === key.kind && diff.courseNumber === key.courseNumber);
}

/**
 * Applies one Plan Diff to the Plan — and to nothing else: no Variant, Pick, Tray or Blocked Time
 * is touched, because an apply never edits the Timetable (ADR-0008). An `add` makes planned
 * Attempts, named by `newId`; a `drop` removes the Attempts it names; a `move` moves them to its
 * Semester, and a `move-here` into the Variant's. A `not-offered`, or a `move` whose target holds
 * the Course, has nothing to apply, and the same State comes back.
 */
export function applyPlanDiff(state: State, diff: PlanDiff, newId: () => AttemptId): State {
  switch (diff.kind) {
    case "add":
      return diff.semesters.reduce(
        (next, semester) =>
          addAttempt(
            next,
            { courseNumber: diff.courseNumber, academicYear: diff.academicYear, semester, status: "planned" },
            newId,
          ),
        state,
      );
    case "drop":
      return diff.attemptIds.reduce(removeAttempt, state);
    case "move":
      if (diff.targetHolds === true) return state;
      return moveThenAdd(state, diff, diff.to, newId);
    case "move-here":
      return moveThenAdd(state, diff, diff.semester, newId);
    case "not-offered":
      return state;
  }
}
