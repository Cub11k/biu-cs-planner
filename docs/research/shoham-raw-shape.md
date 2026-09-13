# The shape of Shoham's raw data

Observed 2026-09-13 from a real crawl of the CS department for Academic Year 2027 (תשפ"ז),
510 grid rows.

The crawler itself lives in a **separate repo next to this one** and is not part of the app
deliverable ([ADR-0005](../adr/0005-crawler-separate-repo-near-raw-output.md)); how it works is
recorded there, not here. This file describes only the shape of what comes out, which is what the
Shoham Importer has to read.

Unlike [`biu-sources.md`](biu-sources.md), which was researched from Wayback snapshots and is
explicitly "likely, not confirmed", **everything here was read off real output**. Where the two
disagree, this file wins.

## Two sources, not one

Shoham gives up its Catalog through two different pages, carrying different things:

| Source | Granularity | Carries |
| --- | --- | --- |
| **Grid** (`CoursesView.aspx`) | one row per **Group** | course number, names, Group number, lecturers, Lesson Type, Semester, days, hours |
| **Detail** (`CourseDetails.aspx?lid=<id>`) | one page per **Group** | credits and Exams, which are **course-wide**, plus the code of the Group it was read from |

The grid is the bulk source: every Group of every Course, in one paged listing. The detail page
costs a request per Group, so in practice one Group per (course, Semester) is read and what it
says is taken as course-wide. That sampling causes the sharpest trap on this data; see
[Exams are not always shown](#exams-are-not-always-shown).

A grid row's identity is `lid`, the internal id behind its detail link. Course number alone is not
unique per row, and neither is course + Group without the Semester.

## A grid row

Nine string fields, exactly as the page renders them:

```
{ code: "89132", name: "חשבון אינפיניטסימלי 1", group: "01",
  teachers: "פרופ' X\nד\"ר Y", kind: "הרצאה", semester: "סמסטר א'",
  day: "ג',ד'", hours: "13:00 - 15:00\n09:00 - 11:00", lid: "820744" }
```

- **`code`** — the course number without its hyphen. `89110` is 89-110, `891195` is 89-1195. Both
  3- and 4-digit tails occur, so the split is `89` plus the rest, not a fixed width.
- **`group`** — two digits, `01`–`15` in this data.
- **`teachers`** — **zero or more**, newline-separated. 52 rows carry several; **80 carry none**.
  The glossary's "a lecturer" is too narrow.
- **`kind`** — the Lesson Type label, an **open set**. 14 distinct values here: הרצאה, תרגיל,
  סמינריון, סדנה, פרויקט, תיזה, דיסרטציה, הדרכה, תגבור, ש.מחלקה, קולוקויום חובה,
  קולוקויום רשות, and two that are not teaching at all — בחינה and רישום, one row each.
- **`semester`** — `סמסטר א'` (Fall, 225 rows), `סמסטר ב'` (Spring, 207), `סמסטר ק'` (Summer, 4),
  or **both Fall and Spring on two lines** (74), which is how Shoham shows a Year-long Course.
  There is no `שנתי` marker.
- **`day`** — comma-separated day letters, `א'` through `ו'`; Friday does occur. **Empty means the
  Group has no Meetings** — 144 of 510 rows.
- **`hours`** — one `HH:MM - HH:MM` range per line, **newline-separated**, positionally paired
  with `day`. Empty when `day` is empty. Files with the run-together damage show these joined on
  one line instead, so a reader has to accept both.

### Pairing days to hours

One row is one Group, and a Group's several Meetings live *inside* that row. Across all 510 rows,
`code|group|kind|semester` is unique — there are **no** duplicate rows to merge into a Group.

Ten rows list several days. Usually the counts match:

```
day:   "א',ג'"                          2 days, comma-separated
hours: "13:00 - 15:00\n15:00 - 17:00"    2 ranges, newline-separated
```

But a Year-long Group repeats its ranges once per Semester:

```
89099  semester: Fall + Spring
day:   "א',ה',ו'"                        3 days
hours: "09:00 - 11:00\n09:00 - 11:00\n08:00 - 13:00\n09:00 - 11:00\n09:00 - 11:00\n08:00 - 13:00"
                                         6 ranges = 3 x 2
```

So: split `day` on commas and `hours` on newlines, cut the ranges into one block per Semester
when the count divides evenly by the day count, then zip each block against the days. A count that does not divide evenly is a Warning, not a
guess.

## A detail record

Keyed `"<code>|<semester>"`, using whatever the Semester cell said:

```
"89132|סמסטר א'": { points: "4.00", code: "89132-01", hours: "סמסטר א' - 4.00",
                     terms: [ { type: "מועד א'", date: "07/02/2027", hour: "16:00" },
                              { type: "מועד ב'", date: "26/02/2027", hour: "09:00" } ] }
```

- **`points`** — credits, course-wide. `0.00` to `6.00` here; `0.00` is real.
- **`hours`** — the Semester and the credits again, e.g. `"סמסטר א' - 4.00"`. Redundant.
- **`code`** — course **plus the Group the page was read from**, e.g. `89132-01`. It reflects
  which Group happened to be sampled, so it is **not** the Offering's identity and must not be
  used as one.
- **`terms`** — the Exams. Only `מועד א'` and `מועד ב'` appear in this data. A `מועד ג'` exists at
  BIU but is not offered to every student and is not generally published in the Catalog, so the
  model accepts any Moed label and requires none of them.
- **English name** — the detail page generally *has* this field, but it is not captured by any
  crawl on hand and is not reliably filled. It is the only route to an English Course name: the
  grid does not carry one. The Catalog must treat it as optional, which is what design already
  assumes — in English mode a Course with no English name shows its Hebrew name.

### Exams are not always shown

**`terms: []` does not mean the Offering has no Exams.** Exams appear on the detail page of the
**first lecture Group** of a (course, Semester), and nowhere else. Of every record carrying Exams
across the files on hand — 80 of them — **all 80 were sampled from that first lecture Group**, and
none from any later Group of any Lesson Type.

The converse gives the rest of the picture: 8 records *were* read from the first lecture Group and
still carried no Exams (89-390, 89-5993, 89-3592 among them), so some Offerings genuinely have no
Exam. Absence is therefore meaningful **only** when the record came from the first lecture Group,
and meaningless otherwise. Whether later lecture Groups would also carry the dates is unverified;
it has not been tested against the live page.

The same (course, Semester) read from two different Groups gives:

```
89132 Fall, from Group 02 (הרצאה, no Meetings):  { code: "89132-02", terms: [] }
89132 Fall, from Group 01 (הרצאה, with Meetings): { code: "89132-01", terms: [ מועד א' 07/02/2027, מועד ב' 26/02/2027 ] }
```

Both Groups are lectures. Group 01 is the first, which is what decides it — not the Lesson Type
and not the missing Meetings.

152 of this crawl's 184 detail records have no `terms`, overwhelmingly for this reason rather than
because the Offering has no Exam. When two Raw Crawls are merged, a record **with** Exams must win
over one without, whichever arrived later.

## The raw files on hand

The raw files for 2027 live in the sibling crawl repo, and they are not interchangeable:

- Some carry **rows only**, some carry **details only**, and one carries both. An importer must
  therefore accept a Raw Crawl with **no rows at all**.
- Multi-line cells are **clean in some files and run together without a separator in others** —
  `"סמסטר א'\nסמסטר ב'"` versus `"סמסטר א'סמסטר ב'"`, and likewise for multi-lecturer names. 99 of
  510 rows differ between two files in exactly this way. The run-together form is a crawl
  artifact, not a Shoham variant, but files carrying it exist, so an importer that rejects it
  rejects real data that is on hand.
- The artifact reaches **detail keys** too: 24 Year-long keys appear run-together in one file
  while other files use the two-line form. Merging details across files means normalising the
  Semester inside the key first, or the same (course, Semester) lands twice.
- The most complete picture of 2027 is the clean rows from one file plus the details of two
  others, the later overriding the earlier.

## Consequences

For the Importer:

- Parse the Semester field into a **set**; two entries mean Year-long.
- Accept both Year-long spellings and treat them as equivalent, not as an error.
- Split hours per Semester before zipping to days; warn on a count that does not divide evenly.
- Empty `day` and `hours` is an Untimed Group — normal, and not a Warning.
- Merge details by (course number, Semester) after normalising the key, preferring the record that
  has Exams. Treat an absent Exam list as *unknown* rather than *none*, unless the record came from
  the course's first lecture Group.
- Treat an English Course name as optional and absent from today's data.
- Never read identity out of a detail record's `code`.
- Accept a Raw Crawl with no rows, since details-only files exist.

For the domain model: `CONTEXT.md` defines a Group as having "a lecturer", but the data has **zero
or more**, and Untimed Groups are 144 of 510 rather than an edge case.

## Open facts this answers

Two entries under **Open facts** in [`../design.md`](../design.md), settled from data:

- *How Shoham shows Year-long Courses* — the Semester cell lists Fall and Spring on two lines,
  with no `שנתי` marker anywhere.
- *Does a Year-long Course keep the same Group in both Semesters* — yes. One row, one Group
  number, covering both Semesters, with its weekly hours repeated once per Semester.
