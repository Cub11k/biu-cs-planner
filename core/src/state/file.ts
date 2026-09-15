import { z } from "zod";
import type { Semester } from "../catalog/schema.ts";
import { migrateForward, type Migrations } from "./migrate.ts";
import {
  attemptSchema,
  blockedTimeSchema,
  CURRENT_STATE_SCHEMA_VERSION,
  pickSchema,
  pinSchema,
  settingsSchema,
  stateSchema,
  timetableHeadSchema,
  variantHeadSchema,
  type BlockedTime,
  type Pick,
  type Settings,
  type State,
  type Timetable,
  type Variant,
} from "./schema.ts";
import { findUnsafeKey } from "./unsafe-keys.ts";

export type StateFileWarning =
  /** Not a State File at all: no object, or no `schemaVersion` to go on. */
  | { kind: "file-unreadable" }
  | { kind: "schema-version-too-new"; found: number }
  | { kind: "schema-version-unsupported"; found: number }
  | { kind: "migration-failed"; found: number; version: number }
  | { kind: "unsafe-key"; key: string; at: string }
  /**
   * One entry of a list could not be read and was left out. `field` names the part that was
   * wrong; it is absent when the entry was not the right shape at all — a Pin written as a
   * bare string rather than an object, say — because then no one field is to blame.
   */
  | { kind: "entry-dropped"; at: string; field?: string }
  /** Something that should have been a list was not, so it was read as an empty one. */
  | { kind: "list-unreadable"; at: string }
  /** One setting could not be read and kept its default; absent `field` means all of them. */
  | { kind: "settings-unreadable"; field?: string }
  | { kind: "primary-variant-not-unique"; at: string; primaries: number }
  | { kind: "blocked-time-semester-mismatch"; at: string; semester: Semester }
  | { kind: "blocked-time-does-not-advance"; at: string; start: string; end: string }
  | { kind: "pick-not-unique"; at: string; courseNumber: string; lessonType: string };

/**
 * Migrations that bring an older State File up to the current version, keyed by the version
 * they read. There are none yet because there has only ever been one version; each new
 * version adds the migration that reads the version before it.
 */
const STATE_MIGRATIONS: Migrations = {};

const versionProbe = z.object({ schemaVersion: z.number() });

/**
 * JSON Schema for a State File, so a hand-edited file gets autocomplete and inline errors in
 * an editor. Generated from the Zod schema, never maintained by hand. It describes the file
 * as written rather than as read (`io: "input"`), so the fields a new State File leaves out
 * — everything but the version — are not flagged as missing.
 */
export function stateJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(stateSchema, { io: "input" }) as Record<string, unknown>;
}

/**
 * The path of the first thing Zod objected to, relative to the value it was given, or nothing
 * when it objected to the value itself rather than to a part of it.
 */
function fieldOf(error: z.ZodError): string | undefined {
  const path = error.issues[0]?.path;
  return path && path.length > 0 ? path.map(String).join(".") : undefined;
}

/** An `entry-dropped` Warning carrying a field only when one field is to blame. */
function dropped(at: string, error: z.ZodError): StateFileWarning {
  const field = fieldOf(error);
  return field === undefined
    ? { kind: "entry-dropped", at }
    : { kind: "entry-dropped", at, field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a list entry by entry, keeping what it can. A list that is missing is an empty one; a
 * list that is not a list is reported and read as empty; an entry `read` cannot make sense of
 * is left out. Nothing here throws, and nothing here loses more of the file than it has to.
 */
function readList<T>(
  raw: unknown,
  at: string,
  warnings: StateFileWarning[],
  read: (entry: unknown, entryAt: string) => T | undefined,
): T[] {
  // Only a missing list is an empty one. `null` is something a hand edit or another tool
  // wrote, and reading it as "no Attempts" would let autosave overwrite a whole Plan with
  // `[]` and never say so — the one shape that could lose everything quietly.
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push({ kind: "list-unreadable", at });
    return [];
  }
  const kept: T[] = [];
  raw.forEach((entry, index) => {
    const value = read(entry, `${at}[${index}]`);
    if (value !== undefined) kept.push(value);
  });
  return kept;
}

/** `readList` for a list whose entries are wholly described by one schema. */
function readEach<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  at: string,
  warnings: StateFileWarning[],
): T[] {
  return readList(raw, at, warnings, (entry, entryAt) => {
    const parsed = schema.safeParse(entry);
    if (parsed.success) return parsed.data;
    warnings.push(dropped(entryAt, parsed.error));
    return undefined;
  });
}

