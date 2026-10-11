import { parseCatalogFile, type Offering } from "@biu-cs-planner/core";
import { loadRequirementsFiles, type RequirementsListing } from "./requirements.ts";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

/**
 * The Workspace reads a view makes besides the State File (#374): `requirements/`, and one
 * Academic Year's Catalog. A view takes these rather than the Workspace, and which adapter it is
 * handed decides what a failed read becomes — so no view has a flag its caller must remember.
 *
 * A `requirements/` that cannot be listed has one spelling, `{ kind: "refused" }`, which is what
 * `requirements-unlisted` is said from. A Catalog that cannot be had is `undefined` Offerings.
 */
export type ViewReads = {
  requirementsFiles(): Promise<RequirementsListing>;
  /** Every Offering of the year, whatever its Semester, or `undefined` when there is none to read. */
  yearOfferings(academicYear: number): Promise<Offering[] | undefined>;
};

async function catalogOfferings(workspace: Workspace, academicYear: number): Promise<Offering[] | undefined> {
  const stored = await workspace.read({ kind: "catalog", academicYear });
  return stored === undefined ? undefined : parseCatalogFile(stored).catalog?.offerings;
}

/**
 * For a read, and for what an edit loads before it saves: the Workspace's refusal is answered,
 * and anything else propagates — a 500 that changed nothing, as `listOfferings` gives too.
 */
export function strictReads(workspace: Workspace): ViewReads {
  return {
    requirementsFiles: () => loadRequirementsFiles(workspace),
    async yearOfferings(academicYear) {
      try {
        return await catalogOfferings(workspace, academicYear);
      } catch (error) {
        if (error instanceof WorkspaceRefusedError) return undefined;
        throw error;
      }
    },
  };
}

/**
 * For the answer to an edit that has landed: never throws (#324, #344). A throw here would answer
 * 500 for a save that was written, and the page would tell the student it failed. So a read that
 * fails in any way is read as not there — the answer carries the new revision and the parts it
 * could read, and says which part it could not.
 */
export function degradingReads(workspace: Workspace): ViewReads {
  const strict = strictReads(workspace);
  return {
    requirementsFiles: () =>
      strict.requirementsFiles().catch((): RequirementsListing => ({ kind: "refused", reason: "workspace-refused" })),
    yearOfferings: (academicYear) => strict.yearOfferings(academicYear).catch(() => undefined),
  };
}
