import { parseCourseNumber, parseGroupMeetings, type MeetingWarning } from "./dialect.ts";
import {
  parseDetailKey,
  parseExams,
  parseSampledGroup,
  parseWeeklyHours,
} from "./details.ts";
import {
  canonicalSemesters,
  groupKey,
  offeringChanges,
  offeringKey,
  semesterSpelling,
  type ImportChanges,
} from "./changes.ts";
import { provenanceFromMeta } from "./meta.ts";
import {
  meetingsOccupyingNoTime,
  overlappingMeetings,
  type EmptyRangeShape,
} from "./overlaps.ts";
import type { RawCrawl, RawCrawlRow } from "./raw-crawl.ts";

export type { RawCrawl, RawCrawlRow };
export type { GroupChange, GroupMove, ImportChanges, OfferingChange } from "./changes.ts";
import {
  CURRENT_CATALOG_SCHEMA_VERSION,
  type Catalog,
  type Group,
  type Meeting,
  type Offering,
  type Provenance,
  type Semester,
} from "../catalog/schema.ts";


export type Warning =
  // What the dialect could not read of one row's hours, on the Course and Group that row names.
  // One of these carries the cell it was read from, so each is spread in rather than the kind
  // alone being copied out of it.
  | ({ courseNumber: string; group: string } & MeetingWarning)
  // Not one of those: it is the Semester cell rather than the hours, and a row that will not say
  // which Semester it is in also stops the part superseding that Course's Groups further down.
  | { kind: "semester-unreadable"; courseNumber: string; group: string }
  | {
      kind: "group-meetings-overlap";
      courseNumber: string;
      /** A Course can hold two Offerings -- Year-long and Fall-only, say -- and each numbers
       * its Groups from 01, so the Semesters are part of saying which Group this is. */
      semesters: Semester[];
      group: string;
      lessonType: string;
      first: Meeting;
      second: Meeting;
    }
  | {
      kind: "meeting-occupies-no-time";
      courseNumber: string;
      /** Which of the Course's Offerings holds it, since each numbers its Groups from 01. */
      semesters: Semester[];
      group: string;
      lessonType: string;
      meeting: Meeting;
      /** Which shape the empty range has, because the two point at different causes. */
      shape: EmptyRangeShape;
    }
  | {
      kind: "group-superseded";
      courseNumber: string;
      /** Which of a Course's Offerings lost the Group, since each numbers its Groups from 01. */
      semesters: Semester[];
      group: string;
      lessonType: string;
    }
  | { kind: "unusual-course-number"; courseNumber: string }
  | { kind: "course-number-unreadable"; code: string }
  | { kind: "detail-key-unreadable"; key: string }
  | { kind: "detail-without-offering"; courseNumber: string; semesters: Semester[] }
  | { kind: "weekly-hours-unreadable"; courseNumber: string }
  | { kind: "detail-group-unknown"; courseNumber: string }
  | { kind: "detail-group-ambiguous"; courseNumber: string; group: string }
  | { kind: "detail-without-group"; lid: string }
  | { kind: "lid-not-unique"; lid: string }
  | { kind: "exam-unreadable"; courseNumber: string }
  | { kind: "academic-year-mismatch"; catalog: number; part: number }
  | { kind: "provenance-missing" };

/** Tails run to three or four digits. Anything else is reported and imported as it stands. */
function hasUnusualTail(code: string): boolean {
  const tail = code.slice(2);
  return tail.length < 3 || tail.length > 4;
}

function lecturersFrom(teachers: string): string[] {
  return teachers.split("\n").map((t) => t.trim()).filter(Boolean);
}

/**
 * The weekly hours a detail page states, from wherever it was read. A figure that is there
 * but unreadable is reported; a page carrying none at all is not, because most carry none.
 */
function readWeeklyHours(
  points: string | undefined,
  courseNumber: string,
  warnings: Warning[],
): number | undefined {
  const hours = parseWeeklyHours(points);
  if (hours === undefined && points !== undefined) {
    warnings.push({ kind: "weekly-hours-unreadable", courseNumber });
  }
  return hours;
}

/**
 * What the Catalog holds after the import. The import screen shows this, with the Warnings,
 * before anything is written to the Workspace.
 */
export type ImportSummary = {
  offerings: number;
  groups: number;
  meetings: number;
  exams: number;
};

/**
 * An Offering's credits are one Group's weekly hours per Lesson Type, added up. Shoham
 * publishes hours per Group, so this is only settled once every Lesson Type is covered --
 * 89-132 is its lecture's 4 plus a tirgul's 2, and a single detail record cannot say so.
 */
