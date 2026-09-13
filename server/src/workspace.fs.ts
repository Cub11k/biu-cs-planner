import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  WORKSPACE_LAYOUT,
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

export function fileSystemWorkspace(rootPath: string): Workspace {
  const root = resolve(rootPath);

  const folderOf = (ref: WorkspaceRef): string => join(root, DIRECTORY.catalogs);
  const fileOf = (ref: WorkspaceRef): string =>
    join(folderOf(ref), `${ref.academicYear}.json`);

  /**
   * A folder inside the Workspace can still be a symlink pointing out of it, so the
   * real path is checked before anything is read or written through it. `.json` is not
   * a check here so much as a consequence: every name this module builds ends in it.
   */
  const containedFolder = async (ref: WorkspaceRef): Promise<string> => {
    const folder = folderOf(ref);
    const real = await realpath(folder);
    const realRoot = await realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`refusing to use ${DIRECTORY.catalogs}: it resolves outside the Workspace`);
    }
    return folder;
  };

  return {
    async status(): Promise<WorkspaceStatus> {
      const missing: WorkspaceFolder[] = [];
      for (const folder of WORKSPACE_LAYOUT) {
        try {
          await readdir(join(root, DIRECTORY[folder]));
        } catch {
          missing.push(folder);
        }
      }
      return { ready: missing.length === 0, missing };
    },

    async create(): Promise<void> {
      for (const folder of WORKSPACE_LAYOUT) {
        await mkdir(join(root, DIRECTORY[folder]), { recursive: true });
      }
    },

    async list(): Promise<WorkspaceRef[]> {
      let entries: string[];
      try {
        entries = await readdir(join(root, DIRECTORY.catalogs));
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
      await containedFolder(ref);
      let raw: string;
      try {
        raw = await readFile(fileOf(ref), "utf8");
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
      const folder = await containedFolder(ref);
      const target = fileOf(ref);
      // serialise first: a value that cannot be written must not reach the filesystem
      const json = JSON.stringify(data, null, 2) + "\n";

      const temporary = join(folder, `.${ref.academicYear}.json.${process.pid}.tmp`);
      try {
        await writeFile(temporary, json, "utf8");
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  };
}

