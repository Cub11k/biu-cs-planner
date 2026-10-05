import {
  parseCatalogFile,
  type CatalogFileWarning,
  type Offering,
  type Semester,
} from "@biu-cs-planner/core";
import { wordRefusal } from "./refusal.ts";
import { WorkspaceRefusedError, type Workspace, type WorkspaceRefusal } from "./workspace.ts";

/**
 * Reading the Catalog. Every read goes through the schema, because a file on disk is
 * untrusted whoever wrote it — a hand-edited or half-synced Catalog is a Warning the
 * student can act on, never a crashed server (docs/design.md, "API and data rules").
 */
export type QueryWarning =
  | CatalogFileWarning
  | { kind: "no-catalog-for-year"; academicYear: number }
  /**
   * The Workspace would not touch the file. Never carries what was out there.
   *
   * **`reason` is `app`'s sentence and not the adapter's** (#249): `wordRefusal` in `./refusal.ts`
   * builds it from the refusal's reason code and subject, which the port requires of every
   * `WorkspaceRefusedError`, and says a file only if it is the Catalog asked for. So
   * it says which Catalog and which Academic Year, as it did before, and nothing a Workspace
   * adapter chose can reach the three routes this Warning travels on — the two Catalog queries
   * and the exam period's `catalogWarnings`. The error's own message is never read here; it is
   * the adapter's account, kept for a log (#165).
   */
  | { kind: "workspace-refused"; reason: string };

export type ListResult = { offerings?: Offering[]; warnings: QueryWarning[] };
export type OfferingResult = { offering?: Offering; warnings: QueryWarning[] };

async function loadCatalog(
  workspace: Workspace,
  academicYear: number,
): Promise<{ offerings?: Offering[]; warnings: QueryWarning[] }> {
  const ref = { kind: "catalog", academicYear } as const;
  let stored: unknown;
  try {
    stored = await workspace.read(ref);
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      const reason = wordRefusal(refusalOf(error), ref);
      return { warnings: [{ kind: "workspace-refused", reason }] };
    }
    throw error;
  }
  if (stored === undefined) {
    return { warnings: [{ kind: "no-catalog-for-year", academicYear }] };
  }

  const parsed = parseCatalogFile(stored);
  if (!parsed.catalog) return { warnings: parsed.warnings };

  return { offerings: parsed.catalog.offerings, warnings: [] };
}

/**
 * The refusal off the error, or none when reading it throws: a subclass can make `refusal` a
 * getter, and a refusal is a Warning and never a 500, so `wordRefusal` words none as its fallback.
 */
function refusalOf(error: WorkspaceRefusedError): WorkspaceRefusal | undefined {
  try {
    return error.refusal;
  } catch {
    return undefined;
  }
}

/** A Year-long Offering is given in both its Semesters, so it answers to either. */
export async function listOfferings(
  workspace: Workspace,
  query: { academicYear: number; semester: Semester },
): Promise<ListResult> {
  const { offerings, warnings } = await loadCatalog(workspace, query.academicYear);
  if (!offerings) return { warnings };

  return {
    offerings: offerings.filter((o) => o.semesters.includes(query.semester)),
    warnings,
  };
}

export async function getOffering(
  workspace: Workspace,
  query: { academicYear: number; courseNumber: string },
): Promise<OfferingResult> {
  const { offerings, warnings } = await loadCatalog(workspace, query.academicYear);
  if (!offerings) return { warnings };

  const offering = offerings.find((o) => o.courseNumber === query.courseNumber);
  return offering ? { offering, warnings } : { warnings };
}
