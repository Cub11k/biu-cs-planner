import {
  parseRequirementsFile,
  type Cohort,
  type LocalizedText,
  type RequirementsFile,
  type RequirementsFileWarning,
} from "@biu-cs-planner/core";
import { wordRefusal } from "./refusal.ts";
import { WorkspaceRefusedError, type RequirementsFileRef, type Workspace } from "./workspace.ts";

/**
 * Requirements Files as a Workspace content type (#287): listing them with what a student needs to
 * tell them apart, and importing one. A file is named by its name within `requirements/` and
 * nothing in or out of here is a path (ADR-0002).
 *
 * **A file is read, never executed** (ADR-0007): every read goes through `parseRequirementsFile`,
 * which interprets the JSON as data and never throws. One with problems is still listed, with its
 * Warnings, because one bad node should not hide a whole Program; one that is not a Requirements
 * File at all is reported by name rather than left out, so the student knows why it is not
 * offered as one.
 */

/** One file in `requirements/`, as the listing and the Programs choice see it. */
export type ListedRequirements =
  /** A Requirements File this build can read, with the Warnings its reading raised. */
  | {
      name: string;
      status: "read";
      program: { id: string; name: LocalizedText };
      cohorts: Cohort[];
      tracks: { id: string; name: LocalizedText }[];
      warnings: RequirementsFileWarning[];
    }
  /** A file that is there and is not a Requirements File this build can read. */
  | { name: string; status: "not-requirements"; warnings: RequirementsFileWarning[] }
  /** A file the Workspace would not read; `reason` is `app`'s sentence, never the adapter's. */
  | { name: string; status: "refused"; reason: string };

/** One file as read, with the parsed rules beside its listing entry when it has them. */
export type LoadedRequirements = { listed: ListedRequirements; file?: RequirementsFile };

export type RequirementsListing =
  | { kind: "served"; files: LoadedRequirements[] }
  /** `requirements/` is there and cannot be listed: never answered as "no files" (#129). */
  | { kind: "refused"; reason: "workspace-refused" };

/** Reads one file of `requirements/`, whatever it turns out to hold. */
async function loadOne(workspace: Workspace, ref: RequirementsFileRef): Promise<LoadedRequirements> {
  let stored: unknown;
  try {
    stored = await workspace.read(ref);
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      let refusal;
      try {
        refusal = error.refusal;
      } catch {
        refusal = undefined;
      }
      return { listed: { name: ref.name, status: "refused", reason: wordRefusal(refusal, ref) } };
    }
    throw error;
  }

  // Gone between the listing and the read — a student deleting it while the screen loads — which
  // is the same news as a file that is not a Requirements File: nothing here can be used.
  const parsed = parseRequirementsFile(stored);
  if (parsed.file === undefined) {
    return {
      listed: {
        name: ref.name,
        status: "not-requirements",
        warnings: stored === undefined ? [{ kind: "file-unreadable" }] : parsed.warnings,
      },
    };
  }

  return { file: parsed.file, listed: listedAs(ref.name, parsed.file, parsed.warnings) };
}

/** A readable file's listing entry: what tells it apart from the others, and its Warnings. */
function listedAs(
  name: string,
  file: RequirementsFile,
  warnings: RequirementsFileWarning[],
): Extract<ListedRequirements, { status: "read" }> {
  return {
    name,
    status: "read",
    program: { id: file.program.id, name: file.program.name },
    cohorts: file.cohorts,
    tracks: file.tracks.map((track) => ({ id: track.id, name: track.name })),
    warnings,
  };
}

/**
 * Every file in `requirements/`, read, in the order the Workspace lists them (by name). Recomputed
 * on every call, so a file dropped into the folder or removed from it is seen on the next read —
 * which the Workspace watcher is what prompts the page to make.
 */
export async function loadRequirementsFiles(workspace: Workspace): Promise<RequirementsListing> {
  let refs;
  try {
    refs = await workspace.list("requirements");
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) return { kind: "refused", reason: "workspace-refused" };
    throw error;
  }
  const files: LoadedRequirements[] = [];
  for (const ref of refs) {
    if (ref.kind === "requirements") files.push(await loadOne(workspace, ref));
  }
  return { kind: "served", files };
}

/** The listing the API serves: each file's entry, without the parsed rules behind it. */
export async function listRequirementsFiles(
  workspace: Workspace,
): Promise<{ kind: "served"; files: ListedRequirements[] } | { kind: "refused"; reason: "workspace-refused" }> {
  const loaded = await loadRequirementsFiles(workspace);
  if (loaded.kind === "refused") return loaded;
  return { kind: "served", files: loaded.files.map((entry) => entry.listed) };
}

export type RequirementsImportResult =
  | {
      stored: true;
      /** The entry the file now has in the listing, Warnings and all. */
      listed: Extract<ListedRequirements, { status: "read" }>;
      /** Whether a file of that name was there and has been replaced. */
      replaced: boolean;
    }
  | {
      stored: false;
      reason: "workspace-not-ready" | "not-requirements" | "workspace-refused";
      warnings?: RequirementsFileWarning[];
    };

/**
 * Imports a Requirements File under a name, which mirrors importing a Raw Crawl (`./catalog.ts`):
 * a folder that is not a Workspace yet is not silently made into one, and the Workspace's own
 * refusal is answered rather than thrown.
 *
 * **What is refused is a file that is not a Requirements File at all**, with the Warnings saying
 * why: storing it would put a file in `requirements/` that the listing then reports as unusable,
 * and the student is better told now. A file with problems is stored, and its Warnings come back
 * with it, exactly as it would be listed had it been dropped into the folder by hand.
 *
 * **It stores the file as it was given**, not the reading of it: the reader leaves out what it
 * cannot read and strips what it does not know, and a maintainer's file — perhaps written for a
 * newer build — should arrive in the folder as they wrote it. It is data either way, and every read
 * goes through the same reader.
 *
 * **A name already taken is replaced, and the answer says so.** Importing a file under the name it
 * already has is how a reissued file arrives; a Requirements File is converted by hand from the
 * department's rules and is not something the app edits, so there is nothing of the student's in
 * it to lose.
 */
export async function importRequirementsFile(
  workspace: Workspace,
  name: string,
  data: unknown,
): Promise<RequirementsImportResult> {
  const status = await workspace.status();
  if (!status.ready) return { stored: false, reason: "workspace-not-ready" };

  const parsed = parseRequirementsFile(data);
  if (parsed.file === undefined) {
    return { stored: false, reason: "not-requirements", warnings: parsed.warnings };
  }

  // A name given with the extension is the file's name as it sits in the folder; the ref names it
  // without one, so `cs-2027.json` is stored as `requirements/cs-2027.json` and not `.json.json`.
  const ref = { kind: "requirements", name: name.endsWith(".json") ? name.slice(0, -".json".length) : name } as const;
  let existing: unknown;
  try {
    existing = await workspace.read(ref);
    await workspace.write(ref, data);
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) return { stored: false, reason: "workspace-refused" };
    throw error;
  }

  return {
    stored: true,
    replaced: existing !== undefined,
    listed: listedAs(ref.name, parsed.file, parsed.warnings),
  };
}
