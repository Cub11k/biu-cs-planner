/**
 * How `core` reads a clock string. One module rather than one reading per reader: the Clashes
 * module and the State File reader both need it, and `web` reads the same clock and cannot
 * import this — the rule is already written twice, and a third reading inside `core` is the
 * drift issue #48 exists to stop. `fixtures/clock-ranges.json` is the table both sides are
 * tested against.
 *
 * The set it reads is the set the schemas let in, and not a wider one: `hh:mm` from `00:00`
 * through `23:59`, zero-padded, which is the spelling `CONTEXT.md` gives a time. `core` once
 * read an unpadded hour that every one of those schemas refuses, and #54 ruled that second
 * opinion out (ADR-0012) — the schemas are the single source of truth for what a clock string
 * is, and this module turns one that has already passed one of them into a number.
 */

/**
 * A literal pattern, never built from data (ADR-0007). The same pattern the schemas that admit
 * a span carry — `pickedMeetingSchema` and `blockedTimeSchema` in `core/src/state/schema.ts`,
 * `meetingSchema` in `core/src/catalog/schema.ts`, `isClockTime` in `core/src/shoham/dialect.ts`
 * — and the same one `web/src/timetable/week.ts` reads with. Keeping the five spellings equal is
 * a matter of review: no test compares them (ADR-0012).
 */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The end of the Day, in minutes: what an `end` of `00:00` means and what `24:00` never spells. */
const END_OF_DAY = 24 * 60;

/**
 * Minutes since midnight, or `undefined` for a time this module cannot read. A number and not an
 * ordering, because the callers do arithmetic on it: a Clash is the intersection of two ranges,
 * and an `end` of `"00:00"` is 1440 — a value no comparison of the strings could ever produce.
 * Within the set this reads, the strings happen to sort chronologically as well; that is a
 * property of the padding, not the reason for the number.
 *
 * The pattern stops the hour at 23, so `"24:00"` is no more a time than `"9:00"` is. A Day ends
 * at `00:00` and has one spelling of midnight; 1440 is a number this module computes, never a
 * string anything stores or shows.
 */
function minutesIntoDay(time: string): number | undefined {
  if (!CLOCK_TIME.test(time)) return undefined;

  const [hour, minute] = time.split(":");
  return Number(hour) * 60 + Number(minute);
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
