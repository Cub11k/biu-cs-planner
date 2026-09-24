import {
  importRawCrawl,
  parseCatalogFile,
  type CatalogFileWarning,
  type ImportSummary,
  type RawCrawl,
  type Warning,
} from "@biu-cs-planner/core";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

/**
 * Importing a Raw Crawl: `core` turns it into a Catalog, and the Workspace stores it.
 *
 * Two things are refused rather than done quietly. A folder that is not a Workspace yet
 * is not silently made into one — the student is offered the layout first. And a stored
 * Catalog that cannot be read is not overwritten: it may be hand-edited, and replacing
 * it would lose whatever it holds (docs/design.md, "Storage"; ADR-0003).
 */
export type ImportResult =
  | { stored: true; summary: ImportSummary; warnings: Warning[] }
  | {
      stored: false;
      reason: "workspace-not-ready" | "stored-catalog-unreadable" | "workspace-refused";
      fileWarnings?: CatalogFileWarning[];
    };

export async function importCrawl(
  workspace: Workspace,
  crawl: RawCrawl,
  options: { academicYear: number },
): Promise<ImportResult> {
  const status = await workspace.status();
  if (!status.ready) return { stored: false, reason: "workspace-not-ready" };

  const ref = { kind: "catalog", academicYear: options.academicYear } as const;

  let existing: unknown;
  try {
    existing = await workspace.read(ref);
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) return { stored: false, reason: "workspace-refused" };
    throw error;
  }

  // A file read is untrusted input, whoever wrote it. Absent is fine; unreadable is not.
  let into;
  if (existing !== undefined) {
    const parsed = parseCatalogFile(existing);
    if (!parsed.catalog) {
      return {
        stored: false,
        reason: "stored-catalog-unreadable",
        fileWarnings: parsed.warnings,
      };
    }
    into = parsed.catalog;
  }

  const { catalog, warnings, summary } = importRawCrawl(crawl, {
    academicYear: options.academicYear,
    ...(into ? { into } : {}),
  });

  try {
    await workspace.write(ref, catalog);
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) return { stored: false, reason: "workspace-refused" };
    throw error;
  }
  return { stored: true, summary, warnings };
}
