import { z } from "zod";
import type { Semester } from "../catalog/schema.ts";
import { clockAsEnd, clockAsStart } from "../clock.ts";
import { migrateForward, type Migrations } from "./migrate.ts";
import {
  attemptSchema,
  blockedTimeSchema,
  CURRENT_STATE_SCHEMA_VERSION,
  groupPickSchema,
  pinSchema,
  settingsSchema,
  stateSchema,
  timetableHeadSchema,
  variantHeadSchema,
  type BlockedTime,
  type GroupPick,
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
  | { kind: "pick-not-unique"; at: string; courseNumber: string; lessonType: string }
  | { kind: "timetable-not-unique"; at: string; academicYear: number; semester: Semester };

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
function checkPicksUnique(picks: GroupPick[], at: string, warnings: StateFileWarning[]): void {
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
  const picks = readEach(groupPickSchema, source.picks, `${at}.picks`, warnings);
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
 * The two ends are read as minutes, in their own positions, rather than compared as strings:
 * as an `end`, `00:00` is the end of the Day, so `22:00`–`00:00` keeps the evening free and
 * `00:00`–`00:00` keeps the whole Day (issue #48). String comparison called both of those
 * empty and warned about the one spelling that says what the student meant. The reading is
 * `core/src/clock.ts`, the same one the Clashes module uses — neither module imports the
 * other, and this is why they still agree.
 *
 * A period crossing midnight is therefore still two Blocked Times, one either side of it, as
 * `CONTEXT.md` has it: `23:00`–`00:00` on one Day and `00:00`–`01:00` on the next.
 *
 * A time neither reading can place cannot reach here: `blockedTimeSchema` carries the same
 * pattern `core/src/clock.ts` reads with, so `readEach` has already refused the entry and
 * reported `entry-dropped` naming the field. That Warning is where the cause is named — where it
 * is, rather than what it was — and it is named once: an unreadable clock is reported where it is
 * refused and never downstream of that refusal. It is also the one Blocked Time a student does
 * lose, dropped by the schema rather than kept the way the rest of this check keeps them.
 *
 * The Clashes module gives the same account from the other side: it refuses nothing, so it says
 * nothing, and a span arriving there unreadable is a schema bug to fix at the schema (`overlapOf`
 * in `core/src/timetable/clashes.ts`, `meetingsOccupyingNoTime` in `core/src/shoham/overlaps.ts`,
 * issues #71 and #78). The second withholds even a does-not-advance report for such a span, and
 * what differs there is the Warning rather than the rule: its `EmptyRangeShape` would have to say
 * *which* empty shape the span has, and #52 has the two shapes pointing at different causes, so
 * naming one would be a guess. This Warning carries no shape, only the two strings as written.
 *
 * So the guard below is defence against this file and the schema ever reading a clock
 * differently, not the report of an unreadable clock — and `blocked-time-does-not-advance` is
 * not the wrong Warning for one either. It names what happened to the student's week — this
 * Blocked Time frees no time — which is as true of a range nothing can place as it is of
 * `10:00`–`10:00`, and more use to them than naming which of two internal readings failed.
 * ADR-0012 called it the wrong Warning until issue #82 reconciled the two records.
 */
function checkBlockedRanges(
  blockedTimes: BlockedTime[],
  at: string,
  warnings: StateFileWarning[],
): void {
  blockedTimes.forEach((blocked, index) => {
    const start = clockAsStart(blocked.start);
    const end = clockAsEnd(blocked.end);
    if (start !== undefined && end !== undefined && end > start) return;

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

/**
 * A Timetable is the weekly schedule work for one Semester of one Academic Year, so a second
 * one for the same pair splits a student's Variants across two places that nothing
 * distinguishes: whatever asks for "the Timetable for 2027 Fall" gets one of them, and the
 * Variants in the other are invisible. Both are kept and the pair is named.
 */
function checkTimetablesUnique(
  timetables: Timetable[],
  warnings: StateFileWarning[],
): void {
  const seen = new Set<string>();
  timetables.forEach((timetable, index) => {
    const slot = `${timetable.academicYear}\u0000${timetable.semester}`;
    if (seen.has(slot)) {
      warnings.push({
        kind: "timetable-not-unique",
        at: `timetables[${index}]`,
        academicYear: timetable.academicYear,
        semester: timetable.semester,
      });
      return;
    }
    seen.add(slot);
  });
}

function readState(raw: Record<string, unknown>, warnings: StateFileWarning[]): State {
  const timetables = readList(raw.timetables, "timetables", warnings, (entry, at) =>
    readTimetable(entry, at, warnings),
  );
  checkTimetablesUnique(timetables, warnings);

  return {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: readEach(attemptSchema, raw.attempts, "attempts", warnings),
    timetables,
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

/**
 * A State File value this build could not read back, which `writeStateFile` refuses. Named
 * rather than a bare `Error` so that whatever routes a save can tell it from a disk that
 * would not take the file: this one is a bug in the caller and never the student's doing, and
 * turning it into a Warning is the API's job (docs/design.md, "API and data rules").
 */
export class StateFileUnwritableError extends Error {
  override readonly name = "StateFileUnwritableError";
  /** The part of the value the schema objected to, or the file itself. */
  readonly at: string;

  constructor(at: string) {
    super(`refusing to write a State File this build could not read back: ${at}`);
    this.at = at;
  }
}

/**
 * Which revision of a State File a save was based on.
 *
 * Opaque by intent rather than by the type system: it is a bare alias, so any string passes,
 * and treating it as anything but a token to hand back is a mistake the compiler will not
 * catch. `docs/design.md`, "External edits" has each save carry the version of
 * the file it was based on so the server can refuse an overwrite of a file that changed on
 * disk meanwhile — Dropbox, git, an editor — and what identifies a revision is that guard's
 * decision, not this module's: reading a file is the only way to produce one and this module
 * performs no I/O. It is neither the `schemaVersion` a file records nor the burst count
 * `watchWorkspace` serves, both of which are versions of something else (`app/src/changes.ts`
 * says the same thing from the other side).
 *
 * What fills it, decided by #90 and stated here only so nothing has to guess: the Workspace
 * adapter hashes the file's bytes as it reads them (`server/src/workspace.fs.ts`). That is
 * outside this module on purpose, and it is also why hashing could not have been done here —
 * `readStateFile` receives already-parsed JSON, so a hash taken in `core` would be a hash of
 * the document this reader *repaired*, and blind to an external edit that only damaged an
 * entry it drops.
 */
export type StateFileVersion = string;

/**
 * A save: the JSON to write, and the version of the file it was based on. They are produced
 * together so that no caller has to remember to ask for the version — `write` the JSON alone
 * and the external-edit guard has nothing to check, which is the overwrite it exists to refuse
 * (ADR-0013). And they are *consumed* together too, since #90: the Workspace port takes this
 * whole value (`Workspace.saveStateFile` in `app/src/workspace.ts`), so there is no way to
 * hand a State File's content to a Workspace without the revision it was based on.
 */
export type StateFileSave = {
  /** What a `Workspace` writes. Plain JSON values, detached from the State it came from. */
  json: Record<string, unknown>;
  /** `undefined` when the save is based on no file: this State File does not exist yet. */
  basedOn: StateFileVersion | undefined;
};

/**
 * Writes a State File — as a value. The Workspace port already promises an atomic write
 * (`app/src/workspace.ts`), so there is nothing to do here but produce what it stores, which
 * is also what makes the round trip through `parseStateFile` testable without a filesystem.
 *
 * **It takes the version the save is based on** (ADR-0013: the save path is the undo path, so
 * an undo is an ordinary guarded save and needs to carry a version exactly as a first-hand
 * edit does), and there is deliberately no second way to produce a State File's JSON. The
 * refusal itself is made where the file is — `saveStateFile` in the Workspace port, and both
 * of its adapters — because deciding whether the file is still the revision this was based on
 * means reading the file, which this module cannot do. `undefined` is the claim that the file
 * does not exist, and is refused when it does rather than being a way past the guard.
 *
 * The version *in* the file is the one this build reads, never the one the value arrived
 * carrying: a file that migrated forward on the way in is written back at the current
 * version, which is what stops the next build from migrating it a second time.
 *
 * Unlike the reader it is not forgiving, and for the opposite reason. A file is untrusted
 * input, so one unreadable Pick costs a Pick rather than the Variant holding it; the value
 * here is this app's own, so one the schema rejects is a bug in the caller. Writing it anyway
 * would cost the student whatever the next read then dropped, silently, so it throws instead.
 * Only a cast can get there — the argument is a `State` — and this is the assertion that says
 * so out loud rather than leaving it to the type system.
 */
export function writeStateFile(
  state: State,
  save: { basedOn: StateFileVersion | undefined },
): StateFileSave {
  // Parsed rather than copied: this fills the defaulted fields in the way the reader fills
  // them, so a file saved twice is the same file, and strips every key the schema does not
  // know — `__proto__` among them, which the reader refuses a whole file for.
  const checked = stateSchema.safeParse({
    ...state,
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
  });
  if (!checked.success) {
    throw new StateFileUnwritableError(fieldOf(checked.error) ?? "the file itself");
  }

  return { json: checked.data, basedOn: save.basedOn };
}
