# Design

Agreed on 2026-09-11 in a design interview, and built since in the order under [Build order](#build-order), which says how far that has got. Terms follow [`CONTEXT.md`](../CONTEXT.md); the reasons behind hard-to-reverse decisions are in [`docs/adr/`](adr/); background research is in [`docs/research/`](research/).

**Next step:** build in the order under [Build order](#build-order).

The Timetable screen was settled by a throwaway prototype (`prototypes/timetable.prototype.html`). A grid-first screen won over a course-led list and a full-bleed grid, and Hebrew right-to-left held up in all of them. Round two moved the Group drawer above the grid, moved Clashes into a strip above the week, and moved Plan Diffs onto the Tray. Round three settled the side pane: it holds the exam period as a vertical rail. Layout E in the prototype is the agreed screen.

## Purpose and audience

- A BIU CS planner for the author and classmates. Other students using it is a bonus, not a goal; it does not need to be polished for strangers.
- The planner is used mostly around registration windows: right before each Semester, or once a year when registering for Spring in advance.
- Two jobs: laying out a degree across Semesters (the Plan), and building the Timetable for an Academic Year. **The Timetable is the main reason the app exists** and works with only a Catalog, without a Plan or Requirements File.
- It works offline. Personal data lives in real files on disk; the browser is only the screen.
- **Several views of the same plan, open at once.** The workflow this replaces was a spreadsheet with four tabs open side by side, compared against each other — the author's own. So two tabs on one State File is a way of working the app supports, not an edge case it tolerates. It is why undo is one stack per document rather than per tab ([ADR 0013](adr/0013-undo-is-snapshots-not-commands.md)), why a save the app made is not hidden from the watcher that saw it, and why the page carries the revision of the file its edit was based on instead of the server remembering the bytes it last served — see [External edits](#storage) and [ADR 0015](adr/0015-a-revision-is-a-content-hash-the-page-carries.md).

## Data

Three kinds of file, each with its own lifecycle, each carrying a `schemaVersion`:

| File | Content | Changes |
|---|---|---|
| Catalog | Offerings of one Academic Year (Groups, Meetings, credits, Exams, Hebrew and English names) | Crawled once a year, re-crawled before registration windows |
| Requirements File | Rules, Pools, Prerequisites, Offering Patterns, Equivalences, policies and Suggested Layout for one Program, across one or more Cohorts (`cohorts` in `core/src/requirements/schema.ts`, PR #319) | Yearly or less often |
| State File | Attempts, Timetables, Pins, the student's Cohort and Programs, ticked Manual Requirements, settings (`stateSchema` in `core/src/state/schema.ts`, PR #330) | Whenever the student edits |

- Zod schemas in `core` are the single source of truth. They generate TypeScript types, validate every file on load and every request, and export JSON Schema so hand-written Requirements Files get editor autocomplete and inline errors.
- Migration functions upgrade older files on load, so old State Files keep opening.
- A State File references Courses by course number, never by Catalog entry, so it survives importing a new year's Catalog.
- No real data ships with the app. The code is data-agnostic on purpose; real Requirements Files come later.

## Sources

### Catalog from Shoham

- Shoham is the only Catalog source; it needs no login but sits behind Radware bot protection. See [`research/biu-sources.md`](research/biu-sources.md).
- The crawler lives in **its own repo** with a README covering how to run it and why it respects the site. It is not part of the app deliverable.
- **Flow:** the student opens Shoham in a browser, runs a query by hand, then pastes the crawler script into the console. The script walks every results page and requests each Course's detail page one at a time with a delay, and can resume if interrupted.
- **Output:** a Raw Crawl file with string fields as Shoham shows them, plus a `meta` block the Catalog keeps as provenance: what was queried, when it was crawled, by which crawler, against which page, and whether the run reached the end of its query. Older crawls carry none of it, and import anyway.
- **Import:** the app's Shoham Importer turns a Raw Crawl into Catalog data, showing a preview with counts and parse Warnings before writing. Importing merges by Academic Year and course number, so crawls of several departments (e.g. for a double major) combine into one Catalog. A Raw Crawl is a **part** of a year and the app merges parts; several can be imported in one action. See [ADR-0010](adr/0010-raw-crawl-is-a-part-the-app-merges.md).
- **Re-import:** before confirming, the importer shows what changed (Groups added, removed, moved). A part speaks for a Course it carries rows for, and within it for the Offerings whose Semesters the part covered; Groups it does not name there are superseded, with a Warning. See [ADR-0011](adr/0011-a-part-speaks-for-the-offerings-it-carries-rows-for.md). Afterwards, every Variant is compared against the new Catalog using its Pick snapshots:
  - a moved Group gets a "changed since picked" badge showing old and new times
  - a removed Group becomes "no longer offered" and its Course returns to unassigned

### Requirements and Prerequisites

- The department publishes degree requirements and the Suggested Layout as PDF or Excel, and Prerequisites as a PDF, each updated yearly or less often.
- A maintainer converts these by hand, possibly with an LLM's help, into a Requirements File. The app understands only JSON.
- Prerequisites live in the Requirements File, grouped by department.

### Data repo

- Published Catalogs and Requirements Files live in a **separate data repo**, not the MIT-licensed code repo.
- The app has a "check for data updates" button that reads an index file at a configurable URL. It runs only on explicit click, never in the background.
- The server performs the fetch: HTTPS only, with size and time limits. It shows the source and a summary before anything is written to the Workspace.
- Students can always import files they got elsewhere, or crawl their own.

## Domain rules

### Requirement vocabulary (v1)

Requirements form a tree of these building blocks:

- `course(X)`, `allOf[…]`, `nOf(k, […])`, `credits(min, Pool)`
- `cap(max, Pool)`: at most this many credits from a Pool count
- `exclusive[A, B]`: only one of them counts
- Equivalence declarations for renumbered Courses
- Prerequisites: `passed(X, minGrade?)`, concurrent taking allowed, a reference to a named set ("all first-year Courses"), or a Manual Requirement carrying the original text
- Offering Pattern per Course: Fall, Spring or Year-long
- Policies: passing grade, and whether a minimum grade is checked against the best or the latest passing Attempt
- Non-course requirements (English level, Hebrew expression, Jewish studies): Manual Requirements, or satisfied by exempt or credited Attempts
- Programs: a base rule set plus a Track. A double major is two Programs evaluated against the same Attempts, with overlap rules.

Anything the vocabulary cannot express becomes a Manual Requirement with its text. New building blocks are added only when real data forces them.

**Every Requirement carries a stable id.** A Pin in the State File references a Requirement by that id and the Requirements File it is in, and a ticked Manual Requirement the same way (`CONTEXT.md`, "Pin", ruled on #287), so an id has to survive a Requirements File being re-edited or reissued for a new Cohort — otherwise every Pin a student has made silently stops resolving. Ids are assigned by the maintainer writing the file, not derived from a Requirement's position in the tree or from its text, both of which move.

### Assignment

- A solver finds the Assignment that satisfies the most Requirements. The student can Pin a Course to a Requirement.
- By default a Course counts once among sibling Requirements, while totals count everything. A Requirements File can allow double counting explicitly, including whether a Course counts in both Programs of a double major.

### Plan

- The Plan is the student's Attempts. Past Attempts carry results; future ones are `planned`. A retake is another Attempt.
- Statuses: planned, registered, passed, failed, exempt, credited. Grades are numeric or pass/fail, with no GPA for now. Grades exist because some Prerequisites demand a minimum grade.
- Exemptions (English level, preparatory math) are Attempts with the `exempt` status.
- Completion is per Course, not per Group or per assignment, midterm or final.
- The Plan axis is real Semesters (e.g. 2026-27 Fall/Spring/Summer), starting from the Cohort, with Summer collapsed by default.
- "New Plan from Suggested Layout" creates planned Attempts once and keeps no link to the layout.
- The Plan is checked against the Requirements File, never the Catalog. Future years have no Catalog; the Offering Pattern stands in for it.
- **Plan checks, all Warnings:**
  - Prerequisite order, allowing concurrent taking where the rule says so
  - Semester against the Offering Pattern, skipped when the pattern is unknown
  - Year-long Course split across years
  - credit load per Semester
  - missing Requirements
  - progression deadlines, when the Requirements File defines them

## Timetable

- A Timetable covers one Semester of the current Academic Year and uses that year's Catalog only.
- It holds named Variants (one primary) and Blocked Times. Blocked Times are per Semester and can be copied to another Semester.
- The planner assumes registration succeeds; first-come-first-served group filling is out of scope.

### Visual language

Decided in the prototype, because Pick state has to be readable at a glance across a full week:

- **Pencil** (dashed outline on the surface color) is an option you have not taken: an unpicked Group of the selected Course.
- **Ink** (solid border, a thick edge and a tint in the Lesson Type's color) is a Pick.
- **Red pen** (red border plus a diagonal wash) is a Clash.
- **Hatching** is time already taken: Blocked Time, or a pencil option that would Clash.
- **Not read yet** (dotted, in the pencil grey rather than a Lesson Type hue) is a Group whose Pick state nobody has read: the Catalog and the State File are asked for in parallel, so the week is drawn before the Picks are known, and drawing that as pencil would be a week affirming that nothing is picked. A click made on it is held and sent once the Picks arrive (#111).

  Usually it lasts milliseconds, but it is **not** only transient: it is also what a week looks like when the State File could not be read at all, which does not resolve on its own. So it may not be drawn by dimming the tile — that composites its 11px detail line toward the paper and takes it below 3:1, and an opacity is the one colour change a token the dark scheme redefines cannot rescue. It carries no legend entry even so, because whenever it persists the notice line beside the week says in words *why* the Picks are unknown, which a swatch cannot; the legend is about Pick state, and this is about what has been read.

The states need to differ in more than one property at once. Border style alone was too quiet to read. A previewed Group keeps its Clash styling, so hovering an option never makes it look safe.

**Light and dark.** Every color is a CSS token, and the dark scheme redefines the tokens rather than filtering the page: the ground becomes a dark desk, "paper" a raised surface, and each Lesson Type hue is lifted until it reads on a dark tile. It follows the operating system, and an explicit choice overrides it in both directions. Component styles never hold raw color values.

### Grid and Picks

- **Layout:** Sunday–Thursday columns, with Friday shown only if some Group meets on Friday. Hour lines with fainter half-hour lines, and an hour range that fits the Offerings. Blocks sit at their exact minutes.
- **Tile content:** the Course name first, since that is what students scan for, then course number · Lesson Type · Group, plus the times when the block is tall enough. Names wrap to two lines, or one in a short block.
- **Showing options:** selecting a Course in the Tray shows all its Groups as faint blocks colored by Lesson Type. Faint blocks that would Clash with current Picks are hatched.
- **Picking:** two ways, both live at once.
  - Clicking a pencil block on the week Picks that Group for its Lesson Type, and the other Groups of that type fade.
  - A **Group drawer** above the grid lists the selected Course's Groups as cards with times, lecturer and either "fits" or what it Clashes with. Hovering a card previews it on the week; clicking it Picks.
- A Group with several Meetings is picked as a whole; hovering highlights all its Meetings.
- **Complete and incomplete Courses:** a Course needs one Pick per Lesson Type it has, all in the same Semester. Until then it is marked incomplete.
- **Year-long Courses:** one Pick per year, and the same Group covers both Semesters — confirmed from a real crawl, see [`research/shoham-raw-shape.md`](research/shoham-raw-shape.md).
- **Untimed Groups** sit in a "No fixed time" strip under the grid. They count toward credits and Exams and never Clash.
- **Clashes:** picked blocks that overlap sit side by side with a red border, as a Warning only.
- **Tray contents:** the Semester's planned Attempts plus Courses added directly. Each Tray entry carries one chip per Lesson Type the Course has, filled with the Group number once picked and empty while missing, so what is still needed is visible without opening the Course.
- **Tray badges:** "offered in the other Semester", "not in this year's Catalog", "not in Plan". Each badge links to its Plan Diff action.
- **Guidance:** a hint line above the grid tells a first-time student what to do, names what the selected Course still needs, and carries a legend for pencil, ink and red pen.

### Exams

- Exams belong to the Offering and are shared by all Groups.
- Every Moed is checked. A Clash is any two Exams on the same day, whichever Moed each belongs to; students decide what matters.
- Spacing Warning when Exams are fewer than **3 days** apart, adjustable in settings — and the stored setting is what the check is given, never a default standing in for it. The exam period is read per request, from the State File the threshold and the Picks are in plus that year's Catalog, because an Exam belongs to the Offering and no Pick carries one.
- The threshold is a count of calendar days: **whole, and never negative**. `0` is allowed and means *never warn me about spacing* — the check warns on a gap *fewer* than the threshold and two Exams on one day are a Clash, so zero raises nothing. A write of anything else is refused as the shape of the request it is, before the domain sees it; a State File already holding one still opens, with the field at its default and a Warning naming it, because a bound on a value is not a reason to lose a student's file.
- v1 draws the exam period as a **vertical rail** in the side pane rather than a list, so the gaps can be felt: one mark per Exam, the distance between marks proportional to the days between them, מועד ב lighter, tight gaps in red.

### Plan Diff

- A Variant and the Plan never sync automatically. Divergences show as Plan Diffs, each with a one-click "apply to Plan" (move to the other Semester, drop, add).
- Marking a Variant as registered offers to apply all its Plan Diffs at once.

### Generator (after the manual grid)

- It lists valid Group combinations for the Tray, ranked by preferences: free days, earliest start, gaps, Exam spacing, Blocked Times. It creates Variants that the student then adjusts by hand.
- It runs under hard time and iteration limits.

## Screens

1. **Timetable** (landing): year, Semester and Variant tabs on top; Tray on the left; grid in the middle; side panel with Clashes, Exams and Plan Diffs.
2. **Plan:** a column per Semester, grouped by year. Course cards drag between columns, and Warnings show on the cards.
3. **Progress:** the Requirement tree with satisfied and missing items, Pinning, and "what if I switched Track".
4. **Courses:** Catalog search (department, Semester, day and time, Lesson Type). A Course page shows Groups, Exams, Prerequisites and the Requirements it can count toward.
5. **Workspace:**
   - imported Catalogs and Requirements Files
   - State Files, with a picker when there are several
   - import and "check for data updates"
   - backups and restore
   - settings: language, Exam spacing

## Architecture

```
core/     pure domain: Requirement engine, Assignment solver, Plan checks, Clashes, Exams, generator.
          No I/O, no DOM, no fetch.
app/      use cases (importRawCrawl, addAttempt, createVariant, diffVariantAgainstPlan, …)
          plus a Workspace port: status, create, list, read, write and watch files.
server/   Hono HTTP API exposing app/, filesystem Workspace adapter, static UI, CLI entry point.
web/      thin React UI; talks only to the HTTP API through Hono's typed client.
```

- `web` never imports `core` or `app`. It knows only the API contract, which is typed from the shared schemas without code generation.
- That one edge, `web → server`, is narrowed twice over: to types, and to the **erasable** spelling of a type import. `import type { ApiType } from "@biu-cs-planner/server"` is what `web/src/api.ts` writes and the only form allowed. Under `verbatimModuleSyntax` (set in `tsconfig.base.json`) TypeScript emits imports as written: `import type { X } from "m"` disappears, while the inline `import { type X } from "m"` emits `import {} from "m"` — a specifier a bundler still has to resolve, which would pull `server/src/index.ts` → `workspace.fs.ts` → `node:fs/promises` into the browser bundle. The re-export forms split the same way (`export type { X } from` erases, `export { type X } from` does not) and are judged by the same rule.
- The allowed edges are data in `tools/pr-review/layering.ts`, which is what the graph check on every pull request enforces. A narrowed entry there **always** means erasable: there is no weaker narrowing to choose, because the only reason to narrow an edge is that code must not travel along it.
- One repo with npm workspaces, published as **one** npm package, `biu-cs-planner`. It contains the bundled server (zero runtime dependencies), the built UI and a `bin` entry. The name was unclaimed on npm on 2026-09-11.

## Storage

- A Workspace is a folder: the current directory, or `--workspace <path>`.
  ```
  my-degree/
    catalogs/2027.json
    requirements/cs-single-2027.json
    alice.state.json          (one or more State Files)
    .backups/
  ```
- On first run the app offers to create this **Workspace Layout** — the folders above, which is what the code and both Workspace adapters mean by "the layout", and not the department's Suggested Layout. Nothing is written without asking.
  - **Creating it is not transactional, and does not need to be** (#166). The adapter makes the folders one at a time and does not roll back, so a create refused part way — a `requirements` it cannot make after `catalogs` was made — leaves the earlier folders standing. What a refused create guarantees is that nothing already there was replaced, not that the folder is untouched. `status()` is how to see what it left: it reports which parts of the Workspace Layout are missing, and accepting the Workspace Layout again makes the rest once whatever refused it is fixed. A name the Workspace Layout needs that a plain file holds is not missing: `status()` reports it apart, under `notAFolder`, and the Workspace is not ready (`statusOf` in `app/src/workspace.ts`, #243, PR #316); `create` cannot make it, and the next create or write refuses it by name. A half-made Workspace Layout is a state the app can describe and recover from, of empty folders that cost nothing; a half-written State File is neither, which is why the write path is atomic and this one is not. So whatever the Workspace screen (#238) says after a refused create, it must not say that nothing was changed.
- **Autosave:** every edit saves the State File after a short delay, using atomic writes.
- **Undo/redo:** an edit is a pure function in `core`; `app` keeps the previous State File value on a
  stack with the label the use case supplied, and undo writes an earlier value back through the same
  guarded save. One stack per open State File, settings excluded, the last 100 edits or 8 MB, held in
  memory and gone on restart. There is no command concept ([ADR 0013](adr/0013-undo-is-snapshots-not-commands.md)).
- **Backups:** rotating snapshots in `.backups/` (last 20 saves plus one per day for 30 days), restorable from the Workspace screen. Built in #67, and these are the decisions it made:
  - **A snapshot is a copy of what a save replaced**, taken out of the bytes the save read for the external-edit guard and written before the rename. So a first save leaves no snapshot — it replaced nothing — and every save after it does. That reading is what makes "restoring first backs up what it replaced" fall out of the save path rather than being arranged: a restore is an ordinary save, so it snapshots like one.
  - **Both halves of the retention rule keep, and what is left over is deleted**, never the other way round. The two disagree in the interesting cases: 200 saves in one afternoon keeps the last 20 *and* that day's newest once those age out; the app opened once a month keeps saves from months ago because they are among the last 20, so age alone deletes nothing; a day with nothing saved is a day with nothing to keep and no reason to hold on to something older. The rule is one pure function in the Workspace port (`backupsToPrune`), shared by both adapters so neither can prune differently, and the day a snapshot belongs to is a **UTC** day — a local one would re-bucket a student's snapshots when they changed timezone, and pruning is the part that destroys data.
  - **A snapshot that cannot be written refuses the save.** `.backups/` is part of the Workspace Layout and a save already refuses when a part of it is missing, so an unwritable one is the same refusal from the other side. Saving anyway and quietly keeping no backup is invisible until the day it matters. **Pruning is the other way round**: it runs after the save, it only deletes, and a snapshot it could not remove is one too many rather than one too few, so it never costs a student their save.
  - **A backup is not a `WorkspaceRef`.** Nothing above the port ever asks for one to be written, so there is no write for a ref to name; a third kind in that union would hand `write` a third target and would weaken `requireCatalogRef`, whose last line refuses on `ref.name`. `app` reaches snapshots through `listBackups` and `readBackup` and through nothing else, which costs it the ability to enumerate the folder itself and buys that the only thing writing into `.backups/` is the save.
  - **A snapshot is read through the same reader a State File is**, `parseStateFile`, with the same migration table behind it — because opening a file an older build wrote is what a backup is *for*. It is forgiving in the same way too: a snapshot with one unreadable entry restores the rest and says what it dropped, and only one that is not a State File at all is refused.
  - **The current `settings` survive a restore.** [ADR 0013](adr/0013-undo-is-snapshots-not-commands.md) keeps `settings` off a snapshot's type, so a restore cannot put a preference back — a restore is an undo of many edits at once, and undoing a Pick may not flip the UI language. The file in `.backups/` does hold the settings of its moment; the restore leaves them there.
  - **The newest thing in `.backups/` is the state *before* the last save**, and never the last-saved content itself. A snapshot is of what a save replaced, and a save over a file somebody else wrote is refused by the external-edit guard before it reaches the snapshot — so when Dropbox, git or a second tab overwrites a State File, no copy of the student's last-saved content is taken. That is the right trade: the other writer's bytes are still on disk unoverwritten, which is the thing worth keeping, and the refusal is what keeps them. Written down so nobody reads `.backups/` as holding every revision of the file.
  - **The routes exist and no page calls them yet.** `GET /api/backups` lists the moments and `POST /api/backups/restore` names one; the Workspace screen that would show them is not built, so nothing renders their refusals. A snapshot is named by **when it was taken** and never by a path, as every other route names a year, a Semester or a course number.
  - **What a student is told when `.backups/` is the problem is wrong today, and backups are what made it reachable.** A `.backups` that is a plain file, or one the app may not write into, refuses the *save* — and `app/src/edit.ts` words every refusal out of the Workspace port as `workspace-refused`, which `web/src/timetable/TimetableScreen.tsx` maps to "Your saved picks could not be read, so the week shows none of them." Both halves of that sentence are false in this case: the Picks read perfectly and the week is showing them. `web/src/i18n/strings.ts` already records `picksUnreadable` as the precedent that is wrong in the same way and defers it; what is new is that an ordinary folder permission now reaches it, on the one screen that exists, from the ordinary click-a-Group path. The fix is a reason of its own on `EditRefusal` — the Timetable screen's map is exhaustive over that union, so adding an arm forces a string for it — and it is a ticket rather than a line here, because it crosses `app`, `server` and `web`.
  - **Two things the Workspace screen must not inherit when it is built.** `warningWorkspaceRefused` in `web/src/i18n/strings.ts` is about a *Catalog* read — "The workspace would not read the catalog file" — and the `workspace-refused` → `picksUnreadable` mapping above is about Picks. Neither sentence is true of a Workspace screen, and the reason word is shared across routes deliberately while the sentence must not be: a screen that reused either would tell a student their Picks are unreadable when what happened is that a folder could not be created. The row that route wants was written out and measured on PR #150 and is still unwritten, because `POST /api/workspace`'s `409 { "reason": "workspace-refused" }` has no caller.
- **External edits:** each save carries the revision of the file it was based on. If the file changed on disk meanwhile (Dropbox, git, an editor, another tab), the server refuses the overwrite, and the page says so and re-reads the file as it now is.
  - **A revision is a SHA-256 of the file's bytes as read, taken in the Workspace adapter, and the page holds it and hands it back.** Not an mtime, not the parsed document, and not the server remembering the bytes it last served: [ADR 0015](adr/0015-a-revision-is-a-content-hash-the-page-carries.md) records why each of those loses, and `CONTEXT.md` glosses **Revision** against the other things this repo calls a version. The type is still spelled `StateFileVersion` and the field `version`.
  - A save based on **no** revision is the claim that the file does not exist, and is refused when it does. So a client that forgets to send one can create a State File and can never overwrite one: forgetting fails closed.
  - This is a refusal and not a Warning, and it is not the only one: every refusal in the app is about the folder or the file rather than about what the student chose. A folder that is not a Workspace yet is not silently made into one. A State File or a stored Catalog this build cannot read back is not overwritten, because it may be hand-edited and replacing it would lose whatever it holds. And a target the Workspace will not touch at all — a name that is a path, a file resolving outside the folder, a file that is there and cannot be read — is refused as a `WorkspaceRefusedError` and not by this guard's `StateFileChangedError`, because nothing changed and there is no revision it could honestly report as found; reporting an unreadable file as absence instead would let a save based on there being no file overwrite one that was there all along. Every domain check, by contrast, is a Warning and the edit goes through, because a Warning costs the student nothing and leaves them the decision; here going through means destroying work nobody can see any more, and the Warning would be a note attached to the loss.
  - Reporting whether the refused edit could be re-applied is not built yet. ADR-0013 makes it tractable — an edit is a pure `state -> state` function, so it can simply be called again on the newly-read State — but what "could be re-applied" means when the function succeeds and produces something unrecognisable (a Pick re-applied into a Variant somebody deleted) needs its own ruling.
- **Encoding:** a leading UTF-8 BOM is not content, and is dropped on read. Several Windows editors add one, and a Catalog dropped into `catalogs/` by hand or a State File somebody edited is exactly the file that arrives carrying one, so a file whose bytes begin with a BOM is read as the JSON it holds rather than coming back as text nothing can parse. The **revision is still of the bytes as read, BOM included**: two files differing only by a BOM are two files on disk, so one State File stored with a BOM and without it has two revisions — and a guard that called them one revision would be blind to whichever tool added or removed it.
- The server watches the Workspace folder, not individual files, and the UI reloads on external changes. Watching the folder is what sees a Catalog *appear* — dropped into `catalogs/` by hand, arriving with a git clone, landing over Dropbox — which watching a file cannot. One `fs.watch` per watched folder — the Workspace root, `catalogs/` and `requirements/` — non-recursive, so that a `.git` inside the Workspace does not turn every git operation into a reload. `.backups/` is not watched: a rotating snapshot is written only by the app and nothing in it is shown, so once autosave lands its snapshots would otherwise be a reload each.
  - **The app's own writes move the count, on purpose.** Autosave, a Catalog import, an undo and a restore from a backup all land in a watched folder, and every one of them is reported: the folder really did change, and a counter that said otherwise would be lying. **Nothing suppresses anything** — the page is what stops being harmed. It re-fetches and reconciles rather than resetting, keeping what is on screen until the new answer arrives, so a reload a page triggered itself costs one loopback request and nothing visible. The fix lives in `web`, where the harm was, and not in the watcher (#88).
    - Suppression in the Workspace adapter was rejected because **the count is global**: one number serves every poller and there is no per-connection state anywhere on that path, so an adapter that swallowed the event its own write caused would swallow it for *every* page. **Two tabs on one document**, which this app supports: tab A's save **is** tab B's external change, and both tabs hear it, including the tab that made it. The saving tab re-reads its own bytes — a wasted request, never a wrong screen — and tab B reloads, which is the behaviour the bullet above promises and the one a global suppression would quietly take away.
    - Suppressing only the temporary file is insufficient: the rename onto the real name is the event that matters and is indistinguishable from an editor saving that file. Having the page tolerate exactly the next bump after its own save was rejected too, because a genuine external edit landing inside the same settle window is swallowed with it. And a save cannot simply *return* the count it caused: the count moves once the folder has gone quiet, which is long after the save's response went back.
    - **Telling the app's own write from someone else's is the save guard's job, not the watcher's.** The guard answers it from content — the revision a save was based on — which is why it is exact where a filesystem event cannot be. The undo stacks answer the same question the same way, and it is why a State File changed on disk empties them ([ADR 0013](adr/0013-undo-is-snapshots-not-commands.md)).
    - **So `.backups/` stays a special case on its own merits, not as an instance of a general rule.** Nothing in it is ever shown, so watching it could only ever cause work. That is the whole reason, and it does not reach the root or `catalogs/`, where what is written *is* shown and an external edit to it is exactly what the watcher exists for.
    - This binds the three tickets that save: the first save from the UI (#80), backups (#67) and undo (#73). None may add suppression, and each must leave the page able to tolerate its own write.
- **How the page hears about it:** each settled burst of filesystem events moves a count, and `GET /api/workspace/changes` serves it; the page remembers the last count it saw and reloads what it is showing when the number differs. A count and not a revision: it restarts at 0 with the server, and nothing compares a file against it. A number the page **asks for**, not news the server pushes: `web` reaches the domain only through the HTTP API and may gain no second source of truth, an `EventSource` cannot send the launch token in an `Authorization` header (which would put it in a query string, the arrangement [ADR-0004](adr/0004-localhost-auth-bearer-token.md) turned down), and a websocket upgrade needs a different adapter on each of Node, Bun and Deno — a Node-only API in a server that avoids them. Pushing can be added behind the same count later without `web` learning anything new.
- Bursts are debounced rather than throttled: an editor writing one file emits several events and a clone emits many, and each should be one reload, after the folder is quiet.

## Security

### Authentication

| Threat | Defense |
|---|---|
| Malicious website in the same browser (CSRF, DNS rebinding) | Host and Origin checks, JSON-only writes, required `Authorization` header |
| Other OS users on the same machine | Launch token |
| Network access beyond loopback | Password required |
| Another process running as the same user | Out of scope: it can read the Workspace directly |

- The server binds loopback only: `127.0.0.1` by default, and `--host` also accepts `localhost` and `::1` (bracketed as `[::1]` too), (`LOOPBACK_ADDRESSES` in `server/src/cli.ts`), the same three names the `Host` check accepts (`LOOPBACK_NAMES` in `server/src/guard.ts`). It rejects a non-localhost `Host`, cross-site `Origin` on writes, and non-`application/json` write bodies.
- **Launch token:** the CLI opens `http://localhost:<port>/#t=<token>`. The page stores the token in `localStorage`, removes it from the URL, and sends `Authorization: Bearer <token>` on every request.
- **Token storage:** the token lives in the user config directory, never the Workspace (which may be synced or committed). It is stable across restarts, so bookmarks keep working.
- **Rotation:** `biu-cs-planner rotate-token` replaces it, and replacing the file is the whole of the revocation — the token has no expiry and nothing keeps a list of retired ones. This is the other half of the bullet above rather than a separate feature: stability is what makes a leak permanent, and the launcher prints the token inside a URL, which is what ends up in a pasted bug report or a screenshot. Written to a temporary name in the same directory and renamed over the token file, `0600` inside a `0700` directory, so an interrupted rotation leaves the old token whole rather than a truncated one the next launch would still match against `TOKEN_PATTERN` and trust for good. It prints the path and no URL: nothing is listening yet, so a port would be a guess, and reprinting a fresh secret into the scrollback that leaked the last one would undo the rotation being reported. **A command and not a button in the page:** a page holding a leaked token would otherwise be authorising its own replacement, and could lock the student out of their own planner — reaching the terminal proves more than holding the token does. **It finishes at the restart, not at the command:** a running server read the token once at startup and holds it in memory, so the retired token keeps opening that process until it exits. That is ruled, not merely current behaviour (#128): re-reading the file per request would put a filesystem touch and a new failure mode on the authentication path — a token file missing or unreadable mid-run would have to mean something other than "let everyone in" — and watching it would be a second watcher for one file, while the server is bound to loopback anyway. The reasoning is kept at the top of `server/src/token.ts`. So the cost is paid in words: `rotate-token`'s output and `--help` both say plainly that a server already running keeps the old token until it is restarted, and the output says to stop it with Ctrl-C, because a notice claiming the old token was refused already would tell a student they were safe with the leak still open. From the next start every bookmark and every open tab is refused, which is the point of it. An open tab keeps its retired token in `localStorage` and goes on sending it, so every read and write comes back 401 — and since #126 **it finds out on its own**: the change poll reports a refusal once on entering it and once on leaving it, the screens re-read, and the page says its launch token was refused (`tokenRetired`, distinct from `tokenMissing` for a page that never had one) — the Picks still leave the week, because they cannot be read, but the page says why instead of looking healthy.
- **Pairing code:** a browser without a token is asked for a 6-digit code printed in the terminal. The code is single-use, expires after 5 minutes, and allows 5 attempts. Later, `biu-cs-planner url` prints the token URL.
- **Password:** binding beyond loopback (`--host`) is refused unless a password is set. It is stored as a scrypt hash in the user config directory, with rate-limited login.

The rejected options (cookies, TLS, sockets) are in [ADR 0004](adr/0004-localhost-auth-bearer-token.md).

### API and data rules

1. The API exposes domain operations, never file paths. File access is confined to known Workspace subfolders after resolving symlinks, `.json` only, with atomic writes and request size caps.
2. Every request body and every file read goes through Zod. Unknown keys are stripped, `__proto__` and `constructor` keys are rejected, and raw input is never merged into existing objects.
3. Requirements and Catalog data are interpreted, never executed: no `eval`, no `new Function`, no regular expressions from data. Pools match by prefix or range.
4. The solver and generator run under hard time and iteration limits.
5. **UI hardening:**
   - no `dangerouslySetInnerHTML`
   - links from data allowed only with `https:`
   - strict CSP (`default-src 'self'`, no inline scripts)
   - `frame-ancestors 'none'`
   - `X-Content-Type-Options: nosniff`
6. The "check for data updates" fetch happens on the server, as described under [Data repo](#data-repo).
7. **Supply chain:**
   - bundled server with zero runtime dependencies
   - committed lockfile
   - no install scripts: none in the published package, and none run by CI — every workflow installs with `--ignore-scripts`
   - published from GitHub Actions with npm provenance and trusted publishing

## CLI and distribution

- **Run:** `npx biu-cs-planner`, or install with `npm i -g biu-cs-planner` and remove with `npm rm -g biu-cs-planner`.
- **Runtimes:** Node ≥22, raised when Node 22 reaches end of life (April 2027). The server avoids native modules and Node-only APIs where possible, so `bunx` and `deno run npm:` work too.
- **Port:** a fixed default port, **8900** (echoing BIU's 89- Computer Science prefix), so the URL is bookmarkable. If it is taken, the server uses the next free port and says so.
- **Single instance:** a lock file in the Workspace. Launching again while one is running opens the browser to the running instance.
- **Browser:** opens by default; `--no-open` skips it. The URL is always printed. The server runs in the foreground of the terminal.
- **App updates:** `npx biu-cs-planner@latest`, or an in-app "check for app update" button (explicit click) that shows the command.
- **Releases:** pushing a git tag triggers CI to test, build and publish.

## Language and direction

- English and Hebrew UI with a switch. Hebrew translations can come after v1.
- **Right-to-left support is mandatory from the first component:**
  - every string goes through translation files
  - direction-neutral CSS only (Tailwind `ms-`, `me-`, `start-`, `end-`)
  - `dir` set on the root
- Course names come from Shoham in both languages. In English mode, a Course with no English name shows its Hebrew name.

## Development

- Stack: Node 24 LTS, TypeScript, npm workspaces, Vite for `web` (dev server proxies to the API), esbuild bundles `server`, Vitest, React and Tailwind.
- Node and npm come from the machine; see [`CLAUDE.md`](../CLAUDE.md).
- `@types/node` tracks the supported **floor** (Node 22), not the development runtime, so reaching for a
  Node-24-only API is a typecheck error here rather than a CI failure on the Node 22 job.
- **Tests:**
  - `core` is test-driven with small invented fixture Catalogs and Requirements Files, independent of real data. It covers the engine, solver, Clashes, Exam spacing, generator and migrations.
  - The Shoham Importer is tested against real Raw Crawls kept as fixtures. The crawler repo tests its parsing against saved Shoham HTML pages, including a Year-long Course.
  - The Workspace adapter gets integration tests against a temporary folder.
  - The Timetable's layout is asserted in a real Chromium (Vitest browser mode, Playwright provider): that the week reads right to left in Hebrew, that a time range survives a Hebrew line, that tiles stay in their columns, that the dark tokens resolve, and that the runner can draw Hebrew at all. Geometry, not appearance — screenshot baselines wait for the Timetable design to stabilize.
  - UI end-to-end tests (Playwright driving a running server) wait until the Timetable screen design stabilizes.
- CI runs the node tests on Node 22 and 24 and the browser tests in Chromium, plus a start-up smoke test on Bun
  and Deno. The browser leg installs a Hebrew font deliberately: a runner that draws tofu boxes still passes every
  layout assertion, so a suite that is green on one is worse than no suite.

## Build order

1. Schemas and migrations
2. Shoham Importer and Catalog import (crawler built alongside, in its own repo)
3. Timetable: manual grid, Variants, Clashes, Exams, Blocked Times; then the State File and Workspace storage
   - Built, the Tray included: Variants, Blocked Times and the Tray landed in PR #317. Exams are checked (`app/src/exams.ts`, served at `/api/timetable/:year/:semester/exams`), and the side pane's exam-period rail is not drawn yet.
4. Requirement engine, Assignment solver, Progress
   - The engine and the solver exist in `core` (`core/src/requirements/`, PR #319): the Requirements File, Progress evaluation and the Assignment solver. The app reaches them and the Progress screen shows them since PR #330 (`app/src/progress.ts`, `web/src/progress/`).
5. Plan screen and Plan checks
6. Plan Diffs
7. Generator
8. Data repo index and "check for data updates"
9. Hebrew translations

## Deferred

- Real Requirements Files and double-major overlap rules, until the data lands
- Desktop shortcuts and a background server without a terminal. Research recorded in [`research/distribution.md`](research/distribution.md).
- Docker image and platform installers
- A form-based Requirement editor
- Manual English name edits (an overrides file in the Workspace)
- Full exam calendar view, beyond the timeline
- Refining the dark palette: the current lesson-type hues read as too neon
- Generator preference details
- Data repo index format

## Open facts

- Is a minimum-grade Prerequisite checked against the best or the latest passing Attempt? A policy setting in the Requirements File until the author checks.
- **Where does a Spring Cohort's Suggested Layout land?** Built (#293) as: a study year begins at the Cohort's own Semester and every Semester keeps the one the layout gives, so a Spring 2027 Cohort's year-1 Spring is 2027 Spring and its year-1 Fall is 2028 Fall (`studyPointAt` in `core/src/state/semester-order.ts`). It keeps every Offering Pattern and never puts two study points in one Semester; the cost is that year-1 Fall Courses land after year-1 Spring ones. Progression deadlines are placed by the same rule. Unconfirmed against the department's convention for mid-year Cohorts.

Answered on 2026-09-13 from a real crawl, in [`research/shoham-raw-shape.md`](research/shoham-raw-shape.md):

- **How Shoham shows Year-long Courses:** the Semester cell lists Fall and Spring on two lines, with no `שנתי` marker.
- **Does a Year-long Course keep the same Group in both Semesters:** yes — one row, one Group number, weekly hours repeated per Semester.
