import {
  parseCatalogFile,
  planDiffs,
  type Offering,
  type PlanDiff,
  type PlanDiffContext,
  type State,
  type StateFileVersion,
  type VariantRef,
} from "@biu-cs-planner/core";
import { readStateFile } from "./edit.ts";
import { loadRequirementsFiles, type RequirementsListing } from "./requirements.ts";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

/**
 * What a Plan Diff is computed from besides the State File (#295): this year's Catalog, every
 * Semester of it, and the Equivalences and Offering Patterns of the student's Requirements Files.
 *
 * Its own module so that the Timetable read (`./picks.ts`), whose every answer carries the Plan
 * Diffs, and the apply use cases (`./planDiffs.ts`), which edit through that read, both reach it
 * without reaching each other.
 *
 * **A Catalog or a Requirements File that cannot be had is not a refusal here**, and carries no
 * Warning: the Catalog's routes and the Programs route are where what is wrong with them is said.
 * A missing Catalog means no `move` and no `not-offered` can be told (`planDiffs`), and a missing
 * Requirements File means its Equivalences are not applied. After a save nothing read here may
 * throw, for the reason `view` in `./picks.ts` gives (#324): the edit has landed.
 */

/** The files a Plan Diff reads, loaded before the State they are applied to is known. */
export type PlanDiffSources = {
  offerings: Offering[] | undefined;
  requirements: RequirementsListing | undefined;
};

/**
 * Every Offering of the year, whatever its Semester, or `undefined` when there is none to read.
 *
 * Exported for the Timetable view (`./picks.ts`), which reads the Catalog once and takes both the
 * Tray's chips and the Plan Diffs from that one read (#356). Before a save, a read that throws for
 * any reason but the Workspace's refusal propagates, which is what `listOfferings` does too.
 */
export async function yearOfferings(
  workspace: Workspace,
  academicYear: number,
  afterSave: boolean,
): Promise<Offering[] | undefined> {
  try {
    const stored = await workspace.read({ kind: "catalog", academicYear });
    return stored === undefined ? undefined : parseCatalogFile(stored).catalog?.offerings;
  } catch (error) {
    if (afterSave || error instanceof WorkspaceRefusedError) return undefined;
    throw error;
  }
}

async function requirementsListing(
  workspace: Workspace,
  afterSave: boolean,
): Promise<RequirementsListing | undefined> {
  try {
    return await loadRequirementsFiles(workspace);
  } catch (error) {
    if (afterSave) return undefined;
    throw error;
  }
}

/**
 * The sources for one Academic Year. `wantRequirements` is false when the State is known to name no
 * Program, so a student without one costs no listing of `requirements/`.
 */
export async function loadPlanDiffSources(
  workspace: Workspace,
  academicYear: number,
  options: { afterSave?: boolean; wantRequirements?: boolean } = {},
): Promise<PlanDiffSources> {
  const afterSave = options.afterSave ?? false;
  return {
    offerings: await yearOfferings(workspace, academicYear, afterSave),
    requirements: options.wantRequirements === false ? undefined : await requirementsListing(workspace, afterSave),
  };
}

/**
 * The sources for an edit that computes Plan Diffs inside the guarded writer: an apply, or a mark
 * with "apply all". They are loaded before the State the edit is applied to is in hand, so the
 * State File is read first to learn whether it names a Program, and a student who has none costs no
 * listing of `requirements/` (#356).
 *
 * That read is only a hint. It is trusted only when it is the revision the edit is based on — the
 * guard in `editStateFile` then applies the edit to that very State, or refuses it — and anything
 * else (no file to read, a refusal, another revision) loads the Requirements Files as before.
 */
export async function loadPlanDiffSourcesForEdit(
  workspace: Workspace,
  stateFile: string,
  academicYear: number,
  basedOn: StateFileVersion | undefined,
): Promise<PlanDiffSources> {
  const loaded = await readStateFile(workspace, stateFile);
  const noProgram = "state" in loaded && loaded.version === basedOn && loaded.state.programs.length === 0;
  return loadPlanDiffSources(workspace, academicYear, { wantRequirements: !noProgram });
}

/**
 * The context for this State: the Catalog as loaded, and the Equivalences and Year-long Courses of
 * the Requirements Files of the Programs **this State** names, in the order it names them.
 */
export function planDiffContext(state: State, sources: PlanDiffSources): PlanDiffContext {
  const listing = sources.requirements;
  const files =
    listing === undefined || listing.kind === "refused"
      ? []
      : state.programs.flatMap((program) => {
          const file = listing.files.find((entry) => entry.listed.name === program.requirementsFile)?.file;
          return file === undefined ? [] : [file];
        });
  return {
    offerings: sources.offerings,
    equivalences: files.flatMap((file) => file.equivalences),
    yearLong: files.flatMap((file) =>
      file.courses.filter((course) => course.offeringPattern === "year-long").map((course) => course.number),
    ),
  };
}

/**
 * The Plan Diffs of the Variant `shown` in this State, for a read of the Timetable, given the year's
 * Offerings the view has already read (`yearOfferings`), so the Catalog is read once per view
 * (#356). A State with no planned Attempt in the year has none and reads nothing more (ADR-0008: a
 * Timetable works with no Plan), and one naming no Program lists no Requirements Files.
 */
export async function planDiffsOf(
  workspace: Workspace,
  state: State,
  shown: VariantRef,
  offerings: Offering[] | undefined,
  afterSave: boolean,
): Promise<PlanDiff[]> {
  const planned = state.attempts.some(
    (attempt) => attempt.status === "planned" && attempt.academicYear === shown.academicYear,
  );
  if (!planned) return [];
  const requirements = state.programs.length > 0 ? await requirementsListing(workspace, afterSave) : undefined;
  return planDiffs(state, shown, planDiffContext(state, { offerings, requirements }));
}
