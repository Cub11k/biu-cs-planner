/**
 * How `core` reads a clock string. One module rather than one reading per reader: the Clashes
 * module and the State File reader both need it, and `web` reads the same clock and cannot
 * import this — the rule is already written twice, and a third reading inside `core` is the
 * drift issue #48 exists to stop. `fixtures/clock-ranges.json` is the table both sides are
 * tested against.
 *
 * Reading is not validating. What may be *written* into a State File or a Catalog is decided
 * by the patterns on the schemas — `core/src/state/schema.ts` and `core/src/catalog/schema.ts`
 * — and both are narrower than this: zero-padded `hh:mm` only, which is what `CONTEXT.md` says
 * a time is written as. This is what turns a string that has already been stored, or that
 * reached a `WeeklySpan` without passing a schema, into a number.
 */

/** A literal pattern, never built from data (ADR-0007). */
const CLOCK_TIME = /^(\d{1,2}):([0-5]\d)$/;

/** The end of the Day, in minutes: what an `end` of `00:00` means and what `24:00` never spells. */
const END_OF_DAY = 24 * 60;

/**
 * Minutes since midnight, or `undefined` for a time this module cannot read. Comparing the
 * strings directly would be correct only while every one of them is zero-padded: `"9:00"`
 * sorts after `"10:00"`, so a Clash would be hidden rather than reported. Reading the number
 * costs one literal pattern and removes that trap, and it is why a missing leading zero is
 * read rather than refused — a `WeeklySpan` is a structural contract that anything can
 * satisfy, and a span that reaches here without having passed a schema is better placed than
 * silently ignored. A Blocked Time out of a State File is never one of those: `blockedTimeSchema`
 * refuses `"9:00"` and `parseStateFile` drops the entry with a Warning long before this.
 *
 * The hour stops at 23, so `"24:00"` is not a time. A Day ends at `00:00` and has one spelling
 * of midnight; 1440 is a number this module computes, never a string anything stores or shows.
 */
function minutesIntoDay(time: string): number | undefined {
  const read = CLOCK_TIME.exec(time);
  if (!read) return undefined;

  const hour = Number(read[1]);
  if (hour > 23) return undefined;

  return hour * 60 + Number(read[2]);
}

/**
 * A clock string read as the `start` of a range: `"00:00"` is the beginning of the Day, 0
 * minutes in, so `00:00`–`08:00` is the night and not the whole Day.
 */
export function clockAsStart(time: string): number | undefined {
  return minutesIntoDay(time);
}

/**
 * A clock string read as the `end` of a range: `"00:00"` is the end of the Day, 1440 minutes
 * in, so `22:00`–`00:00` is the evening and not an empty range. Same spelling as a `start`,
 * different position — which is the whole of the ruling on #48, and the reason these are two
 * functions rather than one with a flag: the position is the caller's, and a caller that has
 * to decide what to pass is a caller that can decide wrongly.
 */
export function clockAsEnd(time: string): number | undefined {
  const read = minutesIntoDay(time);
  if (read === undefined) return undefined;

  return read === 0 ? END_OF_DAY : read;
}
