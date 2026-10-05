import type { Attempt } from "../state/schema.ts";
import { countedIn, type Assignment, type Placement } from "./evaluate.ts";
import {
  accepts,
  compileProgram,
  constrained,
  leavesAccepting,
  mayShare,
  score,
  standings,
  type CompiledProgram,
  type Lens,
} from "./program.ts";
import type { RequirementsFile } from "./schema.ts";

/**
 * The Assignment solver: which Requirement each of a student's Courses counts toward, chosen to
 * satisfy as many Requirements as it can (`docs/design.md`, "Assignment").
 *
 * **Objective.** The number of satisfied Requirement nodes, the Program itself included, summed
 * over the Programs of a double major. Among Assignments the search finds satisfying the most,
 * it prefers more credits counted toward `credits` Requirements, each counted only up to its
 * minimum, so a spare Course goes where it is progress rather than surplus. That preference is
 * pursued by single moves (see "Search"), not proved optimal. That refines the ticket's "more credits in partially satisfied
 * `credits` nodes", which is what it amounts to between two Assignments meeting the same
 * Requirements, into a sum that only rewards progress. A tie on both goes to whichever
 * Assignment the search reaches first, and the search runs in a fixed order: Courses by fewest
 * choices, then Program, then course number, and each Course's choices in tree order, with
 * "nowhere" last. That refines the ticket's "stable order by Requirement id and course number":
 * tree order is the order the maintainer wrote and the order the trivial first-fit Assignment
 * uses, so where first-fit is already as good as anything the solver changes nothing. Nothing
 * depends on the order Attempts or Pins are listed in.
 *
 * **Constraints.** A Course counts once among sibling Requirements, so toward one Requirement of
 * a Program, unless the file's permissions let it count toward more; where they do, a Course
 * placed on one Requirement is placed on every other it may share with, and also on any fewer of
 * them where a cap or an exclusive could make sharing cost. Across a double major's
 * Programs it counts in one of them unless both files allow it in both. Pins are hard
 * constraints, and a Pin that cannot be honoured is dropped with a Warning.
 *
 * **Search.** Two phases. First, depth-first branch and bound for the most satisfied
 * Requirements, over the Courses that have a choice. The first complete Assignment it reaches is
 * the greedy one, every Course on its first legal choice, so there is always an answer. A branch
 * is cut unless placing every remaining Course on every Requirement that accepts it, with
 * exclusives lifted and each cap counted in full at every leaf below it, would satisfy more than
 * the best so far: those relaxations make more placements never satisfy fewer nodes, which is
 * what makes that an upper bound. When this phase finishes, no Assignment satisfies more.
 * "Nowhere" is a choice only for a Course a cap or an exclusive could stop counting, or one
 * another Program may also want; for any other Course, placing it is never worse.
 *
 * Second, the tie-break, by moving one Course at a time while a move improves the score. It is
 * not searched for exhaustively: credits toward a minimum are a fine-grained quantity no cheap
 * bound closes, and a search that also hunted them visited every Assignment of a 45-Course
 * Program without finishing in 200,000 steps. Measured; with this split, the same Program
 * finishes well inside the default cap.
 *
 * **Limits.** Each lens may take `maxIterations` steps across both phases, and the whole call may take
 * `maxMillis` by the clock it is given. #286 points at "the one clock pattern" of ADR-0012, but that
 * record and `../clock.ts` are about reading `hh:mm` strings, not about telling the time; the
 * injected `now` follows `app/src/workspace.memory.ts` instead. `core` reads no clock of its own, so without `now` there
 * is no time cap and the iteration cap alone bounds the work. On hitting either the best
 * Assignment so far is returned with `stoppedEarly`.
 */

export interface SolveLimits {
  /** Search nodes each lens may visit. */
  maxIterations?: number;
  /** Milliseconds the whole call may take, measured by `now`. Ignored without `now`. */
  maxMillis?: number;
  /** A clock in milliseconds. The solver never reads one of its own. */
  now?: () => number;
}