/**
 * A Pick is the choice of one Group for one Lesson Type of an Offering within a Variant, so
 * two Picks naming the same Course and Lesson Type describe a week that cannot be drawn: the
 * grid would ink both Groups while the Tray chip can hold only one Group number. The Picks
 * are kept — a Warning never costs a student what they chose — and the pair is named.
 */
function checkPicksUnique(picks: Pick[], at: string, warnings: StateFileWarning[]): void {
  const seen = new Set<string>();
  for (const pick of picks) {
    const slot = `${pick.courseNumber}\u0000${pick.lessonType}`;
    if (seen.has(slot)) {
      warnings.push({
        kind: "pick-not-unique",
        at,
        courseNumber: pick.courseNumber,
        lessonType: pick.lessonType,
      });
      continue;
    }
    seen.add(slot);
  }
}

function readVariant(
  raw: unknown,
  at: string,
  warnings: StateFileWarning[],
): Variant | undefined {
  const head = variantHeadSchema.safeParse(raw);
  if (!head.success) {
    warnings.push(dropped(at, head.error));
    return undefined;
  }
  // The head parse just proved `raw` is an object; the cast only tells the compiler so.
  const source = raw as Record<string, unknown>;
  const picks = readEach(pickSchema, source.picks, `${at}.picks`, warnings);
  checkPicksUnique(picks, at, warnings);
  return { ...head.data, picks };
}

/**
 * Exactly one Variant of a Timetable is primary. A file that breaks it opens anyway — a
 * Warning never blocks an edit — but a Timetable with no Variants yet is not a breach.
 */
function checkPrimary(variants: Variant[], at: string, warnings: StateFileWarning[]): void {
  if (variants.length === 0) return;
  const primaries = variants.filter((variant) => variant.primary).length;
  if (primaries !== 1) {
    warnings.push({ kind: "primary-variant-not-unique", at, primaries });
  }
}

/**
 * A Blocked Time carries its own Semester, because the Clashes module reads it on its own
 * and needs one. That makes it possible for it to disagree with the Timetable holding it,
 * which usually means a Blocked Time was copied to another Semester without being retimed.
 */
function checkBlockedSemesters(
  blockedTimes: BlockedTime[],
  semester: Semester,
  at: string,
  warnings: StateFileWarning[],
): void {
  blockedTimes.forEach((blocked, index) => {
    if (blocked.semester !== semester) {
      warnings.push({
        kind: "blocked-time-semester-mismatch",
        at: `${at}[${index}]`,
        semester: blocked.semester,
      });
    }
  });
}

/**
 * A Blocked Time runs from `start` to `end` within one Day, the way a Meeting does. One that
 * ends at or before it starts — `23:00`–`01:00` for a night shift, or `10:00`–`10:00` — keeps
 * no time free at all, and would otherwise sit in the file looking like it did: whatever
 * compares it against the week finds an empty range and reports nothing. The entry is kept
 * rather than dropped, because a Warning never costs a student what they typed, but it is
 * named so the silence is broken.
 *
 * A period crossing midnight is therefore two Blocked Times, one either side of it. Whether
 * the product would rather have one row that wraps is a question this only defers: nothing
 * here forecloses it, since a wrapping reading would simply stop warning.
 */
function checkBlockedRanges(
  blockedTimes: BlockedTime[],
  at: string,
  warnings: StateFileWarning[],
): void {
  blockedTimes.forEach((blocked, index) => {
    if (blocked.end > blocked.start) return;
    warnings.push({
      kind: "blocked-time-does-not-advance",
      at: `${at}[${index}]`,
      start: blocked.start,
      end: blocked.end,
    });
  });
}

