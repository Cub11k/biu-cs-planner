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
A Course whose Offering spans Fall and Spring as one unit (שנתי).
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
A degree track a student is enrolled in, such as CS single major or CS with the AI track; a double major is two Programs.
_Avoid_: degree, major

**Cohort**:
The Academic Year and Semester in which a student started; it selects which Requirements File applies.
_Avoid_: class of, shnaton

**Requirements File**:
The rules of one Program for one Cohort, converted by hand from the department's published PDF or Excel.
_Avoid_: yedion, curriculum

**Requirement**:
One node in a Program's rule tree: all-of, N-of, credits from a Pool, cap, Manual Requirement, and so on.
_Avoid_: condition, constraint

**Pool**:
A named set of Courses a Requirement draws from, given as an explicit list or a course-number prefix or range.
_Avoid_: cluster, basket

**Prerequisite**:
A Requirement that must hold before a Course is taken, possibly allowing concurrent taking or demanding a minimum grade.
_Avoid_: dependency

**Manual Requirement**:
A Requirement the engine cannot evaluate and the student ticks off, such as lecturer approval or Hebrew expression.
_Avoid_: custom rule

**Equivalence**:
A declaration that two course numbers count as the same Course, typically after renumbering.
_Avoid_: alias

**Offering Pattern**:
The Semester a Requirements File says a Course is normally given in: Fall, Spring or Year-long.
_Avoid_: offering, availability

**Suggested Layout**:
The department's recommended placement of Courses by study year and Semester, relative to the Cohort.
_Avoid_: template, default plan

**Assignment**:
The Requirement a passed or planned Course counts toward, computed by the solver unless Pinned.
_Avoid_: allocation

**Pin**:
A student's override that fixes an Assignment.
_Avoid_: lock

### Student

**Workspace**:
The folder holding a student's Catalogs, Requirements Files, State Files and backups.
_Avoid_: project, profile

**Launch Token**:
The secret the server is started with and every request must carry, delivered to the page in the fragment of the URL the launcher prints. It is kept in the user config directory, never in the Workspace: one per user account on the machine, stable across restarts so a bookmark keeps working, and replaced by `biu-cs-planner rotate-token`, or by deleting the file, which the next launch replaces with a fresh one. Replacing the file is the whole of the revocation — nothing expires a Launch Token and nothing keeps a list of retired ones — and a server that is already running keeps accepting the retired one until it exits.
_Avoid_: api key, secret, session

**State File**:
One student's or one scenario's personal data: Attempts, Timetables, Pins and settings.
_Avoid_: save, profile

**Attempt**:
One instance of a student taking a Course in a Semester, with a status (planned, registered, passed, failed, exempt, credited) and an optional grade.
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
A named alternative set of Picks for a Semester; one Variant is primary.
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
A divergence between a Variant and the Plan, resolved only by an explicit "apply to Plan".
_Avoid_: sync, conflict

**Clash**:
Two picked Meetings overlapping, a Meeting overlapping a Blocked Time, or two Exams on the same day in any Moed.
_Avoid_: conflict, collision

**Warning**:
A detected problem shown to the student that never blocks an edit.
_Avoid_: error, violation