export const DEFAULT_SOLVE_LIMITS = { maxIterations: 20_000, maxMillis: 250 } as const;

export type SolverWarning =
  | { kind: "track-unknown"; program: string; track: string }
  | { kind: "pin-requirement-unknown"; courseNumber: string; requirementId: string }
  | { kind: "pin-not-accepted"; courseNumber: string; requirementId: string }
  /** A Pin that would count a Course where an earlier Pin already counts it and may not share. */
  | { kind: "pin-conflict"; courseNumber: string; requirementId: string };

/**
 * A Pin as the solver takes it: a Course, a Requirement id, and which of `programs` the Pin is for
 * (#287). A Requirement id is unique only within one file, so a Pin naming `program` is honoured in
 * that Program alone; one naming none is honoured in every Program that has the id, which is what
 * every Pin meant before Pins could name their Requirements File. Turning a State File Pin's file
 * name into an index is the caller's, which knows the student's Programs.
 */
export interface SolvePin {
  courseNumber: string;
  requirementId: string;
  program?: number;
}

export interface SolveInput {
  /** One Program, or the two of a double major, each with its Track. */
  programs: readonly { file: RequirementsFile; track?: string }[];
  attempts: readonly Attempt[];
  pins?: readonly SolvePin[];
  limits?: SolveLimits;
}

export interface Solution {
  /** One Assignment per Program, in the order the Programs were given. */
  assignments: Assignment[];
  stoppedEarly: boolean;
  warnings: SolverWarning[];
}

/** One Course in one Program: what the search decides. */
interface Choice {
  program: number;
  course: string;
  origins: readonly string[];
  /** Each choice is a set of leaves; `[]` is "nowhere". */
  options: number[][];
  /** Pinned leaves, when the Course is pinned; then there is no choice to make. */
  pinned: number[] | undefined;
  /** Choices in the other Program for the same Course, by an Attempt they share. */
  links: number[];
}

/** String order by UTF-16 code unit, as `.sort()` uses: the same on every machine and locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compared in order: satisfied nodes, then credits toward `credits` minimums. */
interface Score {
  satisfied: number;
  credits: number;
}

function better(a: Score, b: Score): boolean {
  return a.satisfied > b.satisfied || (a.satisfied === b.satisfied && a.credits > b.credits);
}

/** Whether a file lets a Course counted in it count in the other Program too. */
function acrossAllowed(program: CompiledProgram, course: string): boolean {
  const across = program.file.doubleCounting.acrossPrograms;
  if (across === undefined) return false;
  return across.pool === undefined || program.poolHas(across.pool, course);
}

/**
 * The leaves a Course goes to when placed on `first`: that one, and every later-found leaf that
 * may share with all of those before it.
 */
