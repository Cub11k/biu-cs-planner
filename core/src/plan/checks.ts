import { evaluateProgress, type EvaluatedRequirement } from "../requirements/evaluate.ts";
import { compileProgram, countingAttempts, type CompiledProgram } from "../requirements/program.ts";
import type { LocalizedText, OfferingPattern, Prerequisite, RequirementsFile } from "../requirements/schema.ts";
import { solveAssignment, type SolveLimits, type SolvePin } from "../requirements/solve.ts";
import type { AttemptTarget } from "../state/attempts.ts";
import type { Attempt, AttemptId, StudentCohort } from "../state/schema.ts";
import { semesterIndex, studyPointAt, type SemesterAt } from "../state/semester-order.ts";
import { creditsOverCompiled } from "./credits.ts";

/**
 * The Plan checks (#291): a student's Attempts checked against their Programs' Requirements Files,
 * as the six Warnings `docs/design.md` lists under "Plan" — Prerequisite order, the Offering
 * Pattern, a Year-long Course split across years, credit load per Semester, missing Requirements,
 * and progression deadlines.
 *
 * **Every one is a Warning and none refuses anything** (CLAUDE.md). **None reads a Catalog**
 * (ADR-0008): future years have none, so credits and Offering Patterns come from the Requirements
 * File, and the Offering Pattern stands in for the Catalog's Semesters.
 *
 * **Which Attempts are checked.** Prerequisite order, the Offering Pattern and the Year-long split
 * are about what the student *plans*, so they look at planned and registered Attempts: a Course
 * already passed in a Semester was evidently given then, and history cannot be re-planned. Credit
 * load looks at every Semester that holds a planned or registered Attempt. Missing Requirements and
 * deadlines look at the whole Plan.
 *
 * **"Will have passed".** For planning, a planned or registered Attempt counts as passed by the end
 * of its Semester, and a Warning that relied on one names it in `reliesOn`, so the screen can say
 * "assuming you pass 89-110". A failed Attempt never counts, and a passed one counts only when it
 * is a pass under the file's passing grade.
 *
 * **Double majors.** The checks that read a Requirements File run once per Program and name the
 * file in each Warning; credit load is about the student's Semesters rather than a Program, and
 * reads a Course's credits from the first Program whose file gives them.
 */

/** A Semester a Warning is about: credit load, a deadline. */
export type SemesterTarget = { kind: "semester" } & SemesterAt;

/** A Program a summary Warning is about, by its Requirements File's name. */
export type ProgramTarget = { kind: "program"; requirementsFile: string };

export type PlanTarget = AttemptTarget | SemesterTarget | ProgramTarget;

export type PlanWarning =
  /**
   * An Attempt planned before its Prerequisite: `missing` are the course numbers not passed in
   * time, as the file spells them after its Equivalences.
   */
  | {
      kind: "prerequisite-unmet";
      target: AttemptTarget;
      requirementsFile: string;
      courseNumber: string;
      missing: string[];
      reliesOn: AttemptId[];
    }
  /** A Prerequisite passed in time, but with a grade below the minimum it demands, by the file's policy. */
  | {
      kind: "prerequisite-grade-below";
      target: AttemptTarget;
      requirementsFile: string;
      courseNumber: string;
      prerequisite: string;
      minGrade: number;
      grade: number;
      reliesOn: AttemptId[];
    }
  /** A Manual Prerequisite ("with lecturer approval"): a reminder, never checked. */
  | {
      kind: "prerequisite-manual";
      target: AttemptTarget;
      requirementsFile: string;
      courseNumber: string;
      text: LocalizedText;
    }
  /** An Attempt in a Semester its Offering Pattern says the Course is not given in. */
  | {
      kind: "offering-pattern";
      target: AttemptTarget;
      requirementsFile: string;
      courseNumber: string;
      pattern: OfferingPattern;
    }
  /** One half of a Year-long Course in an Academic Year whose other half is in another. */
  | {
      kind: "year-long-split";
      target: AttemptTarget;
      requirementsFile: string;
      courseNumber: string;
      otherHalf: AttemptId[];
    }
  /** A Semester carrying more credits than the student's limit. */
  | { kind: "credit-load"; target: SemesterTarget; credits: number; limit: number }
  /**
   * The Requirements the Plan, completed as planned, still leaves unmet: each unmet `nOf` and
   * leaf, read off the Progress evaluation's projected lens. One summary per Program.
   */
  | { kind: "requirements-missing"; target: ProgramTarget; requirementIds: string[] }
  /** Courses a progression deadline says must be passed by the end of `target`'s Semester. */
  | {
      kind: "deadline-missed";
      target: SemesterTarget;
      requirementsFile: string;
      name?: LocalizedText;
      missing: string[];
      reliesOn: AttemptId[];
    };