function creditsOf(offering: Offering): Offering["credits"] {
  const perLessonType = new Map<string, number | undefined>();
  for (const group of offering.groups) {
    // The first Group of a Lesson Type that has hours speaks for the type. Zero hours is a
    // figure Shoham really publishes -- a קולוקויום or a הדרכה reads 0.00 -- so only an
    // absent reading, never a zero one, leaves the type still waiting to be settled.
    if (perLessonType.get(group.lessonType) === undefined) {
      perLessonType.set(group.lessonType, group.weeklyHours);
    }
  }

  const hours = [...perLessonType.values()];
  if (!hours.length || hours.some((h) => h === undefined)) return { known: false };
  return { known: true, total: (hours as number[]).reduce((sum, h) => sum + h, 0) };
}

function summarise(catalog: Catalog): ImportSummary {
  let groups = 0;
  let meetings = 0;
  let exams = 0;
  for (const offering of catalog.offerings) {
    groups += offering.groups.length;
    for (const group of offering.groups) meetings += group.meetings.length;
    exams += offering.exams.sittings.length;
  }
  return { offerings: catalog.offerings.length, groups, meetings, exams };
}

export function importRawCrawl(
  crawl: RawCrawl,
  options: { academicYear: number; into?: Catalog },
): { catalog: Catalog; warnings: Warning[]; summary: ImportSummary; changes: ImportChanges } {
  // One Offering per Course and Semester set. A Year-long row names two Semesters and so
  // forms its own Offering, separate from the same Course given only in Fall.
  // A part is merged into what is already there rather than replacing it, and the Catalog
  // it is merged into is left untouched (ADR-0010).
  const offerings = new Map<string, Offering>();
  for (const existing of options.into?.offerings ?? []) {
    offerings.set(offeringKey(existing.courseNumber, existing.semesters), {
      ...existing,
      semesters: [...existing.semesters],
      groups: existing.groups.map((group) => ({ ...group, meetings: [...group.meetings] })),
      exams: { ...existing.exams, sittings: [...existing.exams.sittings] },
    });
  }

  // A per-Group record names its Group by `lid`, so the rows of this part are what match it
  // to one. A Group carries no `lid` of its own, so such a record only reaches the Group
  // whose row travelled with it.
  const groupsByLid = new Map<string, { offering: Offering; group: Group }>();

  // Each Offering's Groups by identity, so a row already seen finds the Group it names.
  // Built on first use, which covers an Offering seeded from the Catalog and one this part
  // created alike.
  const indexes = new Map<Offering, Map<string, Group>>();
  function groupIndexOf(offering: Offering): Map<string, Group> {
    let index = indexes.get(offering);
    if (!index) {
      index = new Map(offering.groups.map((g) => [groupKey(g.number, g.lessonType), g]));
      indexes.set(offering, index);
    }
    return index;
  }

  // The Groups this part's rows carried, in the order they were first seen. A Group two rows
  // name is held once, so what is checked is the Meetings it ends up with.
  const carried = new Map<Group, Offering>();

  // What this part covered, read off its own rows (ADR-0011): the Courses it carried a row
  // for, and the Semester spellings those rows used. A part that returned a Fall row was
  // asked about Fall; one that never returned a Year-long row was not asked about Year-long.
  // Both are needed, because 89-100 really is given Fall, Spring, Summer and Year-long at
  // once: its Fall rows say nothing about its Year-long Offering, while a part that covered
  // Fall and names 89-385 only Year-long is saying 89-385 has no Fall Offering left.
  const coursesCarried = new Set<string>();
  const spellingsCovered = new Set<string>();

  // A Course one of whose rows would not say which Semester it is in. A part that could not
  // read where one of a Course's Groups meets is in no position to say which of that
  // Course's Groups are gone, so it supersedes none of them.
  const semesterUnreadable = new Set<string>();

  const warnings: Warning[] = [];
  const reportedNumbers = new Set<string>();

  // A Catalog holds one Academic Year. Merging a part from another year would relabel the
  // Offerings already in it, so the part is refused and the Catalog handed back untouched.
  if (options.into && options.into.academicYear !== options.academicYear) {
    return {
      catalog: options.into,
      warnings: [
        { kind: "academic-year-mismatch", catalog: options.into.academicYear, part: options.academicYear },
      ],
      summary: summarise(options.into),
      changes: [],
    };
  }

  // Provenance is optional, because the older crawls carry none, but a part that cannot say
  // where it came from is worth saying so about. The meta block is where a crawl really
  // records it; a Provenance handed in already shaped is the older way and gives way to it.
  const sources = [...(options.into?.sources ?? [])];
  const provenance = provenanceFromMeta(crawl.meta) ?? crawl.provenance;
  if (provenance) sources.push(provenance);
  else warnings.push({ kind: "provenance-missing" });

  for (const row of crawl.rows ?? []) {
    const { semesters, meetings, warnings: meetingWarnings } = parseGroupMeetings(row);
    const courseNumber = parseCourseNumber(row.code);
    // The row's Course and Group are named here rather than in the dialect, which reads a row's
    // hours and is handed no course number; they are written last so they stand whatever a
    // dialect Warning carries.
    for (const meetingWarning of meetingWarnings) {
      warnings.push({ ...meetingWarning, courseNumber, group: row.group });
    }
    if (!semesters.length) {
      warnings.push({ kind: "semester-unreadable", courseNumber, group: row.group });
      semesterUnreadable.add(courseNumber);
    } else {
      coursesCarried.add(courseNumber);
      spellingsCovered.add(semesterSpelling(semesters));
    }
    if (row.code.length < 3 && !reportedNumbers.has(courseNumber)) {
      reportedNumbers.add(courseNumber);
      warnings.push({ kind: "course-number-unreadable", code: row.code });
    }
    const key = offeringKey(courseNumber, semesters);

    if (hasUnusualTail(row.code) && !reportedNumbers.has(courseNumber)) {
      reportedNumbers.add(courseNumber);
      warnings.push({ kind: "unusual-course-number", courseNumber });
    }

    let offering = offerings.get(key);
    if (!offering) {
      offering = {
        courseNumber,
        nameHebrew: row.name,
        semesters: canonicalSemesters(semesters),
        groups: [],
        credits: { known: false },
        exams: { known: false, sittings: [] },
      };
      offerings.set(key, offering);
    }

    // A re-crawl before each registration window is the routine import, so most rows of a
    // part have been seen before. Such a row updates the Group it names rather than adding
    // a second: what the row carries -- Meetings and lecturers -- replaces what is held, so
    // a Group that moved moves, and the weekly hours no row ever carries are left alone.
    const index = groupIndexOf(offering);
    const identity = groupKey(row.group, row.kind);
    let group = index.get(identity);
    if (!group) {
      group = { number: row.group, lessonType: row.kind, lecturers: [], meetings: [] };
      offering.groups.push(group);
      index.set(identity, group);
    }
    group.lecturers = lecturersFrom(row.teachers);
    group.meetings = meetings;
    carried.set(group, offering);
    // A row's identity is its lid, so two rows claiming one is the crawl contradicting
    // itself. The later row keeps the lid; where the two rows are different Groups, the
    // earlier is left without the hours its record would have carried, and where they are
    // the same Group nothing is lost. Either way it is worth saying rather than passing.
    if (row.lid) {
      if (groupsByLid.has(row.lid)) warnings.push({ kind: "lid-not-unique", lid: row.lid });
      groupsByLid.set(row.lid, { offering, group });
    }
  }

  // A Group that claims to meet in two places at once, or at an hour occupying no time, is a
  // Catalog problem, not a Clash (#14, #52), and not a reason to refuse anything: the Meetings
  // are imported as they were read and the Warning says what was found, so a maintainer can
  // hold it against the Shoham page.
  // Only the Groups this part carried are checked. Every other Warning here speaks about the
  // part in hand, and a Group merged in from the Catalog was reported by the part that
  // brought it; re-reading the whole Catalog would repeat that Warning on every later merge,
  // which also makes the count of Groups caught depend on how many parts were imported.
  for (const [group, offering] of carried) {
    for (const { first, second } of overlappingMeetings(group.meetings)) {
      warnings.push({
        kind: "group-meetings-overlap",
        courseNumber: offering.courseNumber,
        semesters: [...offering.semesters],
        group: group.number,
        lessonType: group.lessonType,
        first,
        second,
      });
    }
    // A Meeting whose end does not advance past its start Clashes with nothing and is placed
    // nowhere, so this is the only place it can be said at all. Which of the two shapes it has
    // is part of the Warning: 16:00-16:00 sends a maintainer to the Shoham page looking for a
    // typo, while an end before its start sends them at how the crawl read the cell.
    for (const { meeting, shape } of meetingsOccupyingNoTime(group.meetings)) {
      warnings.push({
        kind: "meeting-occupies-no-time",
        courseNumber: offering.courseNumber,
        semesters: [...offering.semesters],
        group: group.number,
        lessonType: group.lessonType,
        meeting,
        shape,
      });
    }
  }

  // A part speaks for a Course it carries rows for, and within it for the Offerings whose
  // Semesters the part covered; it says nothing about anything else (ADR-0011). Within an
  // Offering it speaks for, the Groups it carried are the whole of it:
  // a Group BIU cancelled between crawls is superseded here rather than left in the Catalog
  // for a student to Pick. Before the detail records are read, so that a Group on its way out
  // cannot take hours meant for the Group that replaced it, nor make a sampled record
  // ambiguous by still being there.
  for (const [key, offering] of offerings) {
    if (semesterUnreadable.has(offering.courseNumber)) continue;
    if (!coursesCarried.has(offering.courseNumber)) continue;
    if (!spellingsCovered.has(semesterSpelling(offering.semesters))) continue;

    const kept = offering.groups.filter((group) => carried.has(group));
    if (kept.length === offering.groups.length) continue;

    for (const group of offering.groups) {
      if (carried.has(group)) continue;
      warnings.push({
        kind: "group-superseded",
        courseNumber: offering.courseNumber,
        semesters: [...offering.semesters],
        group: group.number,
        lessonType: group.lessonType,
      });
    }
    offering.groups = kept;
    indexes.delete(offering);
    // An Offering whose last Group has just been superseded is the Course moving Semester:
    // its Groups are now on the Offering the part named, and what is left here is a dead
    // second copy of the Course. An Offering that was already empty had nothing taken from
    // it and so is not reached at all.
    if (!kept.length) offerings.delete(key);
  }

  for (const [key, detail] of Object.entries(crawl.details ?? {})) {
    const parsed = parseDetailKey(key);
    if (!parsed) {
      warnings.push({ kind: "detail-key-unreadable", key });
      continue;
    }
    const offering = offerings.get(offeringKey(parsed.courseNumber, parsed.semesters));
    if (!offering) {
      // Normal when a details-only part arrives before its rows, but the student has to be
      // told, or the import reads as a success that recorded nothing.
      warnings.push({
        kind: "detail-without-offering",
        courseNumber: parsed.courseNumber,
        semesters: canonicalSemesters(parsed.semesters),
      });
      continue;
    }

    const hours = readWeeklyHours(detail.points, parsed.courseNumber, warnings);
    if (hours !== undefined) {
      // A course-wide record names the Group it was sampled from by number alone, and a
      // number alone is not a Group: the same 01 can be a lecture and a tirgul. Where it
      // names one Group the figure lands on it; where it names two there is nothing in the
      // record to choose between them, so the hours are refused rather than guessed onto
      // the wrong Lesson Type, which would put a wrong total in the Offering's credits.
      const sampled = parseSampledGroup(detail.code);
      const named = sampled ? offering.groups.filter((g) => g.number === sampled) : [];
      if (named.length === 1) named[0]!.weeklyHours = hours;
      else if (named.length > 1) {
        warnings.push({
          kind: "detail-group-ambiguous",
          courseNumber: parsed.courseNumber,
          group: sampled!,
        });
      } else warnings.push({ kind: "detail-group-unknown", courseNumber: parsed.courseNumber });
    }

    // An absent Exam list means "not published for the Group this was read from", never
    // "this Offering has no Exam", so only a record that carries Exams settles the question.
    const { exams: sittings, unreadable } = parseExams(detail);
    if (unreadable) warnings.push({ kind: "exam-unreadable", courseNumber: parsed.courseNumber });
    if (sittings.length) offering.exams = { known: true, sittings };
  }

  // The per-Group records last: one read from the Group it names settles that Group's hours,
  // and does so over anything the course-wide record guessed from whichever Group it sampled.
  for (const [lid, record] of Object.entries(crawl.sections ?? {})) {
    const found = groupsByLid.get(lid);
    if (!found) {
      warnings.push({ kind: "detail-without-group", lid });
      continue;
    }

    const hours = readWeeklyHours(record.points, found.offering.courseNumber, warnings);
    if (hours !== undefined) found.group.weeklyHours = hours;

    // The same English name sits on every Group of a Course, so whichever record is read
    // last says the same thing. The results grid has no English column at all, which makes
    // this the only route to one; a Catalog without it falls back to the Hebrew name.
    const english = record.name_en?.trim();
    if (english) found.offering.nameEnglish = english;
  }

  for (const offering of offerings.values()) offering.credits = creditsOf(offering);

  const catalog: Catalog = {
    schemaVersion: CURRENT_CATALOG_SCHEMA_VERSION,
    academicYear: options.academicYear,
    sources,
    offerings: [...offerings.values()],
  };

  return {
    catalog,
    warnings,
    summary: summarise(catalog),
    changes: offeringChanges(options.into?.offerings ?? [], catalog.offerings),
  };
}
