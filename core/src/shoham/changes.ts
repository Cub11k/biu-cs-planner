import type { Group, Meeting, Offering, Semester } from "../catalog/schema.ts";

/**
 * Which Offering is which, which Group is which, and what changed between two sets of them.
 *
 * Identity lives here rather than in the Importer because the merge and the report have to
 * agree on it: a Course that is one Offering to the merge and two to the report would show
 * a student Groups removed and added where nothing moved at all.
 */

/**
 * Semesters in a fixed order. A cell can name them either way round, and neither the merge
 * key nor the comparison may depend on which: otherwise one Year-long Course becomes two
 * Offerings.
 */
const SEMESTER_ORDER: Semester[] = ["fall", "spring", "summer"];

export function canonicalSemesters(semesters: Semester[]): Semester[] {
  return [...semesters].sort((a, b) => SEMESTER_ORDER.indexOf(a) - SEMESTER_ORDER.indexOf(b));
}

/** The key an Offering is merged and compared on: a Course plus the Semesters it spans. */
export function offeringKey(courseNumber: string, semesters: Semester[]): string {
  return `${courseNumber}|${canonicalSemesters(semesters).join("+")}`;
}

/**
 * What identifies a Group inside one Offering: its number together with its Lesson Type.
 * Shoham numbers each Lesson Type's Groups from 01, so 01 of the lecture and 01 of the
 * tirgul are two Groups a student picks separately -- the number alone is not an identity.
 * `code|group|kind|semester` is unique across the whole crawl, which is that pair being
 * unique within an Offering (docs/research/shoham-raw-shape.md). CONTEXT.md says so too.
 */
export function groupKey(number: string, lessonType: string): string {
  return `${number}|${lessonType}`;
}

/** A Group named as it appears in the report, with the Meetings it had or has. */
export type GroupChange = { number: string; lessonType: string; meetings: Meeting[] };

/** A Group that stayed, meeting at other times than it did. Both sets, so a badge can show both. */
export type GroupMove = {
  number: string;
  lessonType: string;
  before: Meeting[];
  after: Meeting[];
};

/** What one Offering's Groups look like after a part, against what they looked like before. */
export type OfferingChange = {
  courseNumber: string;
  semesters: Semester[];
  /** Groups the Offering holds now and did not hold before. */
  added: GroupChange[];
  /** Groups it held before and does not hold now, with the Meetings they are losing. */
  removed: GroupChange[];
  /** Groups it holds throughout, meeting at other times than they did. */
  moved: GroupMove[];
  /** The Offering itself is gone: it held Groups before and is not in the Catalog now. */
  offeringRemoved: boolean;
};

/** Every Offering that changed. An Offering nothing happened to is not in it. */
export type ImportChanges = OfferingChange[];

/** The Meetings are copied, so a report never shares an array with either Catalog it read. */
function named(group: Group): GroupChange {
  return { number: group.number, lessonType: group.lessonType, meetings: [...group.meetings] };
}

/**
 * A Group's Meetings as one comparable string, order set aside. A Year-long row names its
 * days in one cell and nothing promises two crawls order that cell alike, so a reordering
 * is not a change worth telling a student about.
 */
function meetingSet(meetings: Meeting[]): string {
  return meetings
    .map((m) => `${m.semester}|${m.day}|${m.start}|${m.end}`)
    .sort()
    .join("\n");
}

function groupsByKey(offering: Offering | undefined): Map<string, Group> {
  return new Map((offering?.groups ?? []).map((g) => [groupKey(g.number, g.lessonType), g]));
}

/**
 * What a part changed, per Offering, read off the two Catalogs rather than recorded while
 * merging: derived from before and after, it cannot disagree with what the merge did.
 *
 * Offerings come out in the order `before` holds them, then the ones only `after` has, which
 * is the order the Catalog itself is in.
 */
export function offeringChanges(before: Offering[], after: Offering[]): ImportChanges {
  const afterByKey = new Map(
    after.map((o) => [offeringKey(o.courseNumber, o.semesters), o] as const),
  );
  const seen = new Set<string>();
  const changes: ImportChanges = [];

  const compare = (key: string, was: Offering | undefined, is: Offering | undefined) => {
    seen.add(key);
    const wasGroups = groupsByKey(was);
    const isGroups = groupsByKey(is);

    const added: GroupChange[] = [];
    const removed: GroupChange[] = [];
    const moved: GroupMove[] = [];

    for (const [groupIdentity, group] of isGroups) {
      const held = wasGroups.get(groupIdentity);
      if (!held) added.push(named(group));
      else if (meetingSet(held.meetings) !== meetingSet(group.meetings)) {
        moved.push({
          number: group.number,
          lessonType: group.lessonType,
          before: [...held.meetings],
          after: [...group.meetings],
        });
      }
    }
    for (const [groupIdentity, group] of wasGroups) {
      if (!isGroups.has(groupIdentity)) removed.push(named(group));
    }

    if (!added.length && !removed.length && !moved.length) return;
    const offering = is ?? was!;
    changes.push({
      courseNumber: offering.courseNumber,
      semesters: canonicalSemesters(offering.semesters),
      added,
      removed,
      moved,
      offeringRemoved: is === undefined,
    });
  };

  for (const was of before) {
    const key = offeringKey(was.courseNumber, was.semesters);
    // A Catalog holding one key twice is the merge's own last-one-wins, and reporting the
    // same Offering twice would only make that harder to see.
    if (seen.has(key)) continue;
    compare(key, was, afterByKey.get(key));
  }
  for (const is of after) {
    const key = offeringKey(is.courseNumber, is.semesters);
    if (!seen.has(key)) compare(key, undefined, is);
  }

  return changes;
}
