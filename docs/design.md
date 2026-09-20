# Design

Agreed on 2026-09-11 in a design interview. No code exists yet. Terms follow [`CONTEXT.md`](../CONTEXT.md); the reasons behind hard-to-reverse decisions are in [`docs/adr/`](adr/); background research is in [`docs/research/`](research/).

**Next step:** build in the order under [Build order](#build-order).

The Timetable screen was settled by a throwaway prototype (`prototypes/timetable.prototype.html`). A grid-first screen won over a course-led list and a full-bleed grid, and Hebrew right-to-left held up in all of them. Round two moved the Group drawer above the grid, moved Clashes into a strip above the week, and moved Plan Diffs onto the Tray. Round three settled the side pane: it holds the exam period as a vertical rail. Layout E in the prototype is the agreed screen.

## Purpose and audience

- A BIU CS planner for the author and classmates. Other students using it is a bonus, not a goal; it does not need to be polished for strangers.
- The planner is used mostly around registration windows: right before each Semester, or once a year when registering for Spring in advance.
- Two jobs: laying out a degree across Semesters (the Plan), and building the Timetable for an Academic Year. **The Timetable is the main reason the app exists** and works with only a Catalog, without a Plan or Requirements File.
- It works offline. Personal data lives in real files on disk; the browser is only the screen.

## Data

Three kinds of file, each with its own lifecycle, each carrying a `schemaVersion`:

| File | Content | Changes |
|---|---|---|
| Catalog | Offerings of one Academic Year (Groups, Meetings, credits, Exams, Hebrew and English names) | Crawled once a year, re-crawled before registration windows |
| Requirements File | Rules, Pools, Prerequisites, Offering Patterns, Equivalences, policies and Suggested Layout for one Program and Cohort | Yearly or less often |
| State File | Attempts, Timetables, Pins, settings | Whenever the student edits |

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

**Every Requirement carries a stable id.** A Pin in the State File references a Requirement by that id and by nothing else, so an id has to survive a Requirements File being re-edited or reissued for a new Cohort — otherwise every Pin a student has made silently stops resolving. Ids are assigned by the maintainer writing the file, not derived from a Requirement's position in the tree or from its text, both of which move.

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

The three states need to differ in more than one property at once. Border style alone was too quiet to read. A previewed Group keeps its Clash styling, so hovering an option never makes it look safe.

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
- Spacing Warning when Exams are fewer than **3 days** apart (adjustable in settings).
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
          plus a Workspace port: list, read, write and watch files.
server/   Hono HTTP API exposing app/, filesystem Workspace adapter, static UI, CLI entry point.
web/      thin React UI; talks only to the HTTP API through Hono's typed client.
```

- `web` never imports `core` or `app`. It knows only the API contract, which is typed from the shared schemas without code generation.
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
- On first run the app offers to create this layout. Nothing is written without asking.
- **Autosave:** every edit saves the State File after a short delay, using atomic writes.
- **Undo/redo:** every edit is a command in `app`; the server keeps the undo history for the session.
- **Backups:** rotating snapshots in `.backups/` (last 20 saves plus one per day for 30 days), restorable from the Workspace screen.
- **External edits:** each save carries the file version it was based on. If the file changed on disk meanwhile (Dropbox, git, an editor), the server refuses the overwrite. The app then reloads and reports whether the last edit could be re-applied.
- The server watches the Workspace folder, not individual files, and the UI reloads on external changes.

## Security

### Authentication

| Threat | Defense |
|---|---|
| Malicious website in the same browser (CSRF, DNS rebinding) | Host and Origin checks, JSON-only writes, required `Authorization` header |
| Other OS users on the same machine | Launch token |
| Network access beyond loopback | Password required |
| Another process running as the same user | Out of scope: it can read the Workspace directly |

- The server binds `127.0.0.1` only. It rejects a non-localhost `Host`, cross-site `Origin` on writes, and non-`application/json` write bodies.
- **Launch token:** the CLI opens `http://localhost:<port>/#t=<token>`. The page stores the token in `localStorage`, removes it from the URL, and sends `Authorization: Bearer <token>` on every request.
- **Token storage:** the token lives in the user config directory, never the Workspace (which may be synced or committed). It is stable across restarts, so bookmarks keep working.
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
4. Requirement engine, Assignment solver, Progress
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

Answered on 2026-09-13 from a real crawl, in [`research/shoham-raw-shape.md`](research/shoham-raw-shape.md):

- **How Shoham shows Year-long Courses:** the Semester cell lists Fall and Spring on two lines, with no `שנתי` marker.
- **Does a Year-long Course keep the same Group in both Semesters:** yes — one row, one Group number, weekly hours repeated per Semester.
