import {
  parseCatalogFile,
  type CatalogFileWarning,
  type Offering,
  type Semester,
} from "@biu-cs-planner/core";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

/**
 * Reading the Catalog. Every read goes through the schema, because a file on disk is
 * untrusted whoever wrote it — a hand-edited or half-synced Catalog is a Warning the
 * student can act on, never a crashed server (docs/design.md, "API and data rules").
 */
export type QueryWarning =
  | CatalogFileWarning
  | { kind: "no-catalog-for-year"; academicYear: number }
  /** The Workspace would not touch the file. Never carries what was out there. */
  | { kind: "workspace-refused"; reason: string };

export type ListResult = { offerings?: Offering[]; warnings: QueryWarning[] };
export type OfferingResult = { offering?: Offering; warnings: QueryWarning[] };

async function loadCatalog(
  workspace: Workspace,
  academicYear: number,
): Promise<{ offerings?: Offering[]; warnings: QueryWarning[] }> {
  let stored: unknown;
  try {
    stored = await workspace.read({ kind: "catalog", academicYear });
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      return { warnings: [{ kind: "workspace-refused", reason: error.message }] };
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
