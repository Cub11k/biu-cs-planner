import type { AttemptFacts } from "../state/schema.ts";
import { semesterIndex } from "../state/semester-order.ts";
import type { Policies, Pool, Requirement, RequirementsFile } from "./schema.ts";

/**
 * The engine the Progress evaluation and the Assignment solver share: one Program's Requirement
 * tree compiled into a flat list, and the one function that says what a set of placements adds
 * up to. Evaluation calls it once per lens; the solver calls it once per Assignment it weighs,
 * so the two can never disagree about what an Assignment satisfies.
 *
 * Nothing here executes anything from the file. A Pool is matched by string comparison (a list,
 * a prefix) or by comparing whole numbers (a range), and the one regular expression in this
 * module is a literal (ADR-0007).
 */

export type RequirementStatus = "satisfied" | "partial" | "missing";

export type Lens = "completed" | "projected";

export type Lenses<T> = { completed: T; projected: T };

/**
 * One node of the compiled tree. Nodes are in preorder with the Program itself at index 0, so a
 * node's subtree is the contiguous run of indices from its own up to `end`.
 */
export interface CompiledNode {
  index: number;
  /** `undefined` for the Program itself, which is an all-of of its top-level Requirements. */
  requirement: Requirement | undefined;
  parent: number;
  children: number[];
  end: number;
}

/** A within-Program double-counting permission, its Requirement ids resolved to nodes. */
interface Permission {
  nodes: number[];
  pool: string | undefined;
}

export interface CompiledProgram {
  file: RequirementsFile;
  nodes: CompiledNode[];
  byId: ReadonlyMap<string, number>;
  /** `undefined` when no Track was asked for, or the file has no Track by that id. */
  track: string | undefined;
  /** Node indices of every `cap` and `exclusive`, in preorder. */
  caps: number[];
  exclusives: number[];
  permissions: Permission[];
  canonical: (courseNumber: string) => string;
  /** Credits of a canonical course number, or `undefined` when the file does not give them. */
  credits: (course: string) => number | undefined;
  /** Whether the Course table has an entry for a canonical course number. */
  inTable: (course: string) => boolean;
  /** Pool membership of a canonical course number. A Pool that is not defined holds nothing. */
  poolHas: (poolId: string, course: string) => boolean;
}

/** The Program root, plus each Requirement in preorder. */
function flatten(top: readonly Requirement[]): CompiledNode[] {
  const nodes: CompiledNode[] = [];
  const visit = (requirement: Requirement | undefined, parent: number): number => {
    const index = nodes.length;
    const node: CompiledNode = { index, requirement, parent, children: [], end: index + 1 };
    nodes.push(node);
    const children =
      requirement === undefined
        ? top
        : requirement.kind === "allOf" || requirement.kind === "nOf"
          ? requirement.of
          : [];
    for (const child of children) node.children.push(visit(child, index));
    node.end = nodes.length;
    return index;
  };
  visit(undefined, -1);
  return nodes;
}

/**
 * The course number an Equivalence chain ends at. A chain that loops is a mistake in the file,
 * which the reader reports as `equivalence-loop`; every member of the loop is then
 * read as its smallest member, which is at least the same answer from wherever the loop is
 * entered.
 */
function canonicalizer(file: RequirementsFile): (courseNumber: string) => string {
  const next = new Map(file.equivalences.map((e) => [e.from, e.to]));
  return (courseNumber) => {
    const visited: string[] = [];
    let current = courseNumber;
    while (next.has(current)) {
      if (visited.includes(current)) {
        const loop = visited.slice(visited.indexOf(current));
        return [...loop].sort()[0]!;
      }
      visited.push(current);
      current = next.get(current)!;
    }
    return current;
  };
}

/** A literal pattern, never built from data (ADR-0007): the number part of a course number. */
const DIGITS = /^\d+$/;

function poolMatcher(pool: Pool, canonical: (c: string) => string): (course: string) => boolean {
  switch (pool.kind) {
    case "list": {
      const members = new Set(pool.courses.map(canonical));
      return (course) => members.has(course);
    }
    case "prefix":
      return (course) => course.startsWith(pool.prefix);
    case "range":
      return (course) => {
        const hyphen = course.indexOf("-");
        if (hyphen < 0) return false;
        const digits = course.slice(hyphen + 1);
        if (course.slice(0, hyphen) !== pool.department || !DIGITS.test(digits)) return false;
        const number = Number(digits);
        return number >= pool.from && number <= pool.to;
      };
  }
}

/**
 * Compiles one Program with its Track. The Track's Requirements sit beside the base rule set's,
 * as siblings under the Program. A Track the file does not have is reported by the caller and
 * the base rule set is compiled alone.
 */