function readTimetable(
  raw: unknown,
  at: string,
  warnings: StateFileWarning[],
): Timetable | undefined {
  const head = timetableHeadSchema.safeParse(raw);
  if (!head.success) {
    warnings.push(dropped(at, head.error));
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const variants = readList(source.variants, `${at}.variants`, warnings, (entry, entryAt) =>
    readVariant(entry, entryAt, warnings),
  );
  const blockedTimes = readEach(
    blockedTimeSchema,
    source.blockedTimes,
    `${at}.blockedTimes`,
    warnings,
  );

  checkPrimary(variants, at, warnings);
  checkBlockedSemesters(blockedTimes, head.data.semester, `${at}.blockedTimes`, warnings);
  checkBlockedRanges(blockedTimes, `${at}.blockedTimes`, warnings);

  return { ...head.data, variants, blockedTimes };
}

/**
 * Settings are never worth losing a file over, and they are read one at a time for the same
 * reason a list is: a student reading Hebrew whose Exam spacing got corrupted should not also
 * find their language reset to English, which autosave would then write back as the truth.
 */
function readSettings(raw: unknown, warnings: StateFileWarning[]): Settings {
  const settings: Settings = settingsSchema.parse({});
  if (raw === undefined) return settings;
  if (!isRecord(raw)) {
    warnings.push({ kind: "settings-unreadable" });
    return settings;
  }

  const written = settings as Record<string, unknown>;
  for (const [field, fieldSchema] of Object.entries(settingsSchema.shape)) {
    if (raw[field] === undefined) continue;
    const parsed = fieldSchema.safeParse(raw[field]);
    if (parsed.success) written[field] = parsed.data;
    else warnings.push({ kind: "settings-unreadable", field });
  }
  return settings;
}

function readState(raw: Record<string, unknown>, warnings: StateFileWarning[]): State {
  return {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: readEach(attemptSchema, raw.attempts, "attempts", warnings),
    timetables: readList(raw.timetables, "timetables", warnings, (entry, at) =>
      readTimetable(entry, at, warnings),
    ),
    pins: readEach(pinSchema, raw.pins, "pins", warnings),
    settings: readSettings(raw.settings, warnings),
  };
}

export type StateFileRead = { state?: State; warnings: StateFileWarning[] };

/**
 * The reading itself, with the migration table as a parameter. `parseStateFile` is the one
 * callers want; this exists so the version walk and the Warnings it produces are covered
 * before there is a real migration to walk, which is the whole reason the runner ships now.
 */
export function readStateFile(input: unknown, migrations: Migrations): StateFileRead {
  const unsafe = findUnsafeKey(input);
  if (unsafe) return { warnings: [{ kind: "unsafe-key", ...unsafe }] };

  const probe = versionProbe.safeParse(input);
  if (!probe.success) return { warnings: [{ kind: "file-unreadable" }] };

  const found = probe.data.schemaVersion;
  if (found > CURRENT_STATE_SCHEMA_VERSION) {
    return { warnings: [{ kind: "schema-version-too-new", found }] };
  }

  // How far back a file can be read is the chain of migrations itself: a version nothing
  // reads stops the walk, and that is what "unsupported" means. No second constant to keep
  // in step with the table, and so no way for the two to disagree.
  const migrated = migrateForward(input, found, CURRENT_STATE_SCHEMA_VERSION, migrations);
  if (!migrated.ok) {
    return migrated.reason === "no-migration"
      ? { warnings: [{ kind: "schema-version-unsupported", found }] }
      : { warnings: [{ kind: "migration-failed", found, version: migrated.version }] };
  }
  if (!isRecord(migrated.file)) return { warnings: [{ kind: "file-unreadable" }] };

  const warnings: StateFileWarning[] = [];
  return { state: readState(migrated.file, warnings), warnings };
}

/**
 * Reads a State File. Untrusted input: it never throws. A file this build cannot open at all
 * comes back as Warnings and nothing else; anything else comes back as a State plus Warnings
 * naming what was dropped on the way, because a student's own data is worth salvaging.
 */
export function parseStateFile(input: unknown): StateFileRead {
  return readStateFile(input, STATE_MIGRATIONS);
}