function withSharing(program: CompiledProgram, first: number, leaves: number[], course: string) {
  const chosen = [first];
  for (const leaf of leaves) {
    if (chosen.every((other) => mayShare(program, other, leaf, course))) chosen.push(leaf);
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * The non-empty proper subsets of a set of leaves, largest first. A set of leaves one Course may
 * share is a set of Requirements a file names in one permission, so it is a handful at most; the
 * cap of twelve is a guard against a file that names hundreds, beyond which only single leaves
 * are offered.
 */
function subsetsOf(leaves: number[]): number[][] {
  if (leaves.length > 12) return leaves.map((leaf) => [leaf]);
  const subsets: number[][] = [];
  for (let mask = 1; mask < (1 << leaves.length) - 1; mask++) {
    subsets.push(leaves.filter((_, i) => mask & (1 << i)));
  }
  return subsets.sort((a, b) => b.length - a.length);
}

/** Pins resolved to leaves, by Program and canonical course, with the Warnings they raise. */
function resolvePins(
  programs: readonly CompiledProgram[],
  pins: readonly SolvePin[],
  warn: (warning: SolverWarning) => void,
): Map<string, number[]>[] {
  const resolved = programs.map(() => new Map<string, number[]>());
  const ordered = [...pins].sort(
    (a, b) =>
      byCodeUnit(a.courseNumber, b.courseNumber) ||
      byCodeUnit(a.requirementId, b.requirementId) ||
      (a.program ?? -1) - (b.program ?? -1),
  );
  for (const { courseNumber, requirementId, program: only } of ordered) {
    let found = false;
    programs.forEach((program, p) => {
      if (only !== undefined && only !== p) return;
      const leaf = program.byId.get(requirementId);
      if (leaf === undefined) return;
      found = true;
      const course = program.canonical(courseNumber);
      if (!accepts(program, leaf, course)) {
        warn({ kind: "pin-not-accepted", courseNumber, requirementId });
        return;
      }
      const leaves = resolved[p]!.get(course) ?? [];
      if (leaves.every((other) => mayShare(program, other, leaf, course))) {
        resolved[p]!.set(course, [...leaves, leaf]);
      } else {
        warn({ kind: "pin-conflict", courseNumber, requirementId });
      }
    });
    if (!found) warn({ kind: "pin-requirement-unknown", courseNumber, requirementId });
  }
  return resolved;
}

class Search {
  private iterations = 0;
  stopped = false;
  private readonly picked: (number[] | undefined)[];
  private best: { score: Score; picked: (number[] | undefined)[] };
  private readonly order: number[];
  private readonly programs: readonly CompiledProgram[];
  private readonly choices: Choice[];
  private readonly maxIterations: number;
  private readonly outOfTime: () => boolean;

  constructor(
    programs: readonly CompiledProgram[],
    choices: Choice[],
    maxIterations: number,
    outOfTime: () => boolean,
  ) {
    this.programs = programs;
    this.choices = choices;
    this.maxIterations = maxIterations;
    this.outOfTime = outOfTime;
    this.picked = choices.map((choice) => choice.pinned);
    this.order = choices
      .map((choice, index) => ({ choice, index }))
      .filter(({ choice }) => choice.pinned === undefined)
      .sort(
        (a, b) =>
          a.choice.options.length - b.choice.options.length ||
          a.choice.program - b.choice.program ||
          byCodeUnit(a.choice.course, b.choice.course),
      )
      .map(({ index }) => index);

    for (const index of this.order) {
      this.picked[index] = this.choices[index]!.options.find((option) => this.legal(index, option));
    }
    this.best = { score: this.score(false), picked: [...this.picked] };
    for (const index of this.order) this.picked[index] = undefined;
  }

  /** A choice may not put a Course in both Programs unless both allow it. */
  private legal(index: number, option: number[]): boolean {
    return option.length === 0 || this.conflicts(index).length === 0;
  }

  /**
   * The score of what is picked. `relaxed` also places every undecided Course on every leaf that
   * accepts it, with caps and exclusives lifted: an upper bound on any way of finishing the
   * Assignment, on both parts of the score.
   */
  private score(relaxed: boolean): Score {
    const placements = this.programs.map(() => new Map<number, string[]>());
    this.choices.forEach((choice, index) => {
      const leaves =
        this.picked[index] ?? (relaxed ? [...new Set(choice.options.flat())] : []);
      for (const leaf of leaves) {
        const atLeaf = placements[choice.program]!.get(leaf) ?? [];
        placements[choice.program]!.set(leaf, [...atLeaf, choice.course]);
      }
    });
    let satisfied = 0;
    let credits = 0;
    const allDemands: number[] = [];
    let separately = 0;
    this.programs.forEach((program, p) => {
      const outcomes = score(program, placements[p]!, new Set(), relaxed);
      const demands: number[] = [];
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "satisfied") satisfied++;
        const requirement = program.nodes[index]!.requirement;
        if (outcome.status === "satisfied" && requirement?.kind === "course") {
          demands.push(program.credits(program.canonical(requirement.course)) ?? 0);
        }
        if (requirement?.kind !== "credits") return;
        credits += Math.min(outcome.counted, requirement.min);
        if (outcome.status === "satisfied") demands.push(requirement.min);
      });
      if (relaxed) separately += this.unaffordable(demands, this.supply([p]));
      allDemands.push(...demands);
    });
    if (relaxed) {
      const together =
        this.programs.length > 1
          ? this.unaffordable(allDemands, this.supply(this.programs.map((_, p) => p)))
          : 0;
      satisfied -= Math.max(separately, together);
    }
    return { satisfied, credits };
  }

  /**
   * The credits of the Courses that could still count in these Programs: undecided, or placed
   * somewhere. `undefined` when any of them lets a Course count twice within it, since then no
   * sum of credits limits what its leaves can meet. A Course in two Programs that may not count
   * in both is supply once, at the larger of its two credit values.
   */
  private supply(programs: number[]): number | undefined {
    if (programs.some((p) => this.programs[p]!.permissions.length > 0)) return undefined;
    let supply = 0;
    const counted = new Set<number>();
    this.choices.forEach((choice, index) => {
      const picked = this.picked[index];
      if (!programs.includes(choice.program) || counted.has(index)) return;
      if (picked !== undefined && picked.length === 0) return;
      const credits = (i: number) =>
        this.programs[this.choices[i]!.program]!.credits(this.choices[i]!.course) ?? 0;
      let largest = credits(index);
      for (const link of choice.links) {
        const linked = this.choices[link]!;
        if (!programs.includes(linked.program)) continue;
        const shared =
          acrossAllowed(this.programs[choice.program]!, choice.course) &&
          acrossAllowed(this.programs[linked.program]!, linked.course);
        if (shared) continue;
        counted.add(link);
        largest = Math.max(largest, credits(link));
      }
      supply += largest;
    });
    return supply;
  }

  /**
   * How many of the leaves the relaxed score calls satisfied no real Assignment can satisfy
   * together, for want of credits. Where no file allows double counting within it, each Course
   * counts at one leaf at most, so the leaves met at once cannot demand more than `supply`: a
   * `credits` leaf demands its minimum, and a `course` leaf its own Course's credits. Keeping the
   * leaves with the smallest demands keeps as many as possible, so every other one is a node the
   * relaxed score over-counts. This is what lets the search prove a Requirement out of reach
   * rather than visit every Assignment looking for one that reaches it, which is most
   * Requirements for a student partway through a degree.
   */
  private unaffordable(demands: number[], supply: number | undefined): number {
    if (supply === undefined) return 0;
    let kept = 0;
    for (const demand of demands.sort((a, b) => a - b)) {
      if (demand > supply) break;
      supply -= demand;
      kept++;
    }
    return demands.length - kept;
  }

  run(): (number[] | undefined)[] {
    // Every Course pinned, or none to place: the one Assignment there is cannot stop early.
    if (this.order.length === 0) return this.best.picked;
    this.polish();
    if (!this.stopped) this.visit(0);
    if (!this.stopped) this.polish();
    return this.best.picked;
  }

  /** Counts one unit of work, and says whether the limits have been reached. */
  private spent(): boolean {
    this.iterations++;
    if (this.iterations > this.maxIterations || this.outOfTime()) this.stopped = true;
    return this.stopped;
  }

  /**
   * Improves the best Assignment so far by moving one Course at a time to another of its
   * choices, in search order, whenever that strictly improves the score, until no single move
   * does. A move that would put a Course in both Programs where it may not count in both takes it
   * out of the other one as part of the same move, since neither half alone could ever improve
   * the score. Run before the search, it turns the greedy start into an incumbent the search can
   * prune against; run after it, it pursues the tie-break. A move is kept only when the whole
   * score improves, so it never costs a satisfied Requirement.
   */
  private polish(): void {
    this.picked.splice(0, this.picked.length, ...this.best.picked);
    let improved = true;
    while (improved && !this.stopped) {
      improved = false;
      for (const index of this.order) {
        const current = this.picked[index]!;
        for (const option of this.choices[index]!.options) {
          if (option === current) continue;
          const evicted = option.length === 0 ? [] : this.conflicts(index);
          if (evicted.some((link) => this.choices[link]!.pinned !== undefined)) continue;
          if (this.spent()) break;
          const before = evicted.map((link) => this.picked[link]);
          for (const link of evicted) this.picked[link] = [];
          this.picked[index] = option;
          const reached = this.score(false);
          if (better(reached, this.best.score)) {
            this.best = { score: reached, picked: [...this.picked] };
            improved = true;
            break;
          }
          this.picked[index] = current;
          evicted.forEach((link, i) => (this.picked[link] = before[i]));
        }
        if (this.stopped) break;
      }
    }
    for (const index of this.order) this.picked[index] = undefined;
  }

  /** The choices in another Program holding this Course where it may not count in both. */
  private conflicts(index: number): number[] {
    const choice = this.choices[index]!;
    return choice.links.filter((link) => {
      const other = this.picked[link];
      if (other === undefined || other.length === 0) return false;
      const linked = this.choices[link]!;
      return !(
        acrossAllowed(this.programs[choice.program]!, choice.course) &&
        acrossAllowed(this.programs[linked.program]!, linked.course)
      );
    });
  }

  private visit(depth: number): void {
    if (this.stopped || this.spent()) return;
    if (depth === this.order.length) {
      const reached = this.score(false);
      if (better(reached, this.best.score)) this.best = { score: reached, picked: [...this.picked] };
      return;
    }
    // Only more satisfied Requirements justify going deeper; the tie-break is `polish`'s.
    if (this.score(true).satisfied <= this.best.score.satisfied) return;

    // The best Assignment's choice first, so the first Assignment reached is the incumbent and
    // the search spends its steps on what could beat it.
    const index = this.order[depth]!;
    const incumbent = this.best.picked[index];
    const options = this.choices[index]!.options;
    for (const option of [...options.filter((o) => o === incumbent), ...options.filter((o) => o !== incumbent)]) {
      if (!this.legal(index, option)) continue;
      this.picked[index] = option;
      this.visit(depth + 1);
      this.picked[index] = undefined;
      if (this.stopped) return;
    }
  }
}