export function compileProgram(file: RequirementsFile, track?: string): CompiledProgram {
  const chosen = track === undefined ? undefined : file.tracks.find((t) => t.id === track);
  const nodes = flatten([...file.requirements, ...(chosen?.requirements ?? [])]);
  const byId = new Map<string, number>();
  const caps: number[] = [];
  const exclusives: number[] = [];
  for (const node of nodes) {
    if (node.requirement === undefined) continue;
    byId.set(node.requirement.id, node.index);
    if (node.requirement.kind === "cap") caps.push(node.index);
    if (node.requirement.kind === "exclusive") exclusives.push(node.index);
  }

  const canonical = canonicalizer(file);
  const table = new Map(file.courses.map((c) => [canonical(c.number), c]));
  const pools = new Map(file.pools.map((p) => [p.id, poolMatcher(p, canonical)]));
  const permissions = file.doubleCounting.within.map((permission) => ({
    nodes: permission.requirements.flatMap((id) => {
      const index = byId.get(id);
      return index === undefined ? [] : [index];
    }),
    pool: permission.pool,
  }));

  return {
    file,
    nodes,
    byId,
    track: chosen?.id,
    caps,
    exclusives,
    permissions,
    canonical,
    credits: (course) => table.get(course)?.credits,
    inTable: (course) => table.has(course),
    poolHas: (poolId, course) => pools.get(poolId)?.(course) ?? false,
  };
}

/** Whether a node is in the subtree rooted at `root`, itself included. */
export function within(program: CompiledProgram, root: number, node: number): boolean {
  return node >= root && node < program.nodes[root]!.end;
}

/** Whether a leaf takes this canonical course: its own Course, or a member of its Pool. */
export function accepts(program: CompiledProgram, node: number, course: string): boolean {
  const requirement = program.nodes[node]!.requirement;
  if (requirement?.kind === "course") return program.canonical(requirement.course) === course;
  if (requirement?.kind === "credits") return program.poolHas(requirement.pool, course);
  return false;
}

/** Every leaf that takes this canonical course, in preorder. */
export function leavesAccepting(program: CompiledProgram, course: string): number[] {
  return program.nodes.filter((node) => accepts(program, node.index, course)).map((n) => n.index);
}

/**
 * Whether one Course may count toward both of two different leaves. By default it may not: a
 * Course counts once among sibling Requirements, and any two leaves lie below two different
 * children of the node where their paths meet. A permission lifts that when the two leaves lie
 * below two different Requirements it names, and the Course is in its Pool when it has one.
 */
export function mayShare(program: CompiledProgram, a: number, b: number, course: string): boolean {
  if (a === b) return false;
  return program.permissions.some((permission) => {
    if (permission.pool !== undefined && !program.poolHas(permission.pool, course)) return false;
    return permission.nodes.some(
      (first, i) =>
        within(program, first, a) &&
        permission.nodes.some((second, j) => i !== j && within(program, second, b)),
    );
  });
}

/**
 * Whether a cap or an exclusive could stop this course counting at this leaf. Only then can
 * leaving the course off the leaf ever be better than placing it, which is what the solver asks.
 */
export function constrained(program: CompiledProgram, leaf: number, course: string): boolean {
  const scopeHolds = (limit: number) => within(program, program.nodes[limit]!.parent, leaf);
  return (
    program.caps.some((cap) => {
      const requirement = program.nodes[cap]!.requirement;
      return (
        requirement?.kind === "cap" && scopeHolds(cap) && program.poolHas(requirement.pool, course)
      );
    }) ||
    program.exclusives.some((exclusive) => {
      const requirement = program.nodes[exclusive]!.requirement;
      return (
        requirement?.kind === "exclusive" &&
        scopeHolds(exclusive) &&
        requirement.courses.some((c) => program.canonical(c) === course)
      );
    })
  );
}

// --- Attempts ---------------------------------------------------------------------------------

const DECIDED = new Set(["passed", "failed", "exempt", "credited"]);
const PENDING = new Set(["planned", "registered"]);

/** Whether one Attempt is a pass under the file's passing grade. Planned and registered never are. */
export function passes(attempt: AttemptFacts, passingGrade: number): boolean {
  if (attempt.status === "exempt" || attempt.status === "credited") return true;
  if (attempt.status !== "passed") return false;
  if (attempt.grade?.kind === "numeric") return attempt.grade.value >= passingGrade;
  if (attempt.grade?.kind === "pass-fail") return attempt.grade.passed;
  return true;
}

