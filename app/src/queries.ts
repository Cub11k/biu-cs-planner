import {
  parseCatalogFile,
  type CatalogFileWarning,
  type Offering,
  type Semester,
} from "@biu-cs-planner/core";
import { answerRefusal } from "./refusal.ts";
import {
  WorkspaceRefusedError,
  type Workspace,
  type WorkspaceRefusal,
  type WorkspaceRefusalReason,
} from "./workspace.ts";

/**
 * Reading the Catalog. Every read goes through the schema, because a file on disk is
 * untrusted whoever wrote it — a hand-edited or half-synced Catalog is a Warning the
 * student can act on, never a crashed server (docs/design.md, "API and data rules").
 *
 * **Only Warnings about a Catalog that was looked for are here.** A Workspace that would not
 * touch the file is not one of them: it is `CatalogRefused`, its own arm (#149).
 */
export type QueryWarning = CatalogFileWarning | { kind: "no-catalog-for-year"; academicYear: number };

/**
 * The Workspace would not touch the Catalog file, so there is no Catalog to say anything about
 * (#149, #187). **A refusal, not a Warning**: `GLOSSARY.md`'s Warning is a problem found in
 * something that was read, and here nothing was. So it is an answer of its own, beside the read
 * and not inside its Warnings, which is the line `docs/design.md` draws ("External edits").
 *
 * `reason` is #249's reason code, given only when it is one of the port's own, and `sentence` is
 * `app`'s wording of it (`answerRefusal` in `./refusal.ts`), which says which Catalog and which
 * Academic Year and nothing a Workspace adapter chose. The error's own message is never read
 * here; it is the adapter's account, for the `--debug` log (#165).
 */
export type CatalogRefused = { kind: "refused"; reason?: WorkspaceRefusalReason; sentence: string };

export type ListResult = CatalogRefused | { kind: "read"; offerings?: Offering[]; warnings: QueryWarning[] };
export type OfferingResult = CatalogRefused | { kind: "read"; offering?: Offering; warnings: QueryWarning[] };

async function loadCatalog(
  workspace: Workspace,
  academicYear: number,
): Promise<CatalogRefused | { kind: "read"; offerings?: Offering[]; warnings: QueryWarning[] }> {
  const ref = { kind: "catalog", academicYear } as const;
  let stored: unknown;
  try {
    stored = await workspace.read(ref);
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      return { kind: "refused", ...answerRefusal(refusalOf(error), ref) };
    }
    throw error;
  }
  if (stored === undefined) {
    return { kind: "read", warnings: [{ kind: "no-catalog-for-year", academicYear }] };
  }

  const parsed = parseCatalogFile(stored);
  if (!parsed.catalog) return { kind: "read", warnings: parsed.warnings };

  return { kind: "read", offerings: parsed.catalog.offerings, warnings: [] };
}

/**
 * The refusal off the error, or none when reading it throws: a subclass can make `refusal` a
 * getter, and a refusal is an answer and never a 500, so `answerRefusal` words none as its fallback.
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
  const loaded = await loadCatalog(workspace, query.academicYear);
  if (loaded.kind === "refused" || !loaded.offerings) return loaded;

  return {
    kind: "read",
    offerings: loaded.offerings.filter((o) => o.semesters.includes(query.semester)),
    warnings: loaded.warnings,
  };
}

export async function getOffering(
  workspace: Workspace,
  query: { academicYear: number; courseNumber: string },
): Promise<OfferingResult> {
  const loaded = await loadCatalog(workspace, query.academicYear);
  if (loaded.kind === "refused") return loaded;
  const { offerings, warnings } = loaded;
  if (!offerings) return { kind: "read", warnings };

  const offering = offerings.find((o) => o.courseNumber === query.courseNumber);
  return offering ? { kind: "read", offering, warnings } : { kind: "read", warnings };
}
