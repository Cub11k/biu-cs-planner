# Prototypes

Throwaway code that answers one design question. Nothing here becomes production code: the
winning ideas get rebuilt properly, and the rest is deleted.

## timetable.prototype.html

**Question:** what should the Timetable screen look like?

Three structurally different layouts of the same screen, over the same invented Catalog,
switchable with `?variant=A|B|C`, the floating bar at the bottom, or the arrow keys.

**Run it:** open the file in a browser. No server, no toolchain.

**Check it:** `node timetable.prototype.checks.js` reads the rendered markup and asserts the
screen's shape, the clash and exam results, the tile contents and the colour tokens. It catches
broken state, never ugly spacing — there is no browser automation here, so looks are a human job.

- **A — Three panes.** Tray, week, checks. The arrangement `docs/design.md` proposes.
- **B — Course-led list.** The week shrinks to a preview; the main surface is a list of
  Courses, each opening into its Groups as rows you compare (time, lecturer, fits or clashes).
- **C — Full-bleed grid.** One surface: chip rail on top, the week filling the screen, a
  drawer of Group options for the selected Course, and the exam period as a timeline.

**The visual language under test:** pencil means a possibility (dashed outline), ink means a
Pick (solid, colored by Lesson Type), red pen means a problem, hatching means time that is
taken. Each layout also has a he/en switch that flips the whole screen to right-to-left.

**What to look at:**

- Does picking a Group from the week feel better than picking it from a list?
- Is "this Course still needs a tirgul" obvious enough?
- Are two Clashes and four tight Exam gaps legible, or do they need their own screen?
- Does Hebrew right-to-left hold up, especially the week grid and the exam timeline?
- Where do Plan Diffs belong: a panel (A, B) or on the Course chips (C)?

Feedback of the form "the tray from A with the options list from B" is the expected outcome.

**Seeded state:** Semester A of 2026-27, 23 credits picked, one Course missing its tirgul,
one Course-vs-Course clash (89-112 lecture against the 89-1195 lab), one clash against blocked
work time, an online Course with no fixed time, a year-long Course, one Course the Catalog has
in Spring, and one Course missing from the Catalog. The `state` button in the floating bar
shows the full state behind the screen.

### Verdict (round 1)

**A won.** It needed more room, louder differences between tile states, and a clearer way in for
a first-time user. The group drawer and the exam timeline from C were worth keeping.

**Layout D** is that revision, and the default when you open the file: taller hour rows and a
roomier tray; ink tiles now carry a Lesson-Type tint and a thick edge, pencil tiles a 2px dash
and a "pick" label on hover, clashes a red border with a diagonal wash; each tray entry shows a
chip per lesson type (filled with the group number, or empty while missing); a hint line above
the grid says what to do and what the selected course still needs, with a legend; the group
drawer sits under the grid; the exam timeline replaces the exam list, so the side panel holds
only clashes and plan differences.

A, B and C are kept for comparison until the real screen is built. The decision is recorded in
`docs/design.md`.

### Round 2 notes and what changed

1. **Bug:** a previewed Group on hover lost its clash styling — it looked fine when it wasn't.
   Fixed: a preview now carries the red border and wash when it would clash, in every layout.
2. **The side panel felt empty.** Two answers to compare, since this one needs eyes:
   - **E** fills it with the exam period stood on its end: a vertical rail where the space between
     marks is the real gap in days, מועד ב lighter, tight gaps red.
   - **F** deletes it. The week gets the width and the exam period stays a horizontal strip below.
   Either way Clashes move to a red strip directly above the week, and Plan Diffs move onto the
   Tray, with their actions under the affected Course.
3. **The Group drawer moved above the grid** in both E and F.
4. **The Tray is untouched.**

**E is now the default.** Flip E ↔ F to settle the side pane; D, A, B and C remain for reference.

### Round 3 — decided

**Layout E is the agreed Timetable screen**, and the prototype opens on it. Also in this round:

- The Main/Backup tabs were falling back to unstyled buttons in E, because the tab styling was
  scoped to layout A. It is now shared, so they look as they did in A.
- **Course names are on the grid tiles**: name first, then course number · lesson type · group,
  with the times added when the block is tall enough. The small preview grid in B stays code-only.
- **A dark scheme**, built by redefining the color tokens rather than filtering the page: dark
  desk, raised "paper", and each lesson type lifted until it reads on a dark tile. It follows the
  OS, and the `system / dark / light` button in the prototype bar overrides it for inspection.

The decisions are folded into `docs/design.md`. F, D, A, B and C remain only as the record of how
the screen got here.
