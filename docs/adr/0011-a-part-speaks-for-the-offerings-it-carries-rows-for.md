# A part speaks for the Offerings it carries rows for

A Raw Crawl is a **part** of an Academic Year ([ADR-0010](0010-raw-crawl-is-a-part-the-app-merges.md)), and the routine import is the same query crawled again before a registration window. Such a part carries rows BIU has changed since: a Group cancelled, a Group moved, a Course given in another Semester. For the import to act on any of that, it has to be settled how far a part's silence reaches — what it means that a part carries no row for a Group the Catalog holds.

Silence cannot simply mean removal. A part crawled for another department legitimately carries no CS Group at all, and a details-only part carries no row of any kind; treating "not in this part" as "removed" would empty the Catalog on the first double-major import.

**A part speaks for a Course it carries rows for, and within that Course for the Offerings whose Semesters it covered. It says nothing about anything else.**

**What a part covered is read off its own rows**: the Semester spellings they use. A part that returned a Fall row for anything was asked about Fall; a part that returned no Year-long row anywhere was not asked about Year-long. Nothing in a Raw Crawl states the query behind it, so the rows are the only honest evidence of what was asked.

- Where a part speaks for an Offering, that Offering's Groups are exactly the ones the part names. A Group the part does not name is **superseded**: taken out of the Catalog, with a Warning, because a removal is the kind of thing a student should not discover later.
- An Offering of a Course the part carries no row for is left alone, Groups and all. A details-only part therefore supersedes nothing, ever.
- Covering a Course's Fall does not reach its Year-long Offering, and covering its Year-long does not reach its Fall. 89-100 is really crawled as Fall, Spring, Summer and Year-long at once, four Offerings a student picks from separately; a part covering one of those spellings is silent about the other three.
- A part that covered Fall and names a Course only Year-long is saying that Course has no Fall Offering left. Its stale Fall Groups are superseded and the now-empty Offering goes with them, rather than the Catalog holding the Course twice with nothing to say which of the two is dead.
- A Course one of whose rows would not say which Semester it is in is superseded from not at all. A part that could not read where one of a Course's Groups meets is in no position to say which of that Course's Groups are gone.
- An Offering is removed only by supersession taking its last Group off it. One that already held no Groups — a Catalog naming a Course's Exams before its rows arrive — has nothing taken from it and stays.
- What a removed Offering held goes with it. Its Exams and its credits were that Offering's, not the Course's: a Fall sitting in February says nothing about the Year-long Offering that replaced it, and a wrong date carried forward is worse than an absent one. The report says the Offering is gone, and the next part carrying details settles the successor's.

The import reports what it changed before anything is written: per Offering, the Groups added, the Groups removed and the Groups whose Meetings moved, with the old times beside the new. The report is derived by comparing the Catalog before against the Catalog after, so it cannot disagree with what the merge did.

## Considered Options

- **A part speaks for every Offering of a Course whose Semesters its rows overlap:** the first rule written here, and wrong. Four Courses of the 2027 CS crawl — 89-100, 89-9953, 89-4036, 89-376 — hold two Offerings whose Semester sets overlap without being equal, so a part carrying only Fall rows emptied the Year-long Offering beside them and a part carrying only Year-long rows emptied both the Fall and the Spring. Splitting the 2026-09-13 crawl into Fall, Spring, Summer and Year-long parts and importing the four in order gave 181 Offerings over 506 Groups where the one crawl gives 186 over 513. Reading coverage off the spellings instead gives 186 over 513 either way.
- **A part speaks for the whole Course, every Semester spelling included:** the same harm, reached sooner — the first part imported would delete every Offering of a Course it did not cover.
- **A part speaks only for the exact Offerings it carries rows for:** the narrowest rule, and not enough. It leaves the Semester move unfixed: the new rows land on a second Offering keyed on the new Semesters, and the stale one is never spoken for, so the Course stays in the Catalog twice.
- **Keying an Offering on the Course alone, with the Semesters as a field:** would make the Semester move an ordinary update, but it contradicts the Offering in `CONTEXT.md` — a Course *as given in one Semester* — and 89-100's four spellings are four Offerings a student picks from separately, not one Offering whose Semesters changed.
- **Removing nothing and flagging the stale Groups instead:** keeps a cancelled Group Pickable, and puts the merge rules back on the student, which is what ADR-0010 keeps them out of.
