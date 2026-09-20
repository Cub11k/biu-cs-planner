/**
 * What a Group's own Meetings say wrong about themselves: two that claim the same hour, and one
 * that claims no hour at all.
 *
 * #14 ruled that an overlap between two of them is not a Clash: a Clash naming one Group twice
 * is noise a student cannot act on, because the Group is picked whole. It is a Catalog problem
 * instead — either the crawl misread the Shoham page or the university really published it that
 * way — so the Shoham Importer reports it as a Warning and imports the Offering regardless.
 *
 * #52 ruled the same way on a Meeting occupying no time, for the same reason and one more: a
 * student who types a Blocked Time of 16:00-16:00 is warned and retypes it (#39), while one
 * whose Catalog holds such a Meeting could not repair it if they knew.
 */
import type { Meeting } from "../catalog/schema.ts";
import { clockAsEnd, clockAsStart } from "../clock.ts";
import { findMeetingClashes } from "../timetable/clashes.ts";

/** Two Meetings of one Group whose times overlap, in the order the Group holds them. */
export interface MeetingOverlap {
  first: Meeting;
  second: Meeting;
}

/**
 * Every overlapping pair among one Group's Meetings, each pair reported once and in the
 * order the Meetings arrive. Meetings on different Days or in different Semesters never
 * overlap, so a Year-long Group meeting at the same hour in Fall and Spring is not a pair.
 *
 * The overlap rule itself is #14's and is not written a second time here: each Meeting is
 * handed to `findMeetingClashes` as if it were a Group picked on its own, which is exactly
 * the question being asked — would these two hours collide, were they two separate picks?
 * That routine deliberately never compares a Group with itself, which is why the Meetings
 * have to be presented as separate Groups to get an answer at all. Their identity only has
 * to be distinct, so the Meeting's position stands in for the Group number.
 */
export function overlappingMeetings(meetings: readonly Meeting[]): MeetingOverlap[] {
  const asSeparatePicks = meetings.map((meeting, index) => ({
    courseNumber: "",
    lessonType: "",
    number: String(index),
    meetings: [meeting],
  }));

  const overlaps: MeetingOverlap[] = [];
  for (const clash of findMeetingClashes(asSeparatePicks)) {
    // The Meeting a Clash carries is the one that was handed in, so it comes back out as
    // itself; a Blocked Time Clash cannot arise, since none were passed.
    if (clash.kind !== "meeting-meeting") continue;
    overlaps.push({ first: clash.first.meeting, second: clash.second.meeting });
  }
  return overlaps;
}

/**
 * Which shape a Meeting occupying no time has. The two are told apart because they point at
 * different causes: a range that does not advance is likelier a Shoham typo, while one whose
 * end falls before its start is likelier a night class read as a single range by the crawl.
 */
export type EmptyRange = "does-not-advance" | "reads-as-wrapping";

/** A Meeting of a Group that occupies no time, and which of the two shapes it has. */
export interface MeetingOccupyingNoTime {
  meeting: Meeting;
  range: EmptyRange;
}

/**
 * Every Meeting of one Group whose end does not advance past its start, in the order the Group
 * holds them. Such a Meeting occupies no time, so it Clashes with nothing and is placed
 * nowhere: nothing downstream of the import would ever mention it.
 *
 * The reading is #14's and #48's, not a second one written here: the clock is read through
 * `clockAsStart` and `clockAsEnd`, so `00:00` means the beginning of the Day at a `start` and
 * the end of it at an `end`. That is what keeps 22:00-00:00 an evening and 00:00-00:00 the
 * whole Day, while leaving 16:00-16:00 and 23:00-01:00 as the two empty shapes. The question
 * of what `overlapOf` should do with such a span is settled (#39, #42) and untouched here:
 * this reports the Catalog data, it does not reinterpret it.
 *
 * A Meeting whose clock cannot be read at all is not reported, because nothing here can say
 * whether its range advances; the dialect's `meeting-unreadable` is what speaks for those.
 */
export function meetingsOccupyingNoTime(meetings: readonly Meeting[]): MeetingOccupyingNoTime[] {
  const empty: MeetingOccupyingNoTime[] = [];
  for (const meeting of meetings) {
    const start = clockAsStart(meeting.start);
    const end = clockAsEnd(meeting.end);
    if (start === undefined || end === undefined) continue;
    if (end > start) continue;
    empty.push({ meeting, range: end === start ? "does-not-advance" : "reads-as-wrapping" });
  }
  return empty;
}
