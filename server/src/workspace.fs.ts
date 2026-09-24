import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  isStateFileName,
  requireCatalogRef,
  requireStateFileName,
  StateFileChangedError,
  WORKSPACE_LAYOUT,
  WorkspaceRefusedError,
  type StateFileContents,
  type StateFileRef,
  type Workspace,
  type WorkspaceFolder,
  type WorkspaceRef,
  type WorkspaceStatus,
  type WorkspaceWatcher,
} from "@biu-cs-planner/app";
import type { StateFileSave, StateFileVersion } from "@biu-cs-planner/core";

/**
 * The Workspace as a folder of JSON files (ADR-0003). This is the only place that knows
 * a Workspace is a directory: `app` names a file by what it is, and the mapping to a
 * path happens here, so there is no caller-supplied path to sanitise.
 *
 *   <root>/catalogs/<year>.json
 *   <root>/requirements/
 *   <root>/<name>.state.json
 *   <root>/.backups/
 */
const DIRECTORY: Record<WorkspaceFolder, string> = {
  catalogs: "catalogs",
  requirements: "requirements",
  backups: ".backups",
};

/** The refusal a write makes before the student has agreed to the layout. */
const NOT_A_WORKSPACE = "refusing to write: the Workspace layout does not exist yet";

/** Literal patterns, never built from data (ADR-0007). */
const CATALOG_FILE = /^(\d{4})\.json$/;
const STATE_FILE = /^(.+)\.state\.json$/;

/**
 * The folders a watch covers: the Workspace root, plus these. The layout minus `.backups`,
 * because a rotating snapshot is written only by the app and nothing in it is ever shown —
 * so a backup is not news, and watching it would turn every future autosave's snapshot into
 * a page reload (docs/design.md, "Storage").
 */
const WATCHED_FOLDERS: WorkspaceFolder[] = ["catalogs", "requirements"];

class OutsideWorkspaceError extends WorkspaceRefusedError {
  constructor(what: string) {
    super(`refusing ${what}: it resolves outside the Workspace`);
  }
}

/**
 * The errno codes that mean there is **no file**, as against a file that is there and cannot
 * be read. `ENOENT` is nothing at that name. `ENOTDIR` is nothing at that name either — a
 * component of the path is a plain file, so no file can exist below it. Every other code, and
 * an error carrying no code at all, is the third answer below: unreadable, not absent, which
 * is the safe way round for anything this cannot recognise (#109).
 */
const ABSENT = ["ENOENT", "ENOTDIR"];

/** The errno a filesystem error carries, when it carries one. */
const errnoOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/**
 * A file that is there and whose contents cannot be read: `EACCES` behind a mode bit,
 * `EISDIR` where a directory sits in a file's place, `EIO` on failing hardware, a lock a sync
 * client holds mid-download. **The third answer #109 was filed for**, and neither of the other
 * two:
 *
 *   - **Not absence.** Reported as absent, an unreadable State File has no revision, so a save
 *     based on there being no file *matches*, the external-edit guard passes, and the atomic
 *     rename destroys a file the app could not read. That is the one direction the guard may
 *     not fail in, and a file whose contents cannot be seen is exactly the file it exists for.
 *   - **Not the `readFile` error either.** Letting an `EACCES` out of the port turns a mode bit
 *     into a 500, which is a different bug of the same size. A `WorkspaceRefusedError` is what
 *     every caller of this port already turns into a Warning or a 409: a refusal is a Warning
 *     the student can act on and never a crashed server (docs/design.md, "API and data rules").
 *
 * `WorkspaceRefusedError` and deliberately not `StateFileChangedError`: nothing changed, and
 * that error's `basedOn`/`found` pair has nothing true to carry here — `found` would have to
 * report a revision this adapter has just said it cannot determine. "A target a Workspace will
 * not touch" is what a file it cannot read is, and it is the error `app/src/edit.ts` already
 * maps to `workspace-refused` and the page already words as picks that could not be read.
 */
class UnreadableError extends WorkspaceRefusedError {
  constructor(what: string, code: string | undefined) {
    super(
      `refusing ${what}: it is there and cannot be read` +
        (code === undefined ? "" : ` (${code})`),
    );
  }
}

