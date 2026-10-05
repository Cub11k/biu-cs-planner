import type { Attempt } from "../state/schema.ts";
import {
  accepts,
  compileProgram,
  leavesAccepting,
  mayShare,
  score,
  standings,
  type CompiledProgram,
  type Lens,
  type Lenses,
  type NodeOutcome,
  type RequirementStatus,
  type Standing,
} from "./program.ts";
import type { LocalizedText, Requirement, RequirementsFile } from "./schema.ts";

export type { Lens, Lenses, RequirementStatus } from "./program.ts";

/**
 * Progress: a student's Attempts evaluated against one Program's Requirements. A pure function
 * of its inputs, so the API can run it on every read. The Assignment, which Course counts toward
 * which Requirement, is an input: `solve.ts` computes the best one, and `firstFitAssignment`
 * below is the trivial one.
 *
 * Credits come from the Requirements File's Course table and never from a Catalog: the Plan is
 * checked against the Requirements File (`docs/design.md`, "Plan"), and future years have no
 * Catalog. Course identity goes through Equivalences before anything is matched.
 */

/** One Course counting toward one or more Requirements, by Requirement id. */
export interface Placement {
  courseNumber: string;
  requirementIds: string[];
}

/**
 * Which Course counts toward which Requirement, per lens. Two lists rather than one because the
 * best place for a completed Course can change once planned Courses join it: a Course that is
 * the only way to meet one Requirement today may be better spent elsewhere once a planned Course
 * meets that Requirement instead.
 */
export type Assignment = Lenses<Placement[]>;

export interface LensEvaluation {
  status: RequirementStatus;
  /** Courses counting toward this Requirement, or anywhere below it, sorted. */
  courses: string[];
  /** `credits`: credits counted toward it, against the minimum it needs. */
  credits?: { counted: number; needed: number };
  /** `allOf` and `nOf`: children met, against how many are needed. Limits are not counted. */
  met?: { count: number; needed: number };
  /** `cap`: credits of its Pool counted below its parent, its maximum, and what it kept out. */
  capped?: { counted: number; max: number; cut: number };
}

export interface EvaluatedRequirement {
  id: string;
  kind: Requirement["kind"];
  name?: LocalizedText;
  /** `manual`: the department's text, and whether the student has ticked it. */
  text?: LocalizedText;
  ticked?: boolean;
  completed: LensEvaluation;
  projected: LensEvaluation;
  children: EvaluatedRequirement[];
}

export type ProgressWarning =
  | { kind: "track-unknown"; track: string }
  /** An Attempt for a Course the file neither lists nor lets any Requirement take. */
  | { kind: "course-unknown"; courseNumber: string }
  /** A counted Course whose credits the file does not give, counted as zero. */
  | { kind: "credits-unknown"; courseNumber: string }
  | { kind: "assignment-requirement-unknown"; courseNumber: string; requirementId: string }
  | { kind: "assignment-not-accepted"; courseNumber: string; requirementId: string }
  /** A second Requirement for one Course where the file allows no double counting. */
  | { kind: "assignment-double-count"; courseNumber: string; requirementId: string };

export interface Progress {
  /** The base rule set's top-level Requirements, then the chosen Track's. */
  requirements: EvaluatedRequirement[];
  /** The Program as a whole: every top-level Requirement met. */
  status: Lenses<RequirementStatus>;
  /** Credits of every counted Course, each once, whatever it is assigned to. */
  totalCredits: Lenses<number>;
  warnings: ProgressWarning[];
}

export interface ProgressInput {
  file: RequirementsFile;
  /** The Track's id, when the student has chosen one. */
  track?: string;
  attempts: readonly Attempt[];
  assignment: Assignment;
  /** Ids of the Manual Requirements the student has ticked. Where ticks live is not ours. */
  ticked?: readonly string[];
}

/** Courses counting in a lens, by canonical course number, sorted. */
export function countedIn(standing: ReadonlyMap<string, Standing>, lens: Lens): string[] {
  return [...standing.entries()]
    .filter(([, s]) => s[lens])
    .map(([course]) => course)
    .sort();
}

/**
 * Turns one lens of an Assignment into placements the scorer trusts. A placement is kept only
 * for a Course the lens counts, on a Requirement that exists and accepts it, and beside the
 * Requirements already kept for it only where the file allows double counting. Everything else
 * is reported and left out; a placement for a Course the lens does not count is simply not
 * counted, since a planned Course belongs in the projected lens only.
 */
function placementsOf(
  program: CompiledProgram,
  placements: readonly Placement[],
  counted: ReadonlySet<string>,
  warn: (warning: ProgressWarning) => void,
): Map<number, string[]> {
  const leavesByCourse = new Map<string, number[]>();
  for (const placement of placements) {
    const course = program.canonical(placement.courseNumber);
    if (!counted.has(course)) continue;
    const kept = leavesByCourse.get(course) ?? [];
    leavesByCourse.set(course, kept);
    for (const requirementId of placement.requirementIds) {
      const leaf = program.byId.get(requirementId);
      if (leaf === undefined) {
        warn({ kind: "assignment-requirement-unknown", courseNumber: course, requirementId });
      } else if (!accepts(program, leaf, course)) {
        warn({ kind: "assignment-not-accepted", courseNumber: course, requirementId });
      } else if (kept.includes(leaf)) {
        continue;
      } else if (kept.every((other) => mayShare(program, other, leaf, course))) {
        kept.push(leaf);
      } else {
        warn({ kind: "assignment-double-count", courseNumber: course, requirementId });
      }
    }
  }

  const byLeaf = new Map<number, string[]>();
  for (const [course, leaves] of leavesByCourse) {
    for (const leaf of leaves) byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), course]);
  }
  return byLeaf;
}