/** One Program the Plan is checked against. */
export interface PlanProgram {
  /** The Requirements File's name in the Workspace, which each Warning names the Program by. */
  requirementsFile: string;
  file: RequirementsFile;
  track?: string;
  /** Ids of this Program's Manual Requirements the student has ticked. */
  ticked?: readonly string[];
}

export interface PlanCheckInput {
  attempts: readonly Attempt[];
  /** The student's Programs, in their order. None chosen: only the checks needing none run, which is none. */
  programs: readonly PlanProgram[];
  cohort?: StudentCohort;
  /** The State File's `creditLoadLimit`: the stored value, never a default standing in for it. */
  creditLoadLimit: number;
  /** Pins, as the solver takes them, for the missing-Requirements lens. */
  pins?: readonly SolvePin[];
  /** The solver's limits for that lens. `core` reads no clock; pass `now` for a time cap. */
  limits?: SolveLimits;
}

const PENDING = new Set<Attempt["status"]>(["planned", "registered"]);
const isPending = (attempt: Attempt): boolean => PENDING.has(attempt.status);

/** What one Prerequisite adds up to for an Attempt in one Semester. */
interface Outcome {
  met: boolean;
  missing: string[];
  below: { course: string; minGrade: number; grade: number }[];
  reliesOn: AttemptId[];
  manual: LocalizedText[];
}

const metOutcome = (): Outcome => ({ met: true, missing: [], below: [], reliesOn: [], manual: [] });

/** Everything one Program needs to answer questions about the student's Attempts. */
interface Reading {
  program: CompiledProgram;
  requirementsFile: string;
  byCourse: Map<string, Attempt[]>;
}

function readingOf(entry: PlanProgram, attempts: readonly Attempt[]): Reading {
  const program = compileProgram(entry.file, entry.track);
  const byCourse = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const course = program.canonical(attempt.courseNumber);
    byCourse.set(course, [...(byCourse.get(course) ?? []), attempt]);
  }
  return { program, requirementsFile: entry.requirementsFile, byCourse };
}

/**
 * Whether a Course will have been passed by the time `by` allows: the Attempts of the Course in
 * Semesters `inTime` accepts. A passing Attempt settles it; failing that, a planned or registered
 * one is relied on. `minGrade` is held to the grade the file's `gradeAttempt` policy counts
 * (`countingAttempts`): an exempt, credited, pass/fail or ungraded pass has no number to fall short.
 */
function passedInTime(
  reading: Reading,
  courseNumber: string,
  inTime: (attempt: Attempt) => boolean,
  minGrade: number | undefined,
): Outcome {
  const course = reading.program.canonical(courseNumber);
  const candidates = (reading.byCourse.get(course) ?? []).filter(inTime);
  const counted = countingAttempts(candidates, reading.program.file.policies);
  const meets = (attempt: Attempt) =>
    minGrade === undefined || attempt.grade?.kind !== "numeric" || attempt.grade.value >= minGrade;
  if (counted.some(meets)) return metOutcome();

  const pending = candidates.filter(isPending);
  if (pending.length > 0) return { ...metOutcome(), reliesOn: pending.map((a) => a.id) };

  if (counted.length > 0 && minGrade !== undefined) {
    const grade = Math.max(...counted.map((a) => (a.grade?.kind === "numeric" ? a.grade.value : -Infinity)));
    return { met: false, missing: [], below: [{ course, minGrade, grade }], reliesOn: [], manual: [] };
  }
  return { met: false, missing: [course], below: [], reliesOn: [], manual: [] };
}

function allOf(outcomes: Outcome[]): Outcome {
  return {
    met: outcomes.every((o) => o.met),
    missing: outcomes.flatMap((o) => (o.met ? [] : o.missing)),
    below: outcomes.flatMap((o) => (o.met ? [] : o.below)),
    reliesOn: outcomes.flatMap((o) => o.reliesOn),
    manual: outcomes.flatMap((o) => o.manual),
  };
}

/**
 * Any one child will do. The one chosen to report is the best met one: met outright before met by
 * relying on the Plan, and both before met only through a Manual Prerequisite, so "89-110 or
 * lecturer approval" reminds about approval only when 89-110 is not there.
 */
