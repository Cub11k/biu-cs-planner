/**
 * Two Meetings of one Group that claim the same hour.
 *
 * #14 ruled that this is not a Clash: a Clash naming one Group twice is noise a student
 * cannot act on, because the Group is picked whole. It is a Catalog problem instead — either
 * the crawl misread the Shoham page or the university really published it that way — so the
 * Shoham Importer reports it as a Warning and imports the Offering regardless.
 */
import type { Meeting } from "../catalog/schema.ts";
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