/** The Courses one lens counts, as choices for the search, across every Program. */
function choicesFor(
  programs: readonly CompiledProgram[],
  attempts: readonly Attempt[],
  pinned: readonly Map<string, number[]>[],
  lens: Lens,
): Choice[] {
  const choices: Choice[] = [];
  programs.forEach((program, p) => {
    const standing = standings(program, attempts);
    for (const course of countedIn(standing, lens)) {
      const leaves = leavesAccepting(program, course);
      const pins = pinned[p]!.get(course);
      if (leaves.length === 0 && pins === undefined) continue;
      const options = new Map<string, number[]>();
      for (const leaf of leaves) {
        const option = withSharing(program, leaf, leaves, course);
        options.set(option.join(","), option);
      }
      // Placing a Course on more leaves never satisfies fewer Requirements unless a cap or an
      // exclusive can stop it counting at one of them; then counting it at fewer can be better,
      // so every smaller set of the same leaves is a choice too, after the full ones.
      for (const option of [...options.values()]) {
        if (option.length < 2 || !option.some((leaf) => constrained(program, leaf, course))) continue;
        for (const subset of subsetsOf(option)) options.set(subset.join(","), subset);
      }
      choices.push({
        program: p,
        course,
        origins: standing.get(course)!.origins,
        options: [...options.values()],
        pinned: pins,
        links: [],
      });
    }
  });

  choices.forEach((choice, index) => {
    choice.links = choices.flatMap((other, otherIndex) =>
      other.program !== choice.program && other.origins.some((o) => choice.origins.includes(o))
        ? [otherIndex]
        : [],
    );
    const program = programs[choice.program]!;
    const contested = choice.links.some(
      (link) =>
        !acrossAllowed(program, choice.course) ||
        !acrossAllowed(programs[choices[link]!.program]!, choices[link]!.course),
    );
    const limited = choice.options.some((option) =>
      option.some((leaf) => constrained(program, leaf, choice.course)),
    );
    if (choice.pinned === undefined && (contested || limited)) choice.options.push([]);
  });
  return choices;
}