function anyOf(outcomes: Outcome[]): Outcome {
  if (outcomes.length === 0) return metOutcome();
  const met = outcomes
    .filter((o) => o.met)
    .sort((a, b) => a.manual.length - b.manual.length || a.reliesOn.length - b.reliesOn.length);
  if (met.length > 0) return met[0]!;
  return { ...allOf(outcomes), met: false };
}

function prerequisiteOutcome(reading: Reading, prerequisite: Prerequisite, at: number): Outcome {
  const before = (attempt: Attempt) => semesterIndex(attempt) < at;
  const byThen = (attempt: Attempt) => semesterIndex(attempt) <= at;
  switch (prerequisite.kind) {
    case "passed":
      return passedInTime(
        reading,
        prerequisite.course,
        prerequisite.allowConcurrent === true ? byThen : before,
        prerequisite.minGrade,
      );
    case "set": {
      const set = reading.program.file.courseSets.find((s) => s.id === prerequisite.set);
      const inTime = prerequisite.allowConcurrent === true ? byThen : before;
      return allOf((set?.courses ?? []).map((course) => passedInTime(reading, course, inTime, undefined)));
    }
    case "manual":
      return { ...metOutcome(), manual: [prerequisite.text] };
    case "allOf":
      return allOf(prerequisite.of.map((child) => prerequisiteOutcome(reading, child, at)));
    case "anyOf":
      return anyOf(prerequisite.of.map((child) => prerequisiteOutcome(reading, child, at)));
  }
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

function prerequisiteWarnings(reading: Reading, attempts: readonly Attempt[]): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const { requirementsFile, program } = reading;
  const table = new Map(program.file.courses.map((c) => [program.canonical(c.number), c]));
  for (const attempt of attempts.filter(isPending)) {
    const entry = table.get(program.canonical(attempt.courseNumber));
    if (entry?.prerequisites === undefined) continue;
    const outcome = prerequisiteOutcome(reading, entry.prerequisites, semesterIndex(attempt));
    const target: AttemptTarget = { kind: "attempt", id: attempt.id };
    const courseNumber = attempt.courseNumber;
    const reliesOn = unique(outcome.reliesOn);
    if (!outcome.met) {
      if (outcome.missing.length > 0) {
        warnings.push({
          kind: "prerequisite-unmet",
          target,
          requirementsFile,
          courseNumber,
          missing: unique(outcome.missing),
          reliesOn,
        });
      }
      for (const below of outcome.below) {
        warnings.push({
          kind: "prerequisite-grade-below",
          target,
          requirementsFile,
          courseNumber,
          prerequisite: below.course,
          minGrade: below.minGrade,
          grade: below.grade,
          reliesOn,
        });
      }
    }
    for (const text of outcome.manual) {
      warnings.push({ kind: "prerequisite-manual", target, requirementsFile, courseNumber, text });
    }
  }
  return warnings;
}

/** Fall and Spring Courses planned in another Semester, and a Year-long one planned in Summer. */
function offeringWarnings(reading: Reading, attempts: readonly Attempt[]): PlanWarning[] {
  const { program, requirementsFile } = reading;
  const patterns = new Map(program.file.courses.map((c) => [program.canonical(c.number), c.offeringPattern]));
  const warnings: PlanWarning[] = [];
  for (const attempt of attempts.filter(isPending)) {
    const pattern = patterns.get(program.canonical(attempt.courseNumber));
    if (pattern === undefined) continue;
    const given = pattern === "year-long" ? attempt.semester !== "summer" : attempt.semester === pattern;
    if (!given) {
      warnings.push({
        kind: "offering-pattern",
        target: { kind: "attempt", id: attempt.id },
        requirementsFile,
        courseNumber: attempt.courseNumber,
        pattern,
      });
    }
  }
  return warnings;
}

/**
 * A Year-long Course is taken as a Fall half and a Spring half of one Academic Year. A year holding
 * only one half, while another year holds only the other, is a split; each planned or registered
 * lone half is named, with the lone halves of the other kind it was split from.
 */
function yearLongWarnings(reading: Reading): PlanWarning[] {
  const { program, requirementsFile } = reading;
  const warnings: PlanWarning[] = [];
  for (const entry of program.file.courses) {
    if (entry.offeringPattern !== "year-long") continue;
    const halves = (reading.byCourse.get(program.canonical(entry.number)) ?? []).filter(
      (a) => a.semester !== "summer",
    );
    const years = new Map<number, Set<string>>();
    for (const a of halves) years.set(a.academicYear, (years.get(a.academicYear) ?? new Set()).add(a.semester));
    const lone = halves.filter((a) => years.get(a.academicYear)!.size === 1);
    for (const attempt of lone.filter(isPending)) {
      const otherHalf = lone.filter((a) => a.semester !== attempt.semester).map((a) => a.id);
      if (otherHalf.length === 0) continue;
      warnings.push({
        kind: "year-long-split",
        target: { kind: "attempt", id: attempt.id },
        requirementsFile,
        courseNumber: attempt.courseNumber,
        otherHalf,
      });
    }
  }
  return warnings;
}

