import { z } from "zod";
import { findUnsafeKey } from "../state/unsafe-keys.ts";
import {
  cohortSchema,
  courseHeadSchema,
  courseSetSchema,
  CURRENT_REQUIREMENTS_SCHEMA_VERSION,
  deadlineSchema,
  doubleCountingSchema,
  equivalenceSchema,
  layoutEntrySchema,
  policiesSchema,
  poolSchema,
  prerequisiteNodeSchema,
  requirementNodeSchema,
  requirementsFileHeadSchema,
  requirementsFileSchema,
  trackHeadSchema,
  type DoubleCounting,
  type Equivalence,
  type Policies,
  type Prerequisite,
  type Requirement,
  type RequirementsCourse,
  type RequirementsFile,
  type Track,
} from "./schema.ts";

/** Which list an id is unique within. A Requirement id is unique across the whole file. */
export type IdNamespace = "requirement" | "track" | "pool" | "course-set" | "course" | "equivalence";

export type RequirementsFileWarning =
  /** Not a Requirements File at all: no object, or no readable version and Program. */
  | { kind: "file-unreadable" }
  | { kind: "schema-version-too-new"; found: number }
  | { kind: "schema-version-unsupported"; found: number }
  | { kind: "unsafe-key"; key: string; at: string }
  /**
   * One entry could not be read and was left out. `field` names the part that was wrong, and is
   * absent when the entry was not an object at all, because then no one field is to blame.
   */
  | { kind: "entry-dropped"; at: string; field?: string }
  /** Something that should have been a list was not, so it was read as an empty one. */
  | { kind: "list-unreadable"; at: string }
  /** A part of `policies` or `doubleCounting` kept its default; no `field` means all of it. */
  | { kind: "section-unreadable"; at: "policies" | "doubleCounting"; field?: string }
  /** A Requirement or Prerequisite nested deeper than `MAX_DEPTH`, left out with what it holds. */
  | { kind: "nested-too-deep"; at: string }
  /**
   * A second entry with an id already taken. The first is kept and this one is left out, so a
   * Pin naming the id resolves to exactly one Requirement.
   */
  | { kind: "duplicate-id"; namespace: IdNamespace; id: string; at: string; first: string }
  | { kind: "unknown-pool"; at: string; pool: string }
  | { kind: "unknown-course-set"; at: string; set: string }
  | { kind: "unknown-requirement"; at: string; id: string }
  /**
   * Equivalences that lead back to where they started. Kept, and every course number in the
   * loop is read as its smallest member, which is the same answer from wherever the loop is
   * entered; `course` is that member and `at` the first entry of the loop.
   */
  | { kind: "equivalence-loop"; at: string; course: string }
  /** A Course whose credits the file does not give: it counts as zero credits until it does. */
  | { kind: "course-credits-missing"; at: string; course: string };

export type RequirementsFileRead = {
  file?: RequirementsFile;
  warnings: RequirementsFileWarning[];
};

/**
 * How deep a Requirement or Prerequisite may nest, counting the top level as 1. Real degree
 * rules are a few levels deep; the limit exists because the file is untrusted input and the
 * reader, like the engine after it, walks the tree by recursion. A file nested thousands deep
 * would otherwise exhaust the stack, and a reader that throws on the input it exists to judge
 * is worse than one that stops and says so.
 */
export const MAX_DEPTH = 32;

const versionProbe = z.object({ schemaVersion: z.number() });

/**
 * JSON Schema for a Requirements File, so a maintainer writing one by hand gets completion and
 * inline errors. Generated from the Zod schema, never maintained by hand. It describes the file
 * as written (`io: "input"`), so the parts with defaults are not flagged as missing.
 */
export function requirementsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(requirementsFileSchema, { io: "input" }) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first field Zod objected to, or nothing when it objected to the value as a whole. */
function fieldOf(error: z.ZodError): string | undefined {
  const path = error.issues[0]?.path;
  return path && path.length > 0 ? path.map(String).join(".") : undefined;
}

/**
 * Everything one read accumulates: the Warnings, and where each id was first seen, so a later
 * duplicate can name the entry it collides with.
 */
class Reading {
  readonly warnings: RequirementsFileWarning[] = [];
  private readonly seen = new Map<string, string>();
  /**
   * Where each kept entry was read from. The checks that run after reading name an entry by
   * this, not by its index in the kept lists, which shifts once an earlier entry is left out.
   */
  readonly where = new WeakMap<object, string>();