/**
 * Two Pins in different Programs on one Course that the files do not let count in both: the
 * later Program's Pins give way, with a Warning, as the later of two Pins in one Program does.
 */
function settleCrossPins(
  programs: readonly CompiledProgram[],
  choices: Choice[],
  warn: (warning: SolverWarning) => void,
): void {
  choices.forEach((choice, index) => {
    if (choice.pinned === undefined) return;
    const clash = choice.links.some((link) => {
      const other = choices[link]!;
      return (
        link < index &&
        other.pinned !== undefined &&
        other.pinned.length > 0 &&
        !(
          acrossAllowed(programs[choice.program]!, choice.course) &&
          acrossAllowed(programs[other.program]!, other.course)
        )
      );
    });
    if (!clash) return;
    for (const leaf of choice.pinned) {
      const requirementId = programs[choice.program]!.nodes[leaf]!.requirement!.id;
      warn({ kind: "pin-conflict", courseNumber: choice.course, requirementId });
    }
    choice.pinned = [];
  });
}

function placementsOf(program: CompiledProgram, choices: Choice[], picked: (number[] | undefined)[], p: number) {
  const placements: Placement[] = [];
  choices.forEach((choice, index) => {
    const leaves = picked[index];
    if (choice.program !== p || !leaves || leaves.length === 0) return;
    placements.push({
      courseNumber: choice.course,
      requirementIds: [...leaves].sort((a, b) => a - b).map((leaf) => program.nodes[leaf]!.requirement!.id),
    });
  });
  return placements.sort((a, b) => byCodeUnit(a.courseNumber, b.courseNumber));
}

