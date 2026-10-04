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
 *
 * **This module is the one place a Workspace adapter's own words reach the API.** The arm below
 * says what that costs and what the words have to be.
 */
export type QueryWarning =
  | CatalogFileWarning
  | { kind: "no-catalog-for-year"; academicYear: number }
  /**
   * The Workspace would not touch the file. Never carries what was out there.
   *
   * **`reason` is the refusal's own sentence, and it is the only channel an adapter's prose has
   * out of `app`** — measured, not assumed: `grep -rn '\.message' app/src server/src core/src
   * web/src` finds the line below and nothing else on any request path. Every other caller of
   * the port collapses a refusal to a reason code of its own, so the three routes this Warning
   * reaches — the two Catalog queries and the exam period's `catalogWarnings` — are where
   * whatever an adapter wrote lands on the wire.
   *
   * So what an adapter says here is held to **"The API exposes domain operations, never file
   * paths"** (CLAUDE.md; docs/design.md, "API and data rules", rule 1). It said
   * `refusing ./catalogs/2027.json: it is there and cannot be read (EACCES)` until #216 — a
   * Workspace-relative path, which is smaller than an absolute one and is a file path all the
   * same, reaching a page that is not allowed to know the Workspace has files in it. It now says
   * which Catalog, which Academic Year, which State File, which snapshot; the path the
   * filesystem met stays on the error's `cause`, where a log can reach it and a response cannot.
   * `server/src/workspace.fs.ts` is where that is enforced and
   * `server/src/workspace.fs.test.ts` sweeps every refusal it can make for one.
   */
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
