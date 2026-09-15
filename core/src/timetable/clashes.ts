import type { Day, Semester } from "../catalog/schema.ts";

/**
 * A weekly day and time range within one Semester — the shape a Meeting and a Blocked Time
 * share. It is spelled out here structurally, and deliberately so: a Catalog Group's Meeting,
 * a Pick's snapshot of one, and the State File's Blocked Time all satisfy it, so finding
 * Clashes needs no import from the State File and the State File needs none from here.
 *
 * `start` and `end` are `"HH:MM"` on a 24-hour clock, which zero-padding makes comparable as
 * strings. The range is half-open, `[start, end)`: a range ending at `"10:00"` and one
 * starting at `"10:00"` do not meet.
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
 * Two picked Meetings overlapping, or a Meeting overlapping a Blocked Time. `overlap` is the
 * part of the week both sides occupy. Exam Clashes are a separate check.
 */
export type Clash =
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

function groupRef(group: PickedGroup): GroupRef {
  return {
    courseNumber: group.courseNumber,
    lessonType: group.lessonType,
    number: group.number,
  };
}

function isSameGroup(a: PickedGroup, b: PickedGroup): boolean {
  return (
    a.courseNumber === b.courseNumber && a.lessonType === b.lessonType && a.number === b.number
  );
}

/**
 * The part of the week two spans share, or `undefined` if they share none. A span whose end
 * does not come after its start occupies no time at all, which is how a malformed range stays
 * out of every Clash rather than colliding with everything around it.
 */
function overlapOf(a: WeeklySpan, b: WeeklySpan): WeeklySpan | undefined {
  if (a.semester !== b.semester || a.day !== b.day) return undefined;
  if (a.end <= a.start || b.end <= b.start) return undefined;

  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  if (start >= end) return undefined;

  return { semester: a.semester, day: a.day, start, end };
}

/**
 * Finds every Clash among a set of picked Groups and the Blocked Times they have to live
 * around. A Clash is a Warning: this reports, and rejects or reorders nothing.
 *
 * Each pair is reported once. Two Meetings of the same Group are never compared with each
 * other, since a Group is picked whole and the student has nothing to resolve; a Group's
 * Meetings can Clash with another Group's on one Meeting and not on the rest.
 *
 * The order is derived from the order of the arguments — every Meeting pair, then every
 * Meeting against every Blocked Time — so the same input always gives the same answer.
 */
export function findClashes(
  groups: readonly PickedGroup[],
  blockedTimes: readonly WeeklySpan[] = [],
): Clash[] {
  const clashes: Clash[] = [];

  for (let i = 0; i < groups.length; i++) {
    const first = groups[i]!;
    for (let j = i + 1; j < groups.length; j++) {
      const second = groups[j]!;
      if (isSameGroup(first, second)) continue;

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

  for (const group of groups) {
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