/**
 * Finds the Assignment that satisfies the most Requirements, for each lens and each Program,
 * honouring Pins. Pure and bounded: the same inputs always give the same Assignment, and it
 * never runs past its limits.
 */
export function solveAssignment(input: SolveInput): Solution {
  const maxIterations = input.limits?.maxIterations ?? DEFAULT_SOLVE_LIMITS.maxIterations;
  const maxMillis = input.limits?.maxMillis ?? DEFAULT_SOLVE_LIMITS.maxMillis;
  const now = input.limits?.now;
  const deadline = now === undefined ? undefined : now() + maxMillis;
  const outOfTime = () => now !== undefined && deadline !== undefined && now() >= deadline;

  const warnings: SolverWarning[] = [];
  const seen = new Set<string>();
  const warn = (warning: SolverWarning) => {
    const key = JSON.stringify(warning);
    if (!seen.has(key)) {
      seen.add(key);
      warnings.push(warning);
    }
  };

  const programs = input.programs.map(({ file, track }) => {
    const program = compileProgram(file, track);
    if (track !== undefined && program.track === undefined) {
      warn({ kind: "track-unknown", program: file.program.id, track });
    }
    return program;
  });
  const pinned = resolvePins(programs, input.pins ?? [], warn);

  let stoppedEarly = false;
  const byLens = {} as Record<Lens, Placement[][]>;
  for (const lens of ["completed", "projected"] as const) {
    const choices = choicesFor(programs, input.attempts, pinned, lens);
    settleCrossPins(programs, choices, warn);
    const search = new Search(programs, choices, maxIterations, outOfTime);
    const picked = search.run();
    stoppedEarly ||= search.stopped;
    byLens[lens] = programs.map((program, p) => placementsOf(program, choices, picked, p));
  }

  return {
    assignments: programs.map((_, p) => ({
      completed: byLens.completed[p]!,
      projected: byLens.projected[p]!,
    })),
    stoppedEarly,
    warnings,
  };
}