/**
 * The passing Attempts whose grade counts, out of one Course's Attempts, under the file's
 * `gradeAttempt` policy (#327, ruled A). `best`: every passing Attempt, since the best of them is
 * whichever meets a bar if any does. `latest`: the passing Attempts of the most recent Semester
 * that holds one, by Academic Year and then Semester; two in that Semester are both kept, which
 * keeps the answer independent of the order the Attempts are listed in.
 *
 * Only passing Attempts are ever in the answer, so a failed retake after a pass changes nothing:
 * the policy chooses *which passing grade* counts, never *whether* the Course was passed.
 */
export function countingAttempts<A extends AttemptFacts>(attempts: readonly A[], policies: Policies): A[] {
  const passing = attempts.filter((a) => DECIDED.has(a.status) && passes(a, policies.passingGrade));
  if (policies.gradeAttempt === "best" || passing.length === 0) return passing;
  const latest = Math.max(...passing.map(semesterIndex));
  return passing.filter((a) => semesterIndex(a) === latest);
}

/** Where a student stands with one Course, by its canonical course number. */
export interface Standing {
  completed: boolean;
  projected: boolean;
  /** The course numbers the student's Attempts were written with, before Equivalences. */
  origins: string[];
}

/**
 * Each attempted Course, by canonical course number, and whether it counts in each lens.
 *
 * `completed`: some decided Attempt passed, under the file's passing grade. The `gradeAttempt`
 * policy does not enter into it: `latest` is the latest *passing* Attempt, as ADR-0009 words it,
 * so a pass followed by a failed retake is still a pass under either policy (#327). A planned or
 * registered Attempt decides nothing in this lens.
 *
 * `projected`: completed, or a planned or registered Attempt says the plan will complete it.
 */
export function standings(program: CompiledProgram, attempts: readonly AttemptFacts[]): Map<string, Standing> {
  const byCourse = new Map<string, AttemptFacts[]>();
  for (const attempt of attempts) {
    const course = program.canonical(attempt.courseNumber);
    byCourse.set(course, [...(byCourse.get(course) ?? []), attempt]);
  }

  const result = new Map<string, Standing>();
  for (const [course, list] of byCourse) {
    const completed = countingAttempts(list, program.file.policies).length > 0;
    const origins = [...new Set(list.map((a) => a.courseNumber))].sort();
    result.set(course, {
      completed,
      projected: completed || list.some((a) => PENDING.has(a.status)),
      origins,
    });
  }
  return result;
}

// --- Scoring ----------------------------------------------------------------------------------

/** Which courses count at each leaf: node index to canonical course numbers. */
export type Placements = ReadonlyMap<number, readonly string[]>;

/** What one node adds up to under one set of placements. */
export interface NodeOutcome {
  status: RequirementStatus;
  /** Courses counting anywhere in the node's subtree, sorted. */
  courses: string[];
  /**
   * `credits` and `total`: the credits counted. `cap`: the credits of its Pool counted below its
   * parent.
   */
  counted: number;
  /** `cap` only: the credits of its Pool its limit kept from counting. */
  cut: number;
  /** `allOf` and `nOf`: children met, and how many are needed. */
  met: number;
  needed: number;
}

/** A cap or exclusive limits; it never demands. These are left out of their parent's count. */
function isLimit(requirement: Requirement | undefined): boolean {
  return requirement?.kind === "cap" || requirement?.kind === "exclusive";
}

/**
 * What a set of placements adds up to, node by node, in preorder.
 *
 * Placements are trusted: the caller has already checked that each leaf accepts its courses and
 * that no course counts twice where it may not. Then, in order:
 *
 * 1. Each `exclusive` keeps one of its Courses below its parent, the first it meets walking the
 *    leaves in preorder and each leaf's courses in course-number order, and takes the others off
 *    every leaf there.
 * 2. Each `credits` leaf, in preorder, counts its courses' credits in course-number order. A
 *    course in the Pool of a `cap` whose parent holds the leaf counts only as much as every such
 *    cap has left, so a Course can count in part.
 * 3. Each `total` counts the credits of every course in `counted`, or of those in its Pool, each
 *    once and in full: it takes no placement, so neither the Assignment nor a cap nor an
 *    exclusive changes it (#328).
 * 4. Statuses are settled from the leaves up.
 *
 * `relaxed` skips step 1, and in step 2 lets each leaf count capped credits up to the sum of the
 * maxima over it, as if no other leaf had used any. More placements then never mean fewer
 * satisfied nodes, and no Assignment counts more at any leaf than this does, which is what makes
 * the result an upper bound the solver can prune against.
 */