/**
 * Which revision of a State File this is: a SHA-256 of its bytes, as hex.
 *
 * **A content hash, ruled by the maintainer on #90 and not an mtime.** The question the
 * external-edit guard asks is "is the file still what I read?", and only the content answers
 * it: `git checkout` stamps an mtime to now with the content unchanged, sync clients differ
 * on whether they preserve one, and its granularity varies by filesystem — so an mtime guard
 * refuses saves nobody endangered, and a guard that misfires teaches a student to ignore it.
 *
 * **The bytes as read, not the document they parse to.** `parseStateFile` is deliberately
 * forgiving: it drops an entry it cannot read and keeps the rest. A hash taken after that
 * would be a hash of the repaired document, so an external edit that damaged only an entry
 * the reader drops would produce an identical revision and be invisible — the guard would be
 * blind exactly where the file is damaged. Hashing the bytes also needs no canonical form.
 *
 * **And a hash rather than remembering the bytes**, which would need no hash at all and would
 * be enough for a guard that lived only in this adapter. It is not enough for two views of one
 * plan open side by side, which is the workflow this app replaces: the version has to be small
 * enough for a page to hold and hand back on its next save, and the file's content is not.
 *
 * SHA-256 because it is the obvious one available on all three runtimes through `node:crypto`;
 * this is conflict detection and not a security boundary, so the choice is about availability
 * rather than strength.
 */
const revisionOf = (bytes: Uint8Array): StateFileVersion =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Absent, to this module, is not an error: the caller decides what absence means.
 *
 * Two answers here and three in `bytesOrAbsent`, and the difference is deliberate. A folder
 * that exists and cannot be `realpath`ed reports the layout as missing, and everything that
 * asks — `status`, `missingFolders`, `usablePath`, `contained` — then writes nothing and lists
 * nothing. That fails **closed**: it costs a student a listing they can fix with a mode bit
 * rather than a file, so it is not the #109 bug even though it is the same shape.
 */