function lensEvaluation(
  requirement: Requirement | undefined,
  outcome: NodeOutcome,
): LensEvaluation {
  const evaluation: LensEvaluation = { status: outcome.status, courses: outcome.courses };
  switch (requirement?.kind) {
    case "credits":
      evaluation.credits = { counted: outcome.counted, needed: requirement.min };
      break;
    case "allOf":
    case "nOf":
      evaluation.met = { count: outcome.met, needed: outcome.needed };
      break;
    case "cap":
      evaluation.capped = { counted: outcome.counted, max: requirement.max, cut: outcome.cut };
      break;
  }
  return evaluation;
}

function evaluatedTree(
  program: CompiledProgram,
  outcomes: Lenses<NodeOutcome[]>,
  ticked: ReadonlySet<string>,
  index: number,
): EvaluatedRequirement {
  const node = program.nodes[index]!;
  const requirement = node.requirement!;
  return {
    id: requirement.id,
    kind: requirement.kind,
    ...(requirement.name ? { name: requirement.name } : {}),
    ...(requirement.kind === "manual"
      ? { text: requirement.text, ticked: ticked.has(requirement.id) }
      : {}),
    completed: lensEvaluation(requirement, outcomes.completed[index]!),
    projected: lensEvaluation(requirement, outcomes.projected[index]!),
    children: node.children.map((child) => evaluatedTree(program, outcomes, ticked, child)),
  };
}

/**
 * The Warnings about the student's Courses rather than the Assignment, once per Course: a Course
 * nothing in the file knows, and a counted Course whose credits the file does not give.
 */
function courseWarnings(
  program: CompiledProgram,
  standing: ReadonlyMap<string, Standing>,
): ProgressWarning[] {
  const warnings: ProgressWarning[] = [];
  for (const course of [...standing.keys()].sort()) {
    const known = program.inTable(course) || leavesAccepting(program, course).length > 0;
    if (!known) warnings.push({ kind: "course-unknown", courseNumber: course });
    else if (standing.get(course)!.projected && program.credits(course) === undefined) {
      warnings.push({ kind: "credits-unknown", courseNumber: course });
    }
  }
  return warnings;
}

/**
 * Evaluates a Program for one student. Every node of the tree comes back with both lenses:
 * `completed` counts passed, exempt and credited Attempts under the file's policies, and
 * `projected` adds registered and planned ones, so the student sees both where they are and
 * where the Plan takes them. Nothing is refused: what cannot be counted is a Warning.
 */
export function evaluateProgress(input: ProgressInput): Progress {
  const { file, track, attempts, assignment } = input;
  const ticked = new Set(input.ticked ?? []);
  const program = compileProgram(file, track);
  const standing = standings(program, attempts);

  const warnings: ProgressWarning[] = [];
  if (track !== undefined && program.track === undefined) warnings.push({ kind: "track-unknown", track });

  const seen = new Set<string>();
  const assignmentWarnings: ProgressWarning[] = [];
  const warn = (warning: ProgressWarning) => {
    const key = JSON.stringify(warning);
    if (seen.has(key)) return;
    seen.add(key);
    assignmentWarnings.push(warning);
  };

  const outcomes = {} as Lenses<NodeOutcome[]>;
  const totalCredits = {} as Lenses<number>;
  for (const lens of ["completed", "projected"] as const) {
    const counted = countedIn(standing, lens);
    const placements = placementsOf(program, assignment[lens], new Set(counted), warn);
    outcomes[lens] = score(program, placements, ticked);
    totalCredits[lens] = counted.reduce((sum, course) => sum + (program.credits(course) ?? 0), 0);
  }

  return {
    requirements: program.nodes[0]!.children.map((index) =>
      evaluatedTree(program, outcomes, ticked, index),
    ),
    status: { completed: outcomes.completed[0]!.status, projected: outcomes.projected[0]!.status },
    totalCredits,
    warnings: [...warnings, ...courseWarnings(program, standing), ...assignmentWarnings],
  };
}

/**
 * The trivial Assignment: every counted Course, in course-number order, on the first Requirement
 * in tree order that accepts it, and nowhere else. It ignores caps, exclusives and what a better
 * arrangement could satisfy, which is the solver's job; it exists so that Progress can be
 * evaluated, and tested, without one.
 */
export function firstFitAssignment(input: {
  file: RequirementsFile;
  track?: string;
  attempts: readonly Attempt[];
}): Assignment {
  const program = compileProgram(input.file, input.track);
  const standing = standings(program, input.attempts);
  const lens = (which: Lens): Placement[] =>
    countedIn(standing, which).flatMap((course) => {
      const first = leavesAccepting(program, course)[0];
      if (first === undefined) return [];
      return [{ courseNumber: course, requirementIds: [program.nodes[first]!.requirement!.id] }];
    });
  return { completed: lens("completed"), projected: lens("projected") };
}
