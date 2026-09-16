# A part speaks for the Offerings it carries rows for

A Raw Crawl is a **part** of an Academic Year ([ADR-0010](0010-raw-crawl-is-a-part-the-app-merges.md)), and the routine import is the same query crawled again before a registration window. Such a part carries rows BIU has changed since: a Group cancelled, a Group moved, a Course given in another Semester. For the import to act on any of that, it has to be settled how far a part's silence reaches — what it means that a part carries no row for a Group the Catalog holds.

Silence cannot simply mean removal. A part crawled for another department legitimately carries no CS Group at all, and a details-only part carries no row of any kind; treating "not in this part" as "removed" would empty the Catalog on the first double-major import.

**A part speaks for the Offerings it carries rows for, and for the same Course's Offerings whose Semesters its rows overlap. It says nothing about anything else.**

- Where a part holds any row for an Offering, that Offering's Groups are exactly the ones the part names. A Group the part does not name is **superseded**: taken out of the Catalog, with a Warning, because a removal is the kind of thing a student should not discover later.
- An Offering no row of the part reaches is left alone, Groups and all. A details-only part therefore supersedes nothing, ever.
- Authority follows the Semesters the part's rows named for that Course, so a Course that comes back Year-long speaks for the Fall-only Offering its Groups used to be on. Those Groups are superseded there and the now-empty Offering goes with them, rather than the Catalog holding the Course twice with nothing to say which of the two is dead.
- Authority stops at Semesters the part did not name. A part carrying only Spring rows for a Course never touches its Fall Offering.
- An Offering is removed only by supersession taking its last Group off it. One that already held no Groups — a Catalog naming a Course's Exams before its rows arrive — has nothing taken from it and stays.

The import reports what it changed before anything is written: per Offering, the Groups added, the Groups removed and the Groups whose Meetings moved, with the old times beside the new. The report is derived by comparing the Catalog before against the Catalog after, so it cannot disagree with what the merge did.

## Considered Options

- **A part speaks for the whole Course, every Semester spelling included:** rejected because Shoham is queried per Semester as readily as for all of them, and the department's own build outputs are split that way (`2027-1`, `2027-2`, `2027-1+2`). A Spring part would empty every Fall Offering it touched.
- **A part speaks only for the exact Offerings it carries rows for:** the narrow rule, and not enough. It leaves the Semester move unfixed: the new rows land on a second Offering keyed on the new Semesters, and the stale one is never spoken for, so the Course stays in the Catalog twice.
- **Keying an Offering on the Course alone, with the Semesters as a field:** would make the Semester move an ordinary update, but it contradicts the Offering in `CONTEXT.md` — a Course *as given in one Semester* — and 89-100 is really crawled as Fall, Spring, Summer and Year-long at once, which are four Offerings a student picks from separately, not one Offering whose Semesters changed.
- **Removing nothing and flagging the stale Groups instead:** keeps a cancelled Group Pickable, and puts the merge rules back on the student, which is what ADR-0010 keeps them out of.
