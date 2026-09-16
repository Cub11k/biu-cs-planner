import type { Day, Semester } from "../catalog/schema.ts";

/**
 * A weekly day and time range within one Semester — the shape a Meeting and a Blocked Time
 * share. It is spelled out here structurally, and deliberately so: a Catalog Group's Meeting,
 * a Pick's snapshot of one, and the State File's Blocked Time all satisfy it, so finding
 * Clashes needs no import from the State File and the State File needs none from here.
 *
 * `start` and `end` are times of day on a 24-hour clock, plus `"24:00"` for the end of the Day
 * — the one spelling that lets a span cover the Day's last minute. The range is half-open,
 * `[start, end)`: a range ending at `"10:00"` and one starting at `"10:00"` do not meet, and
 * so a range ending at `"24:00"` does not meet the next Day's `"00:00"`. It lies within the one
 * Day it names, so a range that would run past midnight — `"23:00"` to `"01:00"` — describes no
 * time at all rather than wrapping into the next Day.
 */
export interface WeeklySpan {
  semester: Semester;
  day: Day;
  start: string;
  end: string;
}

/** What identifies a Group in a Clash: its Lesson Type and number, under its Course. */
export interface GroupRef {
  courseNumber: string;
  lessonType: string;
  number: string;
}

/**
 * A Group as a Timetable holds it. A Catalog Group satisfies this once the caller adds the
 * course number its Offering carries; so does a Pick, from its snapshot of the Meetings.
 * An Untimed Group is one with no Meetings, and it can never Clash.
 */
export interface PickedGroup extends GroupRef {
  meetings: readonly WeeklySpan[];
}

/**
 * A Clash that involves a Meeting: two picked Meetings overlapping, or a Meeting overlapping a
 * Blocked Time. `overlap` is the part of the week both sides occupy.
 *
 * The glossary's Clash has a third form, two Exams on the same day, which no Meeting takes part
 * in and which a separate check finds. The name says Meeting so that the bare `Clash` stays
 * free for the union of the two, and so that adding the Exam form later is not a change to this
 * type.
 */
export type MeetingClash =
  | {
      kind: "meeting-meeting";
      overlap: WeeklySpan;
      first: { group: GroupRef; meeting: WeeklySpan };
      second: { group: GroupRef; meeting: WeeklySpan };
    }
  | {
      kind: "meeting-blocked-time";
      overlap: WeeklySpan;
      group: GroupRef;
      meeting: WeeklySpan;
      blockedTime: WeeklySpan;
    };

/** A literal pattern, never built from data (ADR-0007). */
const CLOCK_TIME = /^(\d{1,2}):([0-5]\d)$/;

/**
 * Minutes since midnight, or `undefined` for a time this module cannot read. Comparing the
 * strings directly would be correct only while every one of them is zero-padded, and a Blocked
 * Time is student-entered: `"9:00"` sorts after `"10:00"`, which would quietly hide the Clash
 * rather than report it. Reading the number costs one literal pattern and removes the trap.
 *
 * `"24:00"` is the end of the Day, 1440 minutes in, so a Blocked Time can cover the Day's last
 * minute — `"22:00"`–`"24:00"` rather than `"22:00"`–`"23:59"`. It is read the same on either
 * end of a span and needs no special case for `start`: nothing in the Day comes after it, so a
 * span beginning there is empty under the half-open reading already used here. `"24:01"` and
 * anything above it name no time at all, the way `"25:00"` always has.
 */
function minutesIntoDay(time: string): number | undefined {
  const read = CLOCK_TIME.exec(time);
  if (!read) return undefined;

  const hour = Number(read[1]);
  const minute = Number(read[2]);
  if (hour > 24 || (hour === 24 && minute > 0)) return undefined;

  return hour * 60 + minute;
}

function groupRef(group: PickedGroup): GroupRef {
  return {
    courseNumber: group.courseNumber,
    lessonType: group.lessonType,
    number: group.number,
  };
}

function isSameGroup(a: GroupRef, b: GroupRef): boolean {
  return (
    a.courseNumber === b.courseNumber && a.lessonType === b.lessonType && a.number === b.number
  );
}

/**
 * The part of the week two spans share, or `undefined` if they share none. A span whose end
 * does not come after its start — a malformed range, or one written as if it wrapped past
 * midnight — occupies no time, which keeps it out of every Clash rather than letting it collide
 * with whatever encloses it. So does a span whose times cannot be read at all.
 */
function overlapOf(a: WeeklySpan, b: WeeklySpan): WeeklySpan | undefined {
  if (a.semester !== b.semester || a.day !== b.day) return undefined;

  const aStart = minutesIntoDay(a.start);
  const aEnd = minutesIntoDay(a.end);
  const bStart = minutesIntoDay(b.start);
  const bEnd = minutesIntoDay(b.end);
  if (aStart === undefined || aEnd === undefined) return undefined;
  if (bStart === undefined || bEnd === undefined) return undefined;
  if (aEnd <= aStart || bEnd <= bStart) return undefined;

  const later = aStart > bStart ? a : b;
  const earlier = aEnd < bEnd ? a : b;
  if (Math.max(aStart, bStart) >= Math.min(aEnd, bEnd)) return undefined;

  return { semester: a.semester, day: a.day, start: later.start, end: earlier.end };
}

/**
 * Finds every Clash involving a Meeting among a set of picked Groups and the Blocked Times they
 * have to live around. A Clash is a Warning: this reports, and rejects or reorders nothing.
 *
 * Each pair is reported once. A Group is named by its Course, its Lesson Type and its number,
 * and one so named is considered once however many times it is passed in; a Group is also never
 * compared with itself, since it is picked whole and two of its own Meetings overlapping is
 * Catalog data for the Importer to warn about rather than anything a student can resolve. A
 * Group's Meetings can still Clash with another Group's on one Meeting and not on the rest.
 *
 * The order is derived from the order of the arguments — every Meeting pair, then every Meeting
 * against every Blocked Time — so the same input always gives the same answer. Sorting for the
 * eye is the Timetable screen's job, and every Clash carries the Semester, the Day and the span
 * the two sides share for it to use.
 */
export function findMeetingClashes(
  groups: readonly PickedGroup[],
  blockedTimes: readonly WeeklySpan[] = [],
): MeetingClash[] {
  const picked: PickedGroup[] = [];
  for (const group of groups) {
    if (!picked.some((seen) => isSameGroup(seen, group))) picked.push(group);
  }

  const clashes: MeetingClash[] = [];

  for (let i = 0; i < picked.length; i++) {
    const first = picked[i]!;
    for (let j = i + 1; j < picked.length; j++) {
      const second = picked[j]!;

      for (const meetingOfFirst of first.meetings) {
        for (const meetingOfSecond of second.meetings) {
          const overlap = overlapOf(meetingOfFirst, meetingOfSecond);
          if (!overlap) continue;

          clashes.push({
            kind: "meeting-meeting",
            overlap,
            first: { group: groupRef(first), meeting: meetingOfFirst },
            second: { group: groupRef(second), meeting: meetingOfSecond },
          });
        }
      }
    }
  }

  for (const group of picked) {
    for (const meeting of group.meetings) {
      for (const blockedTime of blockedTimes) {
        const overlap = overlapOf(meeting, blockedTime);
        if (!overlap) continue;

        clashes.push({
          kind: "meeting-blocked-time",
          overlap,
          group: groupRef(group),
          meeting,
          blockedTime,
        });
      }
    }
  }

  return clashes;
}