  dropped(at: string, error: z.ZodError): void {
    const field = fieldOf(error);
    this.warnings.push(
      field === undefined ? { kind: "entry-dropped", at } : { kind: "entry-dropped", at, field },
    );
  }

  /** True when the id is new in its namespace; otherwise reports the duplicate. */
  claim(namespace: IdNamespace, id: string, at: string): boolean {
    const key = `${namespace}\u0000${id}`;
    const first = this.seen.get(key);
    if (first !== undefined) {
      this.warnings.push({ kind: "duplicate-id", namespace, id, at, first });
      return false;
    }
    this.seen.set(key, at);
    return true;
  }

  /**
   * Reads a list entry by entry, keeping what it can. Only a missing list is an empty one; a
   * value that is not a list is reported and read as empty, and an entry `read` cannot make
   * sense of is left out.
   */
  list<T>(raw: unknown, at: string, read: (entry: unknown, entryAt: string) => T | undefined): T[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      this.warnings.push({ kind: "list-unreadable", at });
      return [];
    }
    const kept: T[] = [];
    raw.forEach((entry, index) => {
      const value = read(entry, `${at}[${index}]`);
      if (value === undefined) return;
      if (typeof value === "object" && value !== null) this.where.set(value, `${at}[${index}]`);
      kept.push(value);
    });
    return kept;
  }

  /** `list` for entries wholly described by one schema. */
  each<T>(schema: z.ZodType<T>, raw: unknown, at: string): T[] {
    return this.list(raw, at, (entry, entryAt) => {
      const parsed = schema.safeParse(entry);
      if (parsed.success) return parsed.data;
      this.dropped(entryAt, parsed.error);
      return undefined;
    });
  }

  /** `each`, keeping only the first entry for each id. */
  unique<T>(
    schema: z.ZodType<T>,
    raw: unknown,
    at: string,
    namespace: IdNamespace,
    idOf: (entry: T) => string,
  ): T[] {
    return this.list(raw, at, (entry, entryAt) => {
      const parsed = schema.safeParse(entry);
      if (!parsed.success) {
        this.dropped(entryAt, parsed.error);
        return undefined;
      }
      return this.claim(namespace, idOf(parsed.data), entryAt) ? parsed.data : undefined;
    });
  }

  requirement(raw: unknown, at: string, depth: number): Requirement | undefined {
    if (depth > MAX_DEPTH) {
      this.warnings.push({ kind: "nested-too-deep", at });
      return undefined;
    }
    const parsed = requirementNodeSchema.safeParse(raw);
    if (!parsed.success) {
      this.dropped(at, parsed.error);
      return undefined;
    }
    const node = parsed.data;
    if (!this.claim("requirement", node.id, at)) return undefined;
    if (node.kind !== "allOf" && node.kind !== "nOf") return node;

    const of = this.list(node.of, `${at}.of`, (child, childAt) =>
      this.requirement(child, childAt, depth + 1),
    );
    return { ...node, of };
  }

  prerequisite(raw: unknown, at: string, depth: number): Prerequisite | undefined {
    if (depth > MAX_DEPTH) {
      this.warnings.push({ kind: "nested-too-deep", at });
      return undefined;
    }
    const parsed = prerequisiteNodeSchema.safeParse(raw);
    if (!parsed.success) {
      this.dropped(at, parsed.error);
      return undefined;
    }
    const node = parsed.data;
    if (node.kind !== "allOf" && node.kind !== "anyOf") return node;

    const of = this.list(node.of, `${at}.of`, (child, childAt) =>
      this.prerequisite(child, childAt, depth + 1),
    );
    return { ...node, of };
  }

  course(raw: unknown, at: string): RequirementsCourse | undefined {
    const head = courseHeadSchema.safeParse(raw);
    if (!head.success) {
      this.dropped(at, head.error);
      return undefined;
    }
    if (!this.claim("course", head.data.number, at)) return undefined;
    if (head.data.credits === undefined) {
      this.warnings.push({ kind: "course-credits-missing", at, course: head.data.number });
    }
    const source = (raw as Record<string, unknown>).prerequisites;
    if (source === undefined) return head.data;

    const prerequisites = this.prerequisite(source, `${at}.prerequisites`, 1);
    if (prerequisites === undefined) return head.data;
    this.where.set(prerequisites, `${at}.prerequisites`);
    return { ...head.data, prerequisites };
  }

  track(raw: unknown, at: string): Track | undefined {
    const head = trackHeadSchema.safeParse(raw);
    if (!head.success) {
      this.dropped(at, head.error);
      return undefined;
    }
    if (!this.claim("track", head.data.id, at)) return undefined;
    const requirements = this.list(
      (raw as Record<string, unknown>).requirements,
      `${at}.requirements`,
      (entry, entryAt) => this.requirement(entry, entryAt, 1),
    );
    return { ...head.data, requirements };
  }

  /**
   * A section of named fields read one field at a time, so a bad value costs that field its
   * default and nothing else, the way the State File reads its settings.
   */
  section<T extends Record<string, unknown>>(
    schema: z.ZodObject,
    raw: unknown,
    at: "policies" | "doubleCounting",
    readField: (field: string, value: unknown) => { ok: true; value: unknown } | { ok: false },
  ): T {
    const section = schema.parse({}) as Record<string, unknown>;
    if (raw === undefined) return section as T;
    if (!isRecord(raw)) {
      this.warnings.push({ kind: "section-unreadable", at });
      return section as T;
    }
    for (const field of Object.keys(schema.shape)) {
      if (raw[field] === undefined) continue;
      const read = readField(field, raw[field]);
      if (read.ok) section[field] = read.value;
      else this.warnings.push({ kind: "section-unreadable", at, field });
    }
    return section as T;
  }
}