async function realPathOrAbsent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export function fileSystemWorkspace(rootPath: string): Workspace {
  const root = resolve(rootPath);

  /** Where a kind of file lives: a folder of the layout, or the Workspace root itself. */
  const folderPath = (ref: { kind: WorkspaceRef["kind"] }): string => {
    const folder = folderFor(ref);
    return folder === undefined ? root : join(root, DIRECTORY[folder]);
  };

  const filePath = (ref: WorkspaceRef): string => {
    switch (ref.kind) {
      case "catalog":
        return join(folderPath(ref), `${ref.academicYear}.json`);
      case "state":
        // The only ref carrying free text, so the only one that could steer this anywhere
        // but the root. The rule and the refusal are both the port's, so the in-memory double
        // refuses the same names in the same words; refusing here, before a path is built, is
        // what keeps `..` from ever being resolved.
        requireStateFileName(ref.name);
        return join(root, `${ref.name}.state.json`);
    }
  };

  /**
   * The temporary file a write goes through, in the folder holding the file it replaces so
   * that the rename stays within one filesystem and is therefore atomic. The pid is in the
   * name so two servers on one Workspace cannot write the same temporary, and the real name
   * follows it so a stray one says which file it was a write of.
   *
   * A State File's temporary still ends in `.state.json`, so what keeps it out of a listing
   * is the leading dot: `isStateFileName` refuses a name starting with one, and `list`
   * filters by the same rule it writes by.
   */
  const temporaryPath = (ref: WorkspaceRef): string =>
    join(folderPath(ref), `.tmp-${process.pid}-${basename(filePath(ref))}`);

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

  /**
   * The bytes of a file, nothing when there is **no file**, and `UnreadableError` when there
   * is one whose contents cannot be read. Three answers rather than two, and only the first
   * may be `undefined` (#109).
   *
   * A read of a State File needs the bytes themselves and not the text they decode to,
   * because the revision is taken from them: decoding first would hash a normalised copy of
   * the file rather than the file.
   */
  const bytesOrAbsent = async (path: string): Promise<Uint8Array | undefined> => {
    try {
      return await readFile(path);
    } catch (error) {
      const code = errnoOf(error);
      if (code !== undefined && ABSENT.includes(code)) return undefined;
      throw new UnreadableError(path.replace(root, "."), code);
    }
  };

  /**
   * What a file holds: its JSON, or its text when that is not what it holds.
   *
   * **A leading UTF-8 BOM is not content**, and dropping it is the intended behaviour rather
   * than an accident of decoding separately from reading (#109). `TextDecoder` drops one and
   * a Node `utf8` read does not, so before the revision needed the bytes, a Catalog or State
   * File written by one of the several Windows editors that add a BOM came back from here as
   * raw text — `JSON.parse` throws on it — and now parses. A hand-dropped Catalog is exactly
   * the case docs/design.md, "Storage" cares about, so the file should be read as the JSON it
   * holds.
   *
   * The **revision** is taken from the bytes as read, BOM included, and not from what this
   * decodes: two files differing only by a BOM are two files on disk, and a guard that called
   * them one revision would be blind to whichever tool added or removed it.
   */
  const contentOf = (bytes: Uint8Array): unknown => {
    const raw = new TextDecoder().decode(bytes);
    try {
      return JSON.parse(raw);
    } catch {
      // Content that is not JSON is handed back as it was found. Reporting it is the
      // caller's job, and inventing a stand-in value here would hide what is wrong.
      return raw;
    }
  };

  /**
   * The revision the file holds right now, or nothing when there is no file — and neither
   * when the file is there and cannot be read: `bytesOrAbsent`'s refusal propagates, so a
   * save whose current revision cannot be determined is refused rather than compared against
   * an `undefined` that a first save would match (#109).
   */
  const revisionOnDisk = async (path: string): Promise<StateFileVersion | undefined> => {
    const bytes = await bytesOrAbsent(path);
    return bytes === undefined ? undefined : revisionOf(bytes);
  };

  /**
   * Written to a temporary name in the same directory and renamed over the target, which is
   * atomic on a POSIX filesystem: an interrupted write leaves the previous file whole rather
   * than truncating it (docs/design.md, "Storage"). Both writes go through this, so neither
   * can lose the cleanup the other has.
   */
  const writeAtomically = async (ref: WorkspaceRef, target: string, json: string): Promise<void> => {
    const temporary = temporaryPath(ref);
    try {
      await writeFile(temporary, json, "utf8");
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };

  /** A folder is usable only if it exists *and* stays inside the Workspace. */
  const usablePath = async (path: string): Promise<string | undefined> => {
    const realRoot = await realPathOrAbsent(root);
    const real = await realPathOrAbsent(path);
    if (realRoot === undefined || real === undefined) return undefined;
    return within(real, realRoot) ? path : undefined;
  };

  /** A folder counts towards the layout only if it is usable. */
  const usableFolder = (folder: WorkspaceFolder): Promise<string | undefined> =>
    usablePath(join(root, DIRECTORY[folder]));

  /** The parts of the layout that are not there, which is what "not a Workspace" means. */
  const missingFolders = async (): Promise<WorkspaceFolder[]> => {
    const missing: WorkspaceFolder[] = [];
    for (const folder of WORKSPACE_LAYOUT) {
      if ((await usableFolder(folder)) === undefined) missing.push(folder);
    }
    return missing;
  };

  return {
    async status(): Promise<WorkspaceStatus> {
      const missing = await missingFolders();
      return { ready: missing.length === 0, missing };
    },

    async create(): Promise<void> {
      for (const folder of WORKSPACE_LAYOUT) {
        await mkdir(join(root, DIRECTORY[folder]), { recursive: true });
      }
    },

    async list(kind): Promise<WorkspaceRef[]> {
      const folder = await usablePath(folderPath({ kind }));
      if (folder === undefined) return [];

      let entries: string[];
      try {
        entries = await readdir(folder);
      } catch {
        return [];
      }
      if (kind === "state") {
        // A State File shares the root with the layout and with whatever else the student
        // keeps there, so a name this adapter would refuse to write is not listed either —
        // its own temporary file, which starts with a dot, among them.
        return entries
          .flatMap((entry) => {
            const name = STATE_FILE.exec(entry)?.[1];
            return name !== undefined && isStateFileName(name) ? [name] : [];
          })
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .map((name) => ({ kind: "state" as const, name }));
      }
      return entries
        .map((name) => CATALOG_FILE.exec(name))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ kind: "catalog" as const, academicYear: Number(m[1]) }))
        .sort((a, b) => a.academicYear - b.academicYear);
    },

    async read(ref): Promise<unknown> {
      // the runtime half of the narrowing to a `CatalogRef`, which a cast defeats (#113)
      requireCatalogRef(ref);
      const target = filePath(ref);
      requireJsonName(target);

      const check = await contained(target);
      if ("missing" in check) return undefined;

      const bytes = await bytesOrAbsent(check.path);
      return bytes === undefined ? undefined : contentOf(bytes);
    },

    async write(ref, data): Promise<void> {
      // The runtime half of the narrowing to a `CatalogRef` (#113). Also what puts a State
      // File back behind a layout check: the one this used to carry could not be written once
      // the parameter was narrowed, and a cast reached an unguarded write into a folder
      // nobody agreed to. Refusing the ref outright is a stronger check than restoring it.
      requireCatalogRef(ref);
      const target = filePath(ref);
      requireJsonName(target);

      const check = await contained(target);
      // A Catalog's folder not being there is what makes the target missing, so that check
      // is also the one that keeps a Catalog out of a folder nobody agreed to.
      if ("missing" in check) throw new Error(NOT_A_WORKSPACE);
      // serialise first: a value that cannot be written must not reach the filesystem
      await writeAtomically(ref, check.path, JSON.stringify(data, null, 2) + "\n");
    },

    async readStateFile(ref: StateFileRef): Promise<StateFileContents | undefined> {
      const target = filePath(ref);
      requireJsonName(target);

      const check = await contained(target);
      if ("missing" in check) return undefined;

      const bytes = await bytesOrAbsent(check.path);
      // The revision comes from the same bytes the content does, in one read: two reads
      // could hash one file and parse another.
      return bytes === undefined
        ? undefined
        : { data: contentOf(bytes), version: revisionOf(bytes) };
    },

    /**
     * The external-edit guard (#90; docs/design.md, "External edits"). The file is read again
     * here and refused when it is not the revision the save was based on — including when the
     * save was based on there being no file and there now is one, which is the same claim
     * about the same file and is checked the same way.
     *
     * **The window this does not close.** Between the hash below and the rename, another
     * process can still write, and no POSIX rename can be made conditional on the target's
     * content. Closing it would need a lock file, which the design already has for a second
     * server on one Workspace and which cannot bind Dropbox or an editor anyway. What this
     * guard is for is a file changed seconds or minutes ago by a sync client, a checkout or
     * another tab, and for those the window is not where the risk is. Said out loud rather
     * than implied by a check that looks total.
     */
    async saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<StateFileVersion> {
      const target = filePath(ref);
      requireJsonName(target);

      const check = await contained(target);
      if ("missing" in check) throw new Error(NOT_A_WORKSPACE);
      // A State File lives at the root, and a root exists whether or not the folder is a
      // Workspace, so for this one the layout is asked about outright. Nothing is written
      // into a folder the student has not agreed to (docs/design.md, "Storage").
      if ((await missingFolders()).length > 0) throw new Error(NOT_A_WORKSPACE);

      // serialise first: a value that cannot be written must not reach the filesystem
      const json = JSON.stringify(save.json, null, 2) + "\n";

      // as late as it can be made, so that as little as possible happens between the check
      // and the rename it guards
      const found = await revisionOnDisk(check.path);
      if (found !== save.basedOn) {
        throw new StateFileChangedError(ref.name, { basedOn: save.basedOn, found });
      }

      await writeAtomically(ref, check.path, json);
      // the revision of what was just written: a read of it would hash these same bytes
      return revisionOf(new TextEncoder().encode(json));
    },

    /**
     * One `fs.watch` per watched folder — the Workspace root and each of `WATCHED_FOLDERS`
     * that is there — and none on a file. A folder watch is what sees a Catalog *appear*; a
     * file watch cannot, because there is nothing to attach it to yet (docs/design.md,
     * "Storage").
     *
     * Not `{ recursive: true }`, which would be one line instead of these: a Workspace that
     * came from a git clone has `.git` inside it, and a recursive watch turns every git
     * operation into a page reload. Non-recursive sees `.git` as one entry in the root and
     * stays quiet about what happens inside it. Recursive support also differs by platform
     * and by runtime, and this has to hold on Bun and Deno as well as Node.
     *
     * Every event reconciles the set, so a `catalogs/` that appears after the server
     * started — the layout being created, or a clone landing — gets a watcher of its own,
     * and one that is deleted loses the stale watcher it left behind. A folder that could
     * not be watched is retried by the next event from any other folder, which means a
     * Workspace whose *every* watcher has failed stays unwatched until the server restarts.
     * Saying so out loud rather than hiding it: reporting that needs a channel the port does
     * not have, and giving it one is a design question of its own.
     */
    async watch(onChange): Promise<WorkspaceWatcher> {
      const open = new Map<string, FSWatcher>();
      let stopped = false;
      let reconciling = false;
      let againAfter = false;

      const watchFolder = (path: string): void => {
        if (stopped || open.has(path)) return;
        let watcher: FSWatcher;
        try {
          // `persistent: false` so the watcher does not hold the event loop open on Node
          // and Bun. Deno ignores it — measured, not assumed — so there only `stop` below
          // releases the handle; server/src/serve.ts says why no production path calls it
          // and why that is still safe.
          watcher = watch(path, { persistent: false }, () => {
            if (stopped) return;
            void reconcile();
            onChange();
          });
        } catch {
          // Node and Bun refuse a folder they cannot watch by throwing from here — most
          // often one that has just gone away, but a permission or a descriptor limit says
          // the same thing in the same place, and this cannot tell them apart. All of them
          // mean this folder is not watched; the others still are.
          return;
        }
        // Deno reports the same refusal asynchronously, on the watcher. Unhandled, it is
        // an uncaught error that takes the server down, so both spellings are handled. The
        // path is left out of `open`, so the next reconcile may pick it up again.
        watcher.on("error", () => {
          watcher.close();
          if (open.get(path) === watcher) open.delete(path);
        });
        open.set(path, watcher);
      };

      /** The folders that exist right now, watched; the ones that no longer do, let go. */
      const reconcile = async (): Promise<void> => {
        if (reconciling) {
          againAfter = true;
          return;
        }
        reconciling = true;
        try {
          do {
            againAfter = false;

            const wanted = new Set<string>();
            if ((await realPathOrAbsent(root)) !== undefined) wanted.add(root);
            for (const folder of WATCHED_FOLDERS) {
              const path = await usableFolder(folder);
              if (path !== undefined) wanted.add(path);
            }
            if (stopped) return;

            for (const [path, watcher] of [...open]) {
              if (wanted.has(path)) continue;
              watcher.close();
              open.delete(path);
            }
            for (const path of wanted) watchFolder(path);
          } while (againAfter && !stopped);
        } finally {
          reconciling = false;
        }
      };

      await reconcile();

      return {
        stop: () => {
          stopped = true;
          for (const watcher of open.values()) watcher.close();
          open.clear();
        },
      };
    },
  };
}

/**
 * Which part of the layout a reference lives in, or `undefined` for one that lives at the
 * Workspace root — which a State File does, because a Workspace holds one or more of them
 * and the design puts them there (docs/design.md, "Storage").
 */
function folderFor(ref: { kind: WorkspaceRef["kind"] }): WorkspaceFolder | undefined {
  switch (ref.kind) {
    case "catalog":
      return "catalogs";
    case "state":
      return undefined;
  }
}

/**
 * Only `.json` is read or written, the temporary file a write goes through included —
 * which is why that one is named `.tmp-<pid>-<the real name>` rather than ending in `.tmp`.
 * Every name this module builds satisfies the rule, so this guards a future caller
 * rather than today's one. That is the point: the rule should not depend on being
 * remembered.
 */
function requireJsonName(path: string): void {
  if (!path.endsWith(".json")) {
    throw new WorkspaceRefusedError(`refusing ${path}: only .json files are read or written`);
  }
}
