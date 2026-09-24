# A Raw Crawl is a part, and the app merges parts

A Raw Crawl file carries **part** of one Academic Year, not the whole of it. One part holds Groups, another holds the course-wide facts — credits and Exams — and either may be absent from a given file. The app imports parts one by one and merges them into the Catalog by Academic Year and course number. There is no assembled "whole crawl" format, and parts are never stored: the Catalog is the only merged artifact.

- **Several parts, one import action.** The import screen takes several files at once, shows a single preview of the combined result with counts and Warnings, and writes once. The merge is the same code path applied repeatedly before the write, so this is a convenience, not a second mechanism.
- **Parts arrive over time and from different places.** A part covering another department is how a double major is supported, and a part carrying only course-wide facts is how an Academic Year already imported gains Exams it was missing. Neither requires re-importing what is already there.
- **Merge rules live in the app**, because they are rules a person assembling files by hand would get wrong:
  - A record carrying Exams wins over one carrying none. An absent Exam list means "not published for this Group", not "this Offering has no Exam", so the Catalog records Exams as *unknown* until a part supplies them.
  - Course-wide facts are matched to an Offering by course number and Semester, after normalising the Semester, because a Year-long Semester is written in more than one way across files.
  - Course numbers are taken as given. A number whose shape is unusual becomes its own Course plus a Warning, and an Equivalence in a Requirements File is how two numbers are declared to be the same Course.

## Considered Options

- **One merged file, assembled before import:** the app already has to merge a newly imported part into an existing Catalog — that is what re-import is, with its Groups added, removed and moved, and its Variants re-checked against Pick snapshots. A bundle format would add a second merge alongside that one rather than replacing it, and it would push the assembly, along with the Exam-precedence and Semester-spelling rules, onto the student.
- **One part per file, one file per import:** rejected only as an interface. Attaching four parts in four confirmations gives four previews of four partial results, when what a student wants to see is what the Catalog will look like afterwards.