export function score(
  program: CompiledProgram,
  placements: Placements,
  ticked: ReadonlySet<string>,
  counted: readonly string[],
  relaxed = false,
): NodeOutcome[] {
  const { nodes } = program;
  const placed = new Map<number, string[]>();
  for (const [leaf, courses] of placements) placed.set(leaf, [...courses].sort());

  const outcomes: NodeOutcome[] = nodes.map(() => ({
    status: "missing",
    courses: [],
    counted: 0,
    cut: 0,
    met: 0,
    needed: 0,
  }));

  if (!relaxed) {
    for (const exclusive of program.exclusives) {
      const requirement = nodes[exclusive]!.requirement;
      if (requirement?.kind !== "exclusive") continue;
      const listed = new Set(requirement.courses.map(program.canonical));
      const scope = nodes[nodes[exclusive]!.parent]!;
      let kept: string | undefined;
      for (let leaf = scope.index; leaf < scope.end; leaf++) {
        const courses = placed.get(leaf);
        if (!courses) continue;
        placed.set(
          leaf,
          courses.filter((course) => {
            if (!listed.has(course)) return true;
            kept ??= course;
            return course === kept;
          }),
        );
      }
      if (kept !== undefined) outcomes[exclusive]!.courses = [kept];
    }
  }

  const remaining = new Map<number, number>();
  for (const cap of program.caps) {
    const requirement = nodes[cap]!.requirement;
    if (requirement?.kind === "cap") remaining.set(cap, requirement.max);
  }

  for (const node of nodes) {
    const requirement = node.requirement;
    if (requirement?.kind !== "credits") continue;
    const outcome = outcomes[node.index]!;
    const capsHere = program.caps.filter((cap) => within(program, nodes[cap]!.parent, node.index));
    const limitsOf = (course: string) =>
      capsHere.filter((cap) => {
        const capRequirement = nodes[cap]!.requirement;
        return capRequirement?.kind === "cap" && program.poolHas(capRequirement.pool, course);
      });

    if (relaxed) {
      // However the caps' budgets are shared out, the credits of capped courses that count at
      // this one leaf never exceed the sum of the maxima of the caps over it. Free courses count
      // in full. Both only grow with more placements, so the bound stays a bound.
      let free = 0;
      let capped = 0;
      for (const course of placed.get(node.index) ?? []) {
        const full = program.credits(course) ?? 0;
        if (limitsOf(course).length === 0) free += full;
        else capped += full;
      }
      const ceiling = capsHere.reduce((sum, cap) => {
        const capRequirement = nodes[cap]!.requirement;
        return sum + (capRequirement?.kind === "cap" ? capRequirement.max : 0);
      }, 0);
      outcome.counted = free + Math.min(capped, ceiling);
      continue;
    }

    for (const course of placed.get(node.index) ?? []) {
      const full = program.credits(course) ?? 0;
      const limits = limitsOf(course);
      const allowed = Math.min(full, ...limits.map((cap) => remaining.get(cap)!));
      for (const cap of limits) {
        remaining.set(cap, remaining.get(cap)! - allowed);
        outcomes[cap]!.counted += allowed;
        outcomes[cap]!.cut += full - allowed;
      }
      outcome.counted += allowed;
    }
  }

  for (const node of nodes) {
    const requirement = node.requirement;
    if (requirement?.kind !== "total") continue;
    const outcome = outcomes[node.index]!;
    outcome.courses = counted.filter(
      (course) => requirement.pool === undefined || program.poolHas(requirement.pool, course),
    );
    outcome.counted = outcome.courses.reduce((sum, course) => sum + (program.credits(course) ?? 0), 0);
  }

  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!;
    const requirement = node.requirement;
    const outcome = outcomes[index]!;
    const courses = new Set<string>([...outcome.courses, ...(placed.get(index) ?? [])]);

    if (requirement === undefined || requirement.kind === "allOf" || requirement.kind === "nOf") {
      const demands = node.children.filter((child) => !isLimit(nodes[child]!.requirement));
      outcome.met = demands.filter((child) => outcomes[child]!.status === "satisfied").length;
      outcome.needed = requirement?.kind === "nOf" ? requirement.n : demands.length;
      const progressing = demands.some((child) => outcomes[child]!.status !== "missing");
      outcome.status =
        outcome.met >= outcome.needed ? "satisfied" : progressing ? "partial" : "missing";
      for (const child of node.children) for (const c of outcomes[child]!.courses) courses.add(c);
    } else if (requirement.kind === "course") {
      outcome.status = courses.size > 0 ? "satisfied" : "missing";
    } else if (requirement.kind === "credits" || requirement.kind === "total") {
      outcome.status =
        outcome.counted >= requirement.min
          ? "satisfied"
          : outcome.counted > 0
            ? "partial"
            : "missing";
    } else if (requirement.kind === "manual") {
      outcome.status = ticked.has(requirement.id) ? "satisfied" : "missing";
    } else {
      outcome.status = "satisfied";
    }
    outcome.courses = [...courses].sort();
  }

  return outcomes;
}