function readPolicies(raw: unknown, reading: Reading): Policies {
  return reading.section<Policies>(policiesSchema, raw, "policies", (field, value) => {
    const parsed = (policiesSchema.shape as Record<string, z.ZodType>)[field]!.safeParse(value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
  });
}

function readDoubleCounting(raw: unknown, reading: Reading): DoubleCounting {
  const shape = doubleCountingSchema.shape;
  return reading.section<DoubleCounting>(doubleCountingSchema, raw, "doubleCounting", (field, value) => {
    if (field === "within") {
      return {
        ok: true,
        value: reading.each(shape.within.unwrap().element, value, "doubleCounting.within"),
      };
    }
    const parsed = shape.acrossPrograms.safeParse(value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
  });
}

/** Every Requirement in a tree, in file order. */
function* walk(requirements: readonly Requirement[]): Generator<Requirement> {
  for (const node of requirements) {
    yield node;
    if (node.kind === "allOf" || node.kind === "nOf") yield* walk(node.of);
  }
}

function* walkPrerequisites(prerequisite: Prerequisite): Generator<Prerequisite> {
  yield prerequisite;
  if (prerequisite.kind === "allOf" || prerequisite.kind === "anyOf") {
    for (const child of prerequisite.of) yield* walkPrerequisites(child);
  }
}

/**
 * Equivalences whose chain comes back to where it started, each loop reported once, at its
 * first entry in the file.
 */
function checkEquivalenceLoops(
  equivalences: readonly Equivalence[],
  where: (entry: object) => string,
  warnings: RequirementsFileWarning[],
): void {
  const next = new Map(equivalences.map((e) => [e.from, e.to]));
  const reported = new Set<string>();
  for (const equivalence of equivalences) {
    if (reported.has(equivalence.from)) continue;
    const chain = [equivalence.from];
    let current = equivalence.to;
    while (next.has(current) && !chain.includes(current)) {
      chain.push(current);
      current = next.get(current)!;
    }
    if (current !== equivalence.from) continue;
    for (const member of chain) reported.add(member);
    warnings.push({ kind: "equivalence-loop", at: where(equivalence), course: [...chain].sort()[0]! });
  }
}

/**
 * The checks that need the whole file: a name used before, after or nowhere near where it is
 * defined is only known to be dangling once everything has been read. The node is kept either
 * way; an undefined Pool matches no Course, and an undefined Course set holds none.
 *
 * Each Warning names the entry where it was read from, so leaving an earlier entry out does not
 * shift the location a maintainer is sent to.
 */
function checkReferences(file: RequirementsFile, reading: Reading): void {
  const warnings = reading.warnings;
  const where = (entry: object) => reading.where.get(entry) ?? "";
  const pools = new Set(file.pools.map((pool) => pool.id));
  const sets = new Set(file.courseSets.map((set) => set.id));
  const requirementIds = new Set<string>();

  for (const tree of [file.requirements, ...file.tracks.map((track) => track.requirements)]) {
    for (const node of walk(tree)) {
      requirementIds.add(node.id);
      if ((node.kind === "credits" || node.kind === "cap") && !pools.has(node.pool)) {
        warnings.push({ kind: "unknown-pool", at: where(node), pool: node.pool });
      }
    }
  }

  for (const course of file.courses) {
    if (course.prerequisites === undefined) continue;
    for (const node of walkPrerequisites(course.prerequisites)) {
      if (node.kind === "set" && !sets.has(node.set)) {
        warnings.push({ kind: "unknown-course-set", at: where(node), set: node.set });
      }
    }
  }

  for (const permission of file.doubleCounting.within) {
    const at = where(permission);
    for (const id of permission.requirements) {
      if (!requirementIds.has(id)) warnings.push({ kind: "unknown-requirement", at, id });
    }
    if (permission.pool !== undefined && !pools.has(permission.pool)) {
      warnings.push({ kind: "unknown-pool", at, pool: permission.pool });
    }
  }
  const across = file.doubleCounting.acrossPrograms?.pool;
  if (across !== undefined && !pools.has(across)) {
    warnings.push({ kind: "unknown-pool", at: "doubleCounting.acrossPrograms", pool: across });
  }

  checkEquivalenceLoops(file.equivalences, where, warnings);
}

/**
 * Reads a Requirements File. Untrusted input, possibly written by someone else: it never throws
 * and never executes anything from the file. A file this build cannot open at all (no readable
 * head, a prototype-shaped key, or a version it does not read) comes back as Warnings and nothing
 * else; anything else comes back as a Requirements File plus Warnings
 * naming what was left out on the way, because one typo should not cost a student the whole
 * Program.
 */
export function parseRequirementsFile(input: unknown): RequirementsFileRead {
  const unsafe = findUnsafeKey(input);
  if (unsafe) return { warnings: [{ kind: "unsafe-key", ...unsafe }] };

  const probe = versionProbe.safeParse(input);
  if (!probe.success) return { warnings: [{ kind: "file-unreadable" }] };

  const found = probe.data.schemaVersion;
  if (found > CURRENT_REQUIREMENTS_SCHEMA_VERSION) {
    return { warnings: [{ kind: "schema-version-too-new", found }] };
  }
  // There has only ever been one version, so anything older is a version nothing reads. The
  // first format change adds a migration table here, as `../state/file.ts` has.
  if (found < CURRENT_REQUIREMENTS_SCHEMA_VERSION) {
    return { warnings: [{ kind: "schema-version-unsupported", found }] };
  }

  const head = requirementsFileHeadSchema.safeParse(input);
  if (!head.success) return { warnings: [{ kind: "file-unreadable" }] };

  const raw = input as Record<string, unknown>;
  const reading = new Reading();
  const file: RequirementsFile = {
    ...head.data,
    cohorts: reading.each(cohortSchema, raw.cohorts, "cohorts"),
    policies: readPolicies(raw.policies, reading),
    pools: reading.unique(poolSchema, raw.pools, "pools", "pool", (pool) => pool.id),
    courseSets: reading.unique(courseSetSchema, raw.courseSets, "courseSets", "course-set", (set) => set.id),
    courses: reading.list(raw.courses, "courses", (entry, at) => reading.course(entry, at)),
    equivalences: reading.unique(
      equivalenceSchema,
      raw.equivalences,
      "equivalences",
      "equivalence",
      (equivalence) => equivalence.from,
    ),
    requirements: reading.list(raw.requirements, "requirements", (entry, at) =>
      reading.requirement(entry, at, 1),
    ),
    tracks: reading.list(raw.tracks, "tracks", (entry, at) => reading.track(entry, at)),
    doubleCounting: readDoubleCounting(raw.doubleCounting, reading),
    suggestedLayout: reading.each(layoutEntrySchema, raw.suggestedLayout, "suggestedLayout"),
    deadlines: reading.each(deadlineSchema, raw.deadlines, "deadlines"),
  };

  checkReferences(file, reading);
  return { file, warnings: reading.warnings };
}
