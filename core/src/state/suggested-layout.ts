import { compileProgram } from "../requirements/program.ts";
import type { LayoutEntry, RequirementsFile } from "../requirements/schema.ts";
import type { Attempt, AttemptId, State, StudentCohort } from "./schema.ts";
import { studyPointAt, type SemesterAt } from "./semester-order.ts";

/**
 * New Plan from Suggested Layout (#293): planned Attempts for every Course of the department's
 * Suggested Layout, created once and linked to nothing (`docs/design.md`, "Plan"), so the student
 * can then move or remove each one freely and no later edition of the layout reaches them.
 *
 * One `state -> state` function, handed to the guarded writer with one label, so the whole of it is
 * one undo step (ADR-0013). It hands back the State it was given when it creates nothing, which is
 * what a second run does: idempotent, because every Course the first run created now has an Attempt.
 */

/** One Attempt the layout created: its id, its Course and where it was placed. */
export type LayoutCreated = { id: AttemptId; courseNumber: string } & SemesterAt;

/**
 * A Course the layout names that was not created. `attempted`: the student already has an Attempt
 * of it, whatever its status, read through the file's Equivalences. `listed-twice`: an earlier entry
 * of the layout already named it, so it was created there.
 */
export type LayoutSkipped = { courseNumber: string; reason: "attempted" | "listed-twice" };

export type LayoutSummary = { created: LayoutCreated[]; skipped: LayoutSkipped[] };

/**
 * The layout a student on `track` follows: the base rule set's entries, then the Track's. A Track
 * the file does not have adds nothing, as it adds no Requirements (`compileProgram`).
 */
export function suggestedLayoutOf(file: RequirementsFile, track: string | undefined): LayoutEntry[] {
  const chosen = track === undefined ? undefined : file.tracks.find((t) => t.id === track);
  return [...file.suggestedLayout, ...(chosen?.suggestedLayout ?? [])];
}

/**
 * Creates a planned Attempt for each Course of the layout the student has no Attempt of, placed at
 * the Semester its study point falls in for `cohort` (`studyPointAt`), in the order the layout lists
 * them. Ids come from `newId`, so this stays pure.
 */
export function fromSuggestedLayout(
  state: State,
  file: RequirementsFile,
  track: string | undefined,
  cohort: StudentCohort,
  newId: () => AttemptId,
): { state: State; summary: LayoutSummary } {
  const { canonical } = compileProgram(file, track);
  const attempted = new Set(state.attempts.map((attempt) => canonical(attempt.courseNumber)));
  const listed = new Set<string>();
  const created: Attempt[] = [];
  const summary: LayoutSummary = { created: [], skipped: [] };

  for (const entry of suggestedLayoutOf(file, track)) {
    const at = studyPointAt(cohort, entry);
    for (const courseNumber of entry.courses) {
      const course = canonical(courseNumber);
      if (attempted.has(course)) {
        summary.skipped.push({ courseNumber, reason: "attempted" });
        continue;
      }
      if (listed.has(course)) {
        summary.skipped.push({ courseNumber, reason: "listed-twice" });
        continue;
      }
      listed.add(course);
      const attempt: Attempt = { id: newId(), courseNumber, ...at, status: "planned" };
      created.push(attempt);
      summary.created.push({ id: attempt.id, courseNumber, ...at });
    }
  }

  if (created.length === 0) return { state, summary };
  return { state: { ...state, attempts: [...state.attempts, ...created] }, summary };
}
