import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  WORKSPACE_LAYOUT,
  WorkspaceRefusedError,
  type Workspace,
  type WorkspaceFolder,
  type WorkspaceRef,
  type WorkspaceStatus,
} from "@biu-cs-planner/app";

/**
 * The Workspace as a folder of JSON files (ADR-0003). This is the only place that knows
 * a Workspace is a directory: `app` names a file by what it is, and the mapping to a
 * path happens here, so there is no caller-supplied path to sanitise.
 *
 *   <root>/catalogs/<year>.json
 *   <root>/requirements/
 *   <root>/.backups/
 */
const DIRECTORY: Record<WorkspaceFolder, string> = {
  catalogs: "catalogs",
  requirements: "requirements",
  backups: ".backups",
};

const CATALOG_FILE = /^(\d{4})\.json$/;

class OutsideWorkspaceError extends WorkspaceRefusedError {
  constructor(what: string) {
    super(`refusing ${what}: it resolves outside the Workspace`);
  }
}

/** Absent, to this module, is not an error: the caller decides what absence means. */
async function realPathOrAbsent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export function fileSystemWorkspace(rootPath: string): Workspace {
  const root = resolve(rootPath);

  const folderPath = (ref: WorkspaceRef): string => join(root, DIRECTORY[folderFor(ref)]);
  const filePath = (ref: WorkspaceRef): string =>
    join(folderPath(ref), `${ref.academicYear}.json`);

  const within = (real: string, realRoot: string): boolean =>
    real === realRoot || real.startsWith(realRoot + sep);

  /**
   * Containment is checked on the **resolved** path, and on the file itself rather than
   * only the folder that holds it: a folder can sit honestly inside the Workspace while
   * a file within it is a symlink pointing out. Both are refused.
   *
   * A path that does not exist is not a breach — its parent is checked instead, so a
   * write into a real Workspace folder is allowed and a write through a symlinked folder
   * is not. `undefined` means the layout is simply not there yet.
   */
  const contained = async (
    target: string,
  ): Promise<{ path: string } | { missing: true }> => {
    const realRoot = await realPathOrAbsent(root);
    if (realRoot === undefined) return { missing: true };

    const real = await realPathOrAbsent(target);
    if (real !== undefined) {
      if (!within(real, realRoot)) throw new OutsideWorkspaceError(target.replace(root, "."));
      return { path: target };
    }

    const parent = await realPathOrAbsent(dirname(target));
    if (parent === undefined) return { missing: true };
    if (!within(parent, realRoot)) throw new OutsideWorkspaceError(dirname(target).replace(root, "."));
    return { path: target };
  };

  /** A folder counts towards the layout only if it exists *and* stays inside. */
  const usableFolder = async (folder: WorkspaceFolder): Promise<string | undefined> => {
    const path = join(root, DIRECTORY[folder]);
    const realRoot = await realPathOrAbsent(root);
    const real = await realPathOrAbsent(path);
    if (realRoot === undefined || real === undefined) return undefined;
    return within(real, realRoot) ? path : undefined;
  };

  return {
    async status(): Promise<WorkspaceStatus> {
      const missing: WorkspaceFolder[] = [];
      for (const folder of WORKSPACE_LAYOUT) {
        if ((await usableFolder(folder)) === undefined) missing.push(folder);
      }
      return { ready: missing.length === 0, missing };
    },

    async create(): Promise<void> {
      for (const folder of WORKSPACE_LAYOUT) {
        await mkdir(join(root, DIRECTORY[folder]), { recursive: true });
      }
    },

    async list(kind): Promise<WorkspaceRef[]> {
      const folder = await usableFolder(folderFor({ kind }));
      if (folder === undefined) return [];

      let entries: string[];
      try {
        entries = await readdir(folder);
      } catch {
        return [];
      }
      return entries
        .map((name) => CATALOG_FILE.exec(name))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ kind: "catalog" as const, academicYear: Number(m[1]) }))
        .sort((a, b) => a.academicYear - b.academicYear);
    },

    async read(ref): Promise<unknown> {
      const target = filePath(ref);
      requireJsonName(target);

      const check = await contained(target);
      if ("missing" in check) return undefined;

      let raw: string;
      try {
        raw = await readFile(check.path, "utf8");
      } catch {
        return undefined;
      }
      try {
        return JSON.parse(raw);
      } catch {
        // Content that is not JSON is handed back as it was found. Reporting it is the
        // caller's job, and inventing a stand-in value here would hide what is wrong.
        return raw;
      }
    },

    /**
     * Written to a temporary name in the same directory and renamed over the target,
     * which is atomic on a POSIX filesystem: an interrupted write leaves the previous
     * file whole rather than truncating it (docs/design.md, "Storage").
     */
    async write(ref, data): Promise<void> {
      const target = filePath(ref);
      requireJsonName(target);

      const check = await contained(target);
      if ("missing" in check) {
        throw new Error("refusing to write: the Workspace layout does not exist yet");
      }
      // serialise first: a value that cannot be written must not reach the filesystem
      const json = JSON.stringify(data, null, 2) + "\n";

      const temporary = join(
        folderPath(ref),
        `.${ref.academicYear}.json.${process.pid}.tmp`,
      );
      try {
        await writeFile(temporary, json, "utf8");
        await rename(temporary, check.path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  };
}

/** Which part of the layout a reference lives in. */
function folderFor(ref: { kind: WorkspaceRef["kind"] }): WorkspaceFolder {
  switch (ref.kind) {
    case "catalog":
      return "catalogs";
  }
}

/**
 * Only `.json` is read or written. Every name this module builds already ends in it, so
 * this is a guard against a future caller rather than against today's one — which is
 * the point: the rule should not depend on remembering it.
 */
function requireJsonName(path: string): void {
  if (!path.endsWith(".json")) {
    throw new WorkspaceRefusedError(`refusing ${path}: only .json files are read or written`);
  }
}