/**
 * A Semester carrying more credits than the limit, by the totals `./credits.ts` computes — the
 * same totals the Plan screen's columns show (#352), so a column and its Warning agree. Only a
 * Semester holding a planned or registered Attempt is reported: the others are history, and there
 * is nothing left to plan in them.
 */
function creditLoadWarnings(readings: readonly Reading[], attempts: readonly Attempt[], limit: number): PlanWarning[] {
  const planning = new Set(attempts.filter(isPending).map(semesterIndex));
  return creditsOverCompiled(
    readings.map((reading) => reading.program),
    attempts,
  )
    .filter((slot) => planning.has(semesterIndex(slot)) && slot.credits > limit)
    .map((slot) => ({
      kind: "credit-load" as const,
      target: { kind: "semester" as const, academicYear: slot.academicYear, semester: slot.semester },
      credits: slot.credits,
      limit,
    }));
}

/**
 * The Requirements left unmet in the projected lens, named where the student can act: an unmet
 * `allOf` (and the Program itself) by its unmet children, an unmet `nOf` by itself, since which of
 * its children to take is the student's choice, and an unmet leaf by itself.
 */
function unmetIn(requirements: readonly EvaluatedRequirement[]): string[] {
  return requirements.flatMap((node) => {
    if (node.projected.status === "satisfied") return [];
    if (node.kind === "allOf") return unmetIn(node.children);
    return [node.id];
  });
}

function missingWarnings(input: PlanCheckInput): PlanWarning[] {
  if (input.programs.length === 0) return [];
  const solution = solveAssignment({
    programs: input.programs.map(({ file, track }) => (track === undefined ? { file } : { file, track })),
    attempts: input.attempts,
    ...(input.pins ? { pins: input.pins } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
  });
  return input.programs.flatMap((entry, index): PlanWarning[] => {
    const progress = evaluateProgress({
      file: entry.file,
      ...(entry.track === undefined ? {} : { track: entry.track }),
      attempts: input.attempts,
      assignment: solution.assignments[index]!,
      ...(entry.ticked ? { ticked: entry.ticked } : {}),
    });
    const requirementIds = unmetIn(progress.requirements);
    if (requirementIds.length === 0) return [];
    return [
      {
        kind: "requirements-missing",
        target: { kind: "program", requirementsFile: entry.requirementsFile },
        requirementIds,
      },
    ];
  });
}

/** Each deadline the file defines, at the Semester it falls in for this Cohort. Needs a Cohort. */
function deadlineWarnings(reading: Reading, cohort: StudentCohort | undefined): PlanWarning[] {
  if (cohort === undefined) return [];
  return reading.program.file.deadlines.flatMap((deadline): PlanWarning[] => {
    const by = studyPointAt(cohort, deadline.by);
    const inTime = (attempt: Attempt) => semesterIndex(attempt) <= semesterIndex(by);
    const outcome = allOf(deadline.courses.map((course) => passedInTime(reading, course, inTime, undefined)));
    if (outcome.met) return [];
    return [
      {
        kind: "deadline-missed",
        target: { kind: "semester", ...by },
        requirementsFile: reading.requirementsFile,
        ...(deadline.name === undefined ? {} : { name: deadline.name }),
        missing: unique(outcome.missing),
        reliesOn: unique(outcome.reliesOn),
      },
    ];
  });
}

/**
 * Checks a student's Plan against their Programs' Requirements Files. Pure: the same Attempts,
 * files, Cohort and limit always give the same Warnings, in the order the checks are listed above
 * and, within one, the order of the Attempts or Semesters they are about.
 */
export function checkPlan(input: PlanCheckInput): PlanWarning[] {
  const readings = input.programs.map((entry) => readingOf(entry, input.attempts));
  return [
    ...readings.flatMap((reading) => prerequisiteWarnings(reading, input.attempts)),
    ...readings.flatMap((reading) => offeringWarnings(reading, input.attempts)),
    ...readings.flatMap((reading) => yearLongWarnings(reading)),
    ...(readings.length === 0 ? [] : creditLoadWarnings(readings, input.attempts, input.creditLoadLimit)),
    ...missingWarnings(input),
    ...readings.flatMap((reading) => deadlineWarnings(reading, input.cohort)),
  ];
}
