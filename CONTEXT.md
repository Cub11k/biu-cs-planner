# BIU CS Planner

A local planner that helps Bar-Ilan University Computer Science students lay out a degree across Semesters and build the Timetable for an Academic Year.

## Language

### Catalog

**Shoham**:
BIU's public course catalog website; the only source of Catalog data.

**Raw Crawl**:
The near-raw file the crawler produces from a Shoham query, before the Shoham Importer turns it into Catalog data.
_Avoid_: scrape, export

**Catalog**:
All Offerings of one Academic Year, merged from one or more Raw Crawls.
_Avoid_: course list, schedule data

**Academic Year**:
A BIU year of Fall, Spring and Summer Semesters, identified by the Gregorian year it ends in (2027 = תשפ"ז).
_Avoid_: school year

**Semester**:
Fall (א), Spring (ב) or Summer (קיץ) of an Academic Year.
_Avoid_: term, period

**Course**:
A unit of study identified by its course number (e.g. 89-110), independent of year and Group.
_Avoid_: class, subject

**Offering**:
A Course as given in one Semester of a Catalog, with its credits, Groups and Exams.
_Avoid_: course instance, availability

**Year-long Course**:
A Course whose Offering spans Fall and Spring as one unit (שנתי). In the Plan it is two Attempts, a Fall half and a Spring half of one Academic Year, each carrying half the Course's credits; that is what New Plan from Suggested Layout creates and what the Plan checks read (#291, #293).
_Avoid_: annual course

**Group**:
One two-digit-numbered division of an Offering, with a single Lesson Type, zero or more lecturers and zero or more Meetings. Its number and its Lesson Type together identify it within an Offering — each Lesson Type is numbered from 01, so a lecture's 01 and a tirgul's 01 are two Groups — and so a re-imported part updates the Group that pair names rather than adding a second.
_Avoid_: section, class

**Lesson Type**:
The label on a Group (lecture, tirgul, lab, seminar…); every Lesson Type schedules identically.
_Avoid_: component

**Meeting**:
A weekly recurring day and time range of a Group. A time is written `hh:mm`, `00:00` through `23:59`, and where `00:00` appears is what says which end of the Day is meant: as an `end` it is the end of the Day, as a `start` the beginning of it. So `22:00`–`00:00` is the evening, `00:00`–`08:00` is the night, and `00:00`–`00:00` is the whole Day. `24:00` is written nowhere — a Day's last minute is 1440 minutes in for whatever is counting, and `00:00` for whatever is reading or showing. The ruling is on issue #48. A Meeting whose end does not advance past its start occupies no time: it Clashes with nothing and is placed nowhere, so the Shoham Importer reports it as a Catalog problem and imports it exactly as it was read rather than repairing or dropping it, saying which shape it has because an end equal to its start and an end before it point at different causes. The ruling is on issue #52. An hours cell holding more than two `-`-separated fields is not one range, so it yields no Meeting and is reported with its text as it stood rather than a range being picked out of the fields. The ruling is on issue #70. A cell holding a run of whole `hh:mm - hh:mm` ranges is the one exception, and means what those ranges written one per line mean: a crawl joins a multi-line cell into a single string, and both spellings have to say the same thing, as they already do for the Semester cell. A run's ranges are found wherever they sit, and nothing but whitespace may lie between them, so a chain of times sharing their separators is no run and stays reported. The ruling is on issue #74.
_Avoid_: session, slot, lesson

**Untimed Group**:
A Group with no Meetings, such as an online course.
_Avoid_: async course

**Exam**:
A dated sitting of an Offering, shared by all its Groups.
_Avoid_: test, final

**Moed**:
One of an Offering's Exam sittings: מועד א, ב, sometimes ג.
_Avoid_: exam period, attempt

### Requirements

**Program**:
A course of study a student is enrolled in, such as CS single major, with a Track when they have chosen one; a double major is two Programs.
_Avoid_: degree, major

**Track**:
A named set of extra Requirements a Program offers on top of its base rule set, such as the AI track. A Requirements File declares a Program's Tracks beside its base rule set, and a chosen Track's Requirements are evaluated together with the base ones, as their siblings.
_Avoid_: specialization, concentration, sub-major

**Cohort**:
The Academic Year and Semester in which a student started; it selects which Requirements File applies.
_Avoid_: class of, shnaton

**Requirements File**:
The rules of one Program for one or more Cohorts, converted by hand from the department's published PDF or Excel. It sits in the Workspace's `requirements/` folder and is named by its file name there without the `.json` — `cs-2027` for `requirements/cs-2027.json` — which is what a student's Programs and Pins refer to it by.
_Avoid_: yedion, curriculum

**Requirement**:
One node in a Program's rule tree: all-of, N-of, credits from a Pool, cap, Manual Requirement, and so on. A total is the one kind that takes no Course of its own: it counts the credits of every counted Course, or every one in its Pool, so it never competes with its siblings for a Course and cannot be Pinned to (ruled on #328).
_Avoid_: condition, constraint

**Pool**:
A named set of Courses a Requirement draws from, given as an explicit list or a course-number prefix or range.
_Avoid_: cluster, basket

**Prerequisite**:
A Requirement that must hold before a Course is taken, possibly allowing concurrent taking or demanding a minimum grade.
_Avoid_: dependency

**Manual Requirement**:
A Requirement the engine cannot evaluate and the student ticks off, such as lecturer approval or Hebrew expression. The ticks are kept in the State File, referenced the way a Pin references its Requirement.
_Avoid_: custom rule

**Equivalence**:
A declaration that two course numbers count as the same Course, typically after renumbering.
_Avoid_: alias

**Offering Pattern**:
The Semester a Requirements File says a Course is normally given in: Fall, Spring or Year-long.
_Avoid_: offering, availability

**Suggested Layout**:
The department's recommended placement of Courses by study year and Semester, relative to the Cohort.
_Avoid_: template, default plan, the layout (which is the Workspace Layout)

**Assignment**:
The Requirement a passed or planned Course counts toward, computed by the solver unless Pinned.
_Avoid_: allocation

**Pin**:
A student's override that fixes an Assignment: this Course counts toward this Requirement. A Pin names the Requirement by its id **and the Requirements File by its name**, because an id is unique only within one file and a double major has two, so a Pin on `core` in one Program is not a Pin on whatever the other Program calls `core`. A Pin written before Pins named their file is read as naming the student's first Program's file. Choosing Programs so that another file comes first stamps such a Pin with the file that was first, so it keeps meaning what it meant. A ticked Manual Requirement is referenced the same way, by id and file. Pinning a Course replaces any Pin the Course already had in that Program. The ruling is on issue #287.
_Avoid_: lock

### Student

**Workspace**:
The folder holding a student's Catalogs, Requirements Files, State Files and backups.
_Avoid_: project, profile

**Workspace Layout**:
The folders a Workspace holds: `catalogs/`, `requirements/` and `.backups/`. The app offers to create them on first run and writes nothing until the student accepts. A State File is not in one of them: it sits at the Workspace root, so its name is what tells State Files apart. A Workspace can hold only part of the Workspace Layout, and the parts that are not there are what "not a Workspace" means: the status says both whether the Workspace is ready and which parts are missing, by name, while a refused write names a part only when one part is what is wrong. Creating the Workspace Layout is not all-or-nothing: a create refused part way leaves the parts it had already made, replaces nothing that was there, and the status is how to see which parts are still missing; accepting the Workspace Layout again, once whatever refused it is fixed, makes the rest. Not the Suggested Layout, which is about Courses and Semesters and has nothing to do with folders.
_Avoid_: the layout, folder structure, scaffold
_In code_: the constant is `WORKSPACE_LAYOUT` and one part of it is a `WorkspaceFolder`, whose members are the bare names `catalogs`, `requirements` and `backups`. The term is Workspace Layout everywhere else, this file and `docs/` included. Only the filesystem adapter maps a member to a folder name, and that is where `backups` becomes `.backups/`: a Workspace being a folder on disk at all is ADR-0003, and that adapter is the one place that knows it.

**Launch Token**:
The secret the server is started with and every request must carry, delivered to the page in the fragment of the URL the launcher prints. It is kept in the user config directory, never in the Workspace: one per user account on the machine, stable across restarts so a bookmark keeps working, and replaced by `biu-cs-planner rotate-token`, or by deleting the file, which the next launch replaces with a fresh one. Replacing the file is the whole of the revocation — nothing expires a Launch Token and nothing keeps a list of retired ones — and a server that is already running keeps accepting the retired one until it exits.
_Avoid_: api key, secret, session

**State File**:
One student's or one scenario's personal data: Attempts, Timetables, Pins, ticked Manual Requirements, the student's Cohort and Programs, and settings.
_Avoid_: save, profile

**Revision**:
Which content a State File holds: a SHA-256 hash of the file's bytes as read, BOM included, and not of the document they parse to. Every save carries the revision it was based on, and a save is refused when the file no longer holds that revision, because something else wrote it in between: Dropbox, git, an editor or another tab. The page holds the revision between a read and its next save. A save based on no revision claims there is no file, and is refused when there is one. Why a content hash, why the bytes and why the page is ADR-0015.
_Avoid_: version (on its own), mtime, timestamp
_In code_: the type is `StateFileVersion`, the field the API and the Workspace port hand out is `version`, and the field a save sends back is `basedOn`. `StateFileVersion` and `version` keep the word because the type is in `core`'s surface and on the wire, and are not renamed. The term is revision everywhere else, this file and `docs/` included, and it is written in lower case there as the code's comments already wrote it before it was glossed; the sentences a student reads may still say "version", which is the plain English for it there. It is none of the other three versions: not the `schemaVersion` a file records (which build's format it is written in), not the Workspace change count `GET /api/workspace/changes` serves (which restarts at 0 with the server, and no file is compared against it), and not a release of the app.

**Device Preference**:
A display preference belonging to the browser and the screen a student is sitting at rather than to their Plan: kept in that browser's own store, per origin, and never in a State File, whose settings hold the preferences that belong to the person or the document instead. Which side a given preference falls on is ADR-0014, and the ruling is on issue #114. A copy of the Launch Token is kept in the same store and is not a Device Preference.
_Avoid_: theme, browser setting, local setting

**Attempt**:
One instance of a student taking a Course in a Semester, with a status (planned, registered, passed, failed, exempt, credited) and an optional grade. An Attempt is named by its **id**, never by its Course or its position: a retake makes course number plus Semester non-unique, and a position moves with every add and remove, while two tabs and Plan Diffs both have to name one Attempt and mean the same one tomorrow. A new Attempt's id is a UUID. A State File written before Attempts had ids still opens, without a migration and without the schema version moving: each Attempt without an id, or with one an earlier Attempt already holds, is read as `attempt-<n>`, the smallest `n` no other Attempt in the file uses, so every read of an unchanged file names its Attempts alike and the first save writes the ids down. The ruling is on issue #290.
_Avoid_: enrollment, record

**Plan**:
A student's Attempts laid out across Semesters; there is no plan object beyond the Attempts.
_Avoid_: roadmap, layout

**Progress**:
The evaluation of a student's Attempts against their Programs' Requirements.
_Avoid_: audit, status

**Timetable**:
The weekly schedule work for one Semester of one Academic Year, holding that Semester's Variants and Blocked Times.
_Avoid_: schedule, system

**Variant**:
A named alternative set of Picks for a Semester; one Variant is primary. At most one is the registered one, the Variant the student registered with: marking it makes it primary and clears both on its siblings, and is the moment the Plan may be brought along, by applying all its Plan Diffs and setting the Semester's planned Attempts of its Courses to registered, as one undo step and only if the student accepts. Unmarking clears the mark and nothing else (#297). In code and on screen, *registration* means this mark and the offer that comes with it, never a Pick (which Pick's _Avoid_ list warns against).
_Avoid_: option, draft, scenario

**Pick**:
The choice of one Group for one Lesson Type of an Offering within a Variant, with a snapshot of the Group's Meetings at the time of picking.
_Avoid_: selection, registration
_In code_: the type and schema are `GroupPick` and `groupPickSchema`, because a type named `Pick` shadows TypeScript's built-in `Pick<T, K>` for everything that imports it. The term is still Pick everywhere else, this file and `docs/` included.

**Tray**:
The Courses waiting to be scheduled in a Variant: that Semester's planned Attempts plus Courses added directly.
_Avoid_: basket, cart

**Blocked Time**:
A student-defined weekly period in a Semester to keep free, such as work or commute. Its `start` and `end` are written the way a Meeting's are, the end of the Day included. It lies within the one Day it names and never wraps past midnight, so a night shift is two Blocked Times rather than one: `23:00`–`00:00` on one Day and `00:00`–`01:00` on the next. A screen that takes a wrapping range from a student is what splits it into those two rows — one range typed, two stored — because a span that wraps would otherwise have to be split again by every reader of it, and a reader that forgot would silently stop blocking. The ruling and what it rejected are on issue #39.
_Avoid_: busy time, constraint

**Plan Diff**:
A divergence between a Variant and the Plan, resolved only by an explicit "apply to Plan". One of four kinds: **add**, a Course in the Variant (added to its Tray or picked) that the Plan does not have in the Semester; **drop**, a planned Attempt of a Course the Variant does not hold; **move**, a planned Course this year's Catalog offers only in another Semester; and **not-offered**, a planned Course this year's Catalog does not have at all, which has nothing to apply. Only planned Attempts are compared, and a student with no planned Attempt in the Academic Year has no Plan Diffs. Courses are compared through Equivalences, and a Year-long Course is one unit: both its halves are added or dropped together. A Plan Diff is named by its kind and its Course within the Variant's Semester, and is computed on every read and never stored; applying one changes only the Plan's Attempts (#295).
_Avoid_: sync, conflict

**Clash**:
Two picked Meetings overlapping, a Meeting overlapping a Blocked Time, or two Exams on the same day in any Moed.
_Avoid_: conflict, collision

**Warning**:
A detected problem shown to the student that never blocks an edit.
_Avoid_: error, violation
