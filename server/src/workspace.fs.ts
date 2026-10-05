import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  BackupRefusedError,
  backupsToPrune,
  isStateFileName,
  NotAWorkspaceError,
  requireBackupRef,
  requireCatalogRef,
  requireStateFileName,
  StateFileChangedError,
  statusOf,
  WORKSPACE_LAYOUT,
  WorkspaceRefusedError,
  type BackupRef,
  type StateFileContents,
  type StateFileRef,
  type Workspace,
  type WorkspaceFolder,
  type WorkspaceRef,
  type WorkspaceRefusalSubject,
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

/** Literal patterns, never built from data (ADR-0007). */
const CATALOG_FILE = /^(\d{4})\.json$/;
const STATE_FILE = /^(.+)\.state\.json$/;

/**
 * A snapshot in `.backups/`: the State File's name, the moment it was taken, and the same
 * `.state.json` suffix the file itself carries — `alice.2026-10-04T09-31-07-412Z.state.json`.
 *
 * **UTC, and hyphens where an ISO string has colons and a dot.** A colon is a character
 * Windows refuses in a file name and `isStateFileName` refuses in a State File's, so an
 * `Date.prototype.toISOString` stamp could not be a file name on every platform this has to
 * run on. UTC is `backupDay`'s own answer and its doc says why; it also makes the names sort
 * in the order they were taken, so a reader looking in the folder by hand sees a history.
 *
 * The **last** stamp-shaped segment is read as the timestamp and everything before it as the
 * name: a State File really may be called `alice.2027`, or even
 * `alice.2026-10-07T12-00-00-000Z`, because `isStateFileName` allows a dot that is not the first
 * character. **What decides that is the `$` anchor and not `.+`'s greediness** — measured, not
 * assumed: the pattern passes the two-stamp test with `.+?` as well, because the anchor forces
 * the stamp to the end whichever way the group leans. The anchors are the part that may not be
 * taken away. A name this adapter would refuse to write is not listed either, exactly as `list`
 * filters State Files, so this adapter's own temporary — which starts with a dot — never appears
 * as a snapshot.
 *
 * Four digits of year and no more, which is also what `stampOf` writes. A clock set past the
 * year 9999 would produce a snapshot nothing lists; that is a lost listing rather than a lost
 * file, and it is written down here rather than guarded against.
 *
 * **The small end is asymmetric in the other direction**: `stampOf` pads year 50 to `0050`, and
 * `Date.UTC` reads a year of 0 to 99 as 1900 to 1999, so the round-trip below fails and a
 * snapshot this adapter *did* write is neither listed nor pruned. It needs a system clock set
 * in antiquity, and like the year 9999 it is recorded rather than guarded — but it is a
 * write-then-cannot-read-back rather than the read-only asymmetry above, so it is the worse of
 * the two and is said separately.
 */
const BACKUP_FILE = /^(.+)\.(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.state\.json$/;

/**
 * The folders a watch covers: the Workspace root, plus these. The Workspace Layout minus
 * `.backups`, because a rotating snapshot is written only by the app and nothing in it is ever
 * shown — so a backup is not news, and watching it would turn every future autosave's snapshot into
 * a page reload (docs/design.md, "Storage").
 *
 * **`.backups` is the only exclusion, and it is not the start of a list.** Read the ruling
 * below before adding a second one.
 *
 * ## This watcher reports the app's own writes on purpose (#88)
 *
 * Everything the app writes into a watched folder is reported. A Catalog import writes
 * `.tmp-<pid>-<year>.json` into `catalogs/` and renames it; a State File save writes
 * `.tmp-<pid>-<name>.state.json` into the **root**, where State Files live, and renames it —
 * `temporaryPath` below is the one that builds both, pid first and the real name after. All
 * four events are reported, and once autosave exists that is a reported change every few
 * seconds of editing, each one caused by the page that will be told about it. (#88's body
 * writes the Catalog temporary as `.tmp-<year>-<pid>.json`, which is the two halves the other
 * way round; the code is what this follows.)
 *
 * **That is correct and nothing here suppresses it.** The folder really did change, and a
 * count that said otherwise would be lying about the one thing it carries. The harm was never
 * that the count moves — it was that a page reloading discarded what the student was doing —
 * so the fix is in `web`, which re-fetches and reconciles rather than resetting
 * (`web/src/timetable/TimetableScreen.tsx`, `useReloading`). A page's own write costs it one
 * loopback request and nothing visible.
 *
 * **Why not suppress here, which is the obvious shape.** Because the count is *global*:
 * `app/src/changes.ts` keeps one counter and `server/src/api.ts` serves it to every poller,
 * with no per-connection state anywhere on that path. An adapter that swallowed the event its
 * own write caused would swallow it for every page — and **two tabs on one document are in
 * scope** (ADR-0013: one undo history, one save guard, one document). Tab A's save *is* tab
 * B's external change. Suppression here would hide it from B, which is a worse defect than
 * the one it fixes: the reload this watcher exists for, silently gone. Suppressing only the
 * temporaries does not help either — the rename onto the real name is the event that matters,
 * and it looks exactly like an editor saving that file.
 *
 * **Whose write it was is the save guard's question, and it is answered from content.**
 * `saveStateFile` below compares the revision a save was based on against the revision on
 * disk, and `server/src/history.ts` keeps the revision it last wrote for the same reason. A
 * SHA-256 of the bytes is exact; a filesystem event carries no author and never will. Do not
 * try to recover one here.
 *
 * **Binds #80, #67 and #73.** #80 and #73 write into a watched folder — the first save from
 * the UI, and an undo, which goes through the same guarded save. #67 is the other way round
 * and is bound for that reason: its snapshots go into `.backups/`, where nothing is watched,
 * so they move no count and may not be made to by watching that folder — and a *restore*
 * writes a State File into the root, which is watched and is reported like any other save.
 * None of the three may add suppression, and each must leave the page able to tolerate its
 * own write.
 *
 * **#67 landed and this held.** A snapshot and a pruning now happen inside every save, both
 * of them in `.backups/`, and `.backups` stayed off this list: the count does not move for
 * either, so autosave will not be a reload per save. The *restore* is an ordinary guarded
 * save of the State File at the root, so it is reported exactly as any other save is — which
 * is what the ruling above says should happen and the opposite of suppression.
 */
const WATCHED_FOLDERS: WorkspaceFolder[] = ["catalogs", "requirements"];

/**
 * A target that resolves outside the Workspace: a Catalog that is a symlink to somewhere else,
 * or a folder of the Workspace Layout that is.
 *
 * **It names the ref or its folder and never the path** (#216). It used to word itself
 * `refusing ./catalogs/2027.json: …` — the Workspace-relative spelling of the target, which is
 * smaller than an absolute path and is still a file path, and which travelled out as a Warning
 * over the Catalog query routes until #249. It now carries the ref or its folder as the
 * refusal's subject, and `describe` words its message from that, saying which Catalog, which
 * State File, which snapshot instead.
 *
 * **Nothing is kept on `cause` here, and nothing is lost by that.** `UnreadableError` and
 * `UnwritableError` carry the filesystem's own error, which is the only place the path it met
 * exists; this refusal is made by this module out of a path it built itself, so whoever wants
 * that path has the ref and the Workspace root and can build the same one. Inventing a second
 * channel for it is #165's question and not this one's.
 */
class OutsideWorkspaceError extends WorkspaceRefusedError {
  constructor(about: WorkspaceRefusalSubject) {
    super(
      { reason: "outside-workspace", subject: about },
      `refusing ${describe(about)}: it resolves outside the Workspace`,
    );
  }
}

/**
 * The errno codes that mean there is **no file**, as against a file that is there and cannot
 * be read. `ENOENT` is nothing at that name. `ENOTDIR` is nothing at that name either — a
 * component of the path is a plain file, so nothing can exist below it — and that reading of
 * it holds because of the paths *this* module builds: `filePath` appends a suffix to a name
 * `isStateFileName` has cleared of separators, so none of them ends in one. (A trailing
 * separator on an existing file gives `ENOTDIR` too, and there it would mean something else.)
 * Every other code, and an error carrying no code at all, is the third answer below:
 * unreadable, not absent, which is the safe way round for anything this cannot recognise
 * (#109).
 *
 * **For a *file's* path, which is every path this list is asked about.** `entriesOrAbsent` asks
 * about a folder itself rather than a file below one, and there `ENOTDIR` is the opposite
 * answer: what was named is there and is not a folder, which is a state of the Workspace and
 * not absence. So this list is deliberately not shared with it, and reusing it there is the
 * defect #129 was filed to prevent.
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
 * maps to `workspace-refused` and the page already words as Picks that could not be read.
 *
 * **A folder that cannot be listed is the same answer**, which is why `because` can be said
 * rather than assumed (#129). Listing is how a folder is read, so `EACCES` on `catalogs/` is
 * this error with nothing added; a `catalogs` that is a plain file is this error too — there is
 * something at that name and no listing can be had of it — but "cannot be read" would be
 * untrue of it, since it reads perfectly well as the file it is. `UnwritableError`'s doc states
 * the principle this follows: "catalogs is not a folder" is worth more than `ENOTDIR` to
 * whoever reads it. The errno stays on the end of both, as `UnwritableError` keeps it, because
 * the sentence is the news and the code is for a log.
 *
 * **It names the ref or its folder and never the path** (#216), and it takes the filesystem's
 * error rather than the errno out of it so that error can stay on `cause` — which is what
 * `UnwritableError` already did, and that asymmetry was the whole of why this one had to word
 * itself with a path to say anything at all. `cause` is where a log can reach the absolute path
 * the filesystem met and a response cannot (#165).
 */
class UnreadableError extends WorkspaceRefusedError {
  constructor(about: WorkspaceRefusalSubject, error: unknown, { notAFolder = false } = {}) {
    const code = errnoOf(error);
    const because = notAFolder
      ? "it is there and is not a folder"
      : "it is there and cannot be read";
    super(
      { reason: notAFolder ? "not-a-folder" : "unreadable", subject: about },
      `refusing ${describe(about)}: ${because}` + (code === undefined ? "" : ` (${code})`),
      { cause: error },
    );
  }
}

/**
 * A write that could not be made: the target's folder is not a folder after all, the disk is
 * full, the filesystem is read-only, a mode bit is in the way. **The write side of #109's
 * ruling**, which gave a read three answers and left a write with two — written, or whatever
 * the filesystem threw, raw and out of the port. Raw is the one answer this port may not give:
 * it is caught by nothing, so it becomes a 500, and #121 was filed because that would be the
 * first unnamed one in `server/src/api.ts`.
 *
 * A `WorkspaceRefusedError`, so a caller can answer it the way every caller of this port
 * already answers one: a Warning and never a crashed server (docs/design.md, "API and data
 * rules"). **No caller reads this sentence** (#249): the callers in `app` answer a refusal with
 * a reason of their own, and the one that serves a sentence — the Catalog read in
 * `app/src/queries.ts` — words its own from the refusal's reason code and subject. So the errno
 * below is for a log (#165), and saying otherwise here would claim something the app does not
 * do.
 *
 * **Every failure and not a list of codes.** An enumeration is what #109 found the hole in:
 * the code nobody thought of is the one that escapes. So the recognising is done on the way in
 * — `requireLayoutFolder` names the Workspace Layout mistake before a byte is written, because
 * "catalogs is not a folder" is worth more than `ENOTDIR` to whoever reads it — and this is what is
 * left over.
 *
 * **It names the ref and never the path.** The API exposes domain operations and never a file
 * path (CLAUDE.md; docs/design.md, "API and data rules", rule 1), and a refusal's message
 * travelled out as a Warning until #249 and goes to a log now, which is no place for a path
 * either; a filesystem error's own message carries the absolute path, so the errno is kept and
 * the rest is dropped. The error itself stays on `cause`, where a log can
 * reach it and a response cannot.
 *
 * **That is now the rule for every refusal this module makes and not this one's alone** (#216).
 * `UnreadableError` and `OutsideWorkspaceError` worded themselves with a Workspace-relative path
 * and `requireJsonName` with an absolute one; all three now take the refusal's subject and word
 * it through `describe`. The one that reached the wire was `UnreadableError` out of a Catalog
 * read, whose message `app/src/queries.ts` carried as the `reason` on `workspace-refused` — which
 * is why, since #249, it carries `app`'s sentence instead and no wording here can reach a route.
 */
class UnwritableError extends WorkspaceRefusedError {
  constructor(about: WorkspaceRefusalSubject, error: unknown) {
    const code = errnoOf(error);
    super(
      { reason: "unwritable", subject: about },
      `refusing to write ${describe(about)}: it could not be written` +
        (code === undefined ? "" : ` (${code})`),
      { cause: error },
    );
  }
}

/**
 * What a ref is, in the domain's words, for a refusal's message, which goes to a log (#165); what a
 * student reads is worded by `app` (`app/src/refusal.ts`, #249). Not the path: see
 * `UnwritableError`.
 */
const describeRef = (ref: WorkspaceRef | BackupRef): string => {
  switch (ref.kind) {
    case "catalog":
      return `the Catalog for the Academic Year ${ref.academicYear}`;
    case "state":
      return `the State File ${JSON.stringify(ref.name)}`;
    case "backup":
      return (
        `the snapshot of the State File ${JSON.stringify(ref.name)} ` +
        `taken at ${stampOf(ref.takenAt)}`
      );
  }
};

/**
 * What the *container* of a ref is, in the domain's words: the folder of the Workspace Layout it
 * lives in, or the Workspace root for a State File, which is where those live.
 *
 * The other half of what #216 needs: a refusal is about a file, which the ref itself names, or
 * about the folder that file is listed from or written into, which is `folderSubject`'s answer —
 * a refusal subject (#249) — and this record is how `describe` words it for a message.
 * `DIRECTORY` at the top maps the same folders to their names on disk, and the two are
 * deliberately alike in shape: one is what the filesystem is told, the other what a caller who
 * may not know there is a filesystem is told.
 *
 * `requirements` has no ref kind of its own and so is unreachable today. It is here because the
 * record is total over `WorkspaceFolder` and the rule should not depend on being remembered —
 * exactly the standing `requireJsonName` has, and its reason.
 */
const FOLDER_DESCRIPTION: Record<WorkspaceFolder, string> = {
  catalogs: "the folder holding the Workspace's Catalogs",
  requirements: "the folder holding the Workspace's Requirements Files",
  backups: "the folder holding the Workspace's snapshots",
};

const folderSubject = (ref: { kind: WorkspaceRef["kind"] | "backup" }): WorkspaceRefusalSubject => {
  const folder = folderFor(ref);
  return folder === undefined ? { kind: "workspace" } : { kind: "folder", folder };
};

/** A refusal's subject in this adapter's words, for its message: a ref, a folder, or the root. */
const describe = (about: WorkspaceRefusalSubject): string => {
  switch (about.kind) {
    case "folder":
      return FOLDER_DESCRIPTION[about.folder];
    case "workspace":
      return "the Workspace root";
    default:
      return describeRef(about);
  }
};

/**
 * The timestamp in a snapshot's name, built from the UTC fields rather than by slicing
 * `toISOString()`: that one throws on a date outside its range and widens the year past four
 * digits beyond 9999, and this has to produce a file name rather than an exception.
 */
const stampOf = (takenAt: number): string => {
  const at = new Date(takenAt);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}-${pad(at.getUTCMinutes())}-${pad(at.getUTCSeconds())}` +
    `-${pad(at.getUTCMilliseconds(), 3)}Z`
  );
};

/**
 * The moment a snapshot's name records, or nothing when the name is not a snapshot's. The
 * digits are read and handed to `Date.UTC`; nothing here is executed or built from what it
 * read (ADR-0007).
 */
const backupFromFileName = (entry: string): BackupRef | undefined => {
  const parts = BACKUP_FILE.exec(entry);
  if (parts === null) return undefined;
  const [, name, year, month, day, hour, minute, second, millisecond] = parts;
  // No group of the pattern is optional, so this is unreachable — and it is the narrowing the
  // compiler asks for rather than a cast, because `requireCatalogRef`'s doc is a long argument
  // about what a cast costs and this file is where that argument is cashed.
  if (name === undefined || millisecond === undefined) return undefined;
  if (!isStateFileName(name)) return undefined;
  const takenAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond),
  );
  // A name can spell a day that does not exist — `2026-02-31` — and `Date.UTC` rolls it over
  // into the next month rather than refusing. Round-tripping the stamp is what catches that:
  // a name this adapter did not write is not a snapshot, and is left alone rather than
  // listed as a moment it does not name.
  return stampOf(takenAt) === entry.slice(name.length + 1, -".state.json".length)
    ? { kind: "backup", name, takenAt }
    : undefined;
};

/**
 * Whether a path is a folder — following symlinks, as `usablePath` does through `realpath`, so
 * a folder of the Workspace Layout that is a symlink to a directory inside the Workspace passes
 * both. Anything that cannot be asked is not a folder to write into, and absence is a case the
 * caller has already answered (`contained`).
 */
const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Which revision of a State File this is: a SHA-256 of its bytes, as hex. ADR-0015 records the
 * decision and the two alternatives below; this is where it is carried out.
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
 * plan open side by side, which is the workflow this app replaces: the revision has to be small
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
 * Two answers here and three in `bytesOrAbsent`, and the difference is deliberate — but it is
 * a narrower difference than it looks, so said fully. A folder that exists and cannot be
 * `realpath`ed reports the Workspace Layout as missing, and everything that asks — `status`,
 * `missingFolders`, `usablePath`, `contained` — then refuses every write and lists nothing.
 * **A read, though, still answers absence**: `contained` says `missing` and `read` and
 * `readStateFile` hand back `undefined`, so a Workspace under an unreadable parent shows an
 * empty week rather than a refusal. It is not the #109 bug, because it fails **closed** — the
 * layout reads as missing, so the save is refused and the bytes survive — but it is the same
 * shape, and telling a `realpath` that failed for want of a file from one that failed for want
 * of permission would be a change to `status` and to what "not a Workspace" means, which is
 * its own ticket rather than a line here (#109 says as much).
 */
async function realPathOrAbsent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export function fileSystemWorkspace(
  rootPath: string,
  options: {
    /**
     * The clock a snapshot is stamped with. A parameter so the retention rule can be driven
     * across days in a test without waiting for them; `Date.now` otherwise (#67).
     */
    now?: () => number;
  } = {},
): Workspace {
  const root = resolve(rootPath);
  const now = options.now ?? Date.now;

  /** Where a kind of file lives: a folder of the Workspace Layout, or the Workspace root itself. */
  const folderPath = (ref: { kind: WorkspaceRef["kind"] | "backup" }): string => {
    const folder = folderFor(ref);
    return folder === undefined ? root : join(root, DIRECTORY[folder]);
  };

  const filePath = (ref: WorkspaceRef | BackupRef): string => {
    switch (ref.kind) {
      case "catalog":
        return join(folderPath(ref), `${ref.academicYear}.json`);
      case "backup":
        // The port's own refusal, so both adapters refuse the same refs in the same words: the
        // name is a State File's, and the moment is a whole number — either of them free text
        // would be a path built out of `.backups/`.
        requireBackupRef(ref);
        return join(folderPath(ref), `${ref.name}.${stampOf(ref.takenAt)}.state.json`);
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
  const temporaryPath = (ref: WorkspaceRef | BackupRef): string =>
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
   * is not. `undefined` means the Workspace Layout is simply not there yet.
   *
   * **The ref comes with the path so the refusal can name it and not the path** (#216). The two
   * arms are still told apart, in domain words rather than by naming a different path: the
   * target itself points out of the Workspace, or the folder it would live in does.
   */
  const contained = async (
    target: string,
    ref: WorkspaceRef | BackupRef,
  ): Promise<{ path: string } | { missing: true }> => {
    const realRoot = await realPathOrAbsent(root);
    if (realRoot === undefined) return { missing: true };

    const real = await realPathOrAbsent(target);
    if (real !== undefined) {
      if (!within(real, realRoot)) throw new OutsideWorkspaceError(ref);
      return { path: target };
    }

    const parent = await realPathOrAbsent(dirname(target));
    if (parent === undefined) return { missing: true };
    if (!within(parent, realRoot)) throw new OutsideWorkspaceError(folderSubject(ref));
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
   *
   * **`about` is the file the refusal is about** — the ref, passed in by the caller that has it —
   * and is the refusal's subject (#249). This is the refusal that reached the wire: a Catalog
   * read's message used to go out as a Warning, carrying `./catalogs/2027.json` (#216), and
   * `app/src/queries.ts` now words that Warning from the subject instead.
   */
  const bytesOrAbsent = async (
    path: string,
    about: WorkspaceRefusalSubject,
  ): Promise<Uint8Array | undefined> => {
    try {
      return await readFile(path);
    } catch (error) {
      const code = errnoOf(error);
      if (code !== undefined && ABSENT.includes(code)) return undefined;
      throw new UnreadableError(about, error);
    }
  };

  /**
   * The names in a folder, nothing when there is **no folder**, and `UnreadableError` when there
   * is something at that name no listing can be had of. `bytesOrAbsent`'s three answers, for the
   * one function #109 did not pass through: a `readdir` that failed for any reason at all used
   * to answer `[]`, so a `catalogs/` the app may not list was indistinguishable from one holding
   * nothing (#129).
   *
   * **`ENOENT` alone is absence here, and that is the whole of the difference from
   * `bytesOrAbsent` in what counts as absent.** `ABSENT` is right for the paths that one is
   * given — a plain file part way along a *file's* path means nothing can exist below it — and
   * wrong for this one, which names the folder itself. `ENOTDIR` here says what was named is
   * there and is not a folder, which is a state of the Workspace and the opposite of absence:
   * `usablePath` asks whether a path resolves inside the Workspace and not what it *is*, so a
   * `catalogs` that is a plain file gets this far, and `status` reports it under `notAFolder`
   * (#243). Answering "no Catalogs" because `catalogs` is a file would be the lie #129 was filed
   * about, in its most visible form.
   *
   * Recognised from the errno rather than by asking `isDirectory` first, which is what
   * `requireLayoutFolder` does on the write side. A write has a reason to ask in advance — it
   * refuses before a byte is written — and a read has none: asking costs a second syscall, races
   * the `readdir` that follows it, and would still need this handler for `EACCES`. Every code
   * but `ENOENT` is a refusal, so the code nobody thought of fails closed, which is the way
   * round #109 settled on.
   *
   * **The `ENOENT` arm is unreachable today and no test enters it**, which was measured rather
   * than reasoned: removing it fails nothing. `usablePath` has already answered for a folder that
   * is not there, so the only way to arrive here with `ENOENT` is a folder removed between that
   * `realpath` and this `readdir` — a student deleting `catalogs/` while the screen loads, which
   * no test can stage without a seam this does not have. It is kept because that student should
   * see an empty folder rather than a refusal, and because dropping it would make the arm's
   * absence the thing nobody remembers: `requireJsonName` and `requireLayoutFolder` in this file
   * stand on the same ground. The coverage in a pull request report will show the line, and it is
   * this paragraph rather than a missing case.
   *
   * **The folder is named rather than spelled as a path**: the caller passes `folderSubject`'s
   * answer, which is the refusal's subject and is worded by `describe` (#216, #249). It used to
   * be `path.replace(root, ".")` — `./catalogs`, and for the Workspace root a single dot, which
   * names nothing, so that one case was already special-cased here. Every folder is named now
   * and the special case is gone with it: the degenerate case was the whole of the wording
   * problem in miniature.
   */
  const entriesOrAbsent = async (
    path: string,
    about: WorkspaceRefusalSubject,
  ): Promise<string[] | undefined> => {
    try {
      return await readdir(path);
    } catch (error) {
      const code = errnoOf(error);
      if (code === "ENOENT") return undefined;
      if (code === "ENOTDIR") {
        throw new UnreadableError(about, error, { notAFolder: true });
      }
      throw new UnreadableError(about, error);
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
  const onDisk = async (
    path: string,
    about: WorkspaceRefusalSubject,
  ): Promise<{ bytes: Uint8Array; version: StateFileVersion } | undefined> => {
    const bytes = await bytesOrAbsent(path, about);
    // The bytes come back with the revision because the save needs both and from one read:
    // the snapshot it writes into `.backups/` is a copy of exactly the bytes this revision
    // was taken from, and a second read could hash one file and copy another (#67).
    return bytes === undefined ? undefined : { bytes, version: revisionOf(bytes) };
  };

  /**
   * A copy of the bytes a save is about to replace, into `.backups/` (#67; `docs/design.md`,
   * "Storage").
   *
   * **`.backups/` is required to be a folder before anything is written**, with the same
   * refusal a write into a `catalogs` that is a plain file gets. `status` reports a plain
   * `.backups` file as not ready (#243), but a save does not ask `status`: it asks
   * `missingFolders`, which counts only what is not there, so without this the snapshot would
   * meet the filesystem raw here (#121).
   *
   * **The millisecond is nudged past a name that is already taken.** A snapshot's name *is*
   * its timestamp, so two saves inside one millisecond would be one file and the second would
   * silently replace the first. That is a lost backup, which is the one thing this folder
   * exists to prevent, and the folder is being listed for the pruning anyway.
   */
  const snapshot = async (name: string, bytes: Uint8Array): Promise<void> => {
    await requireLayoutFolder({ kind: "backup" });
    const taken = new Set(
      await entriesOrAbsent(folderPath({ kind: "backup" }), folderSubject({ kind: "backup" })),
    );

    let takenAt = now();
    while (taken.has(basename(filePath({ kind: "backup", name, takenAt })))) takenAt += 1;

    const ref: BackupRef = { kind: "backup", name, takenAt };
    const target = filePath(ref);
    requireJsonName(target, ref);

    const check = await contained(target, ref);
    // `requireLayoutFolder` above has already answered for a `.backups` that is the wrong kind
    // of thing, so arriving here missing means the folder went away in between.
    if ("missing" in check) throw new NotAWorkspaceError();
    await writeAtomically(ref, check.path, bytes);
  };

  /**
   * Deletes the snapshots of one State File that the shared retention rule says may go, and
   * nothing else (`backupsToPrune` in the port, whose doc carries the rule and the three cases
   * where its two halves disagree).
   *
   * **It never refuses, and that is deliberate.** It runs after the save has landed, it only
   * deletes, and a snapshot it could not remove is one too many rather than one too few — so a
   * `.backups/` that cannot be listed or cannot be written costs an unpruned folder and never
   * a student's save. The refusal belongs on the way in, where `snapshot` makes it.
   */
  const prune = async (name: string): Promise<void> => {
    let going: BackupRef[];
    try {
      const entries =
        (await entriesOrAbsent(
          folderPath({ kind: "backup" }),
          folderSubject({ kind: "backup" }),
        )) ?? [];
      const held = entries.flatMap((entry) => {
        const ref = backupFromFileName(entry);
        return ref !== undefined && ref.name === name ? [ref] : [];
      });
      going = backupsToPrune(held, now());
    } catch {
      // A `.backups/` that cannot be listed, which `entriesOrAbsent` refuses: there is nothing
      // to decide from, so nothing is deleted and the save stands.
      return;
    }
    // One deletion per snapshot, each on its own, so a single entry that cannot be removed —
    // a directory standing where a snapshot's name belongs, a mode bit on that one file —
    // leaves the rest pruned rather than shielding them. One `try` around the whole loop made
    // the first failure end the pruning, and with an entry that can never be removed that is
    // `.backups/` growing without bound for the life of the Workspace.
    for (const snapshot of going) {
      await rm(filePath(snapshot), { force: true }).catch(() => undefined);
    }
  };

  /**
   * Written to a temporary name in the same directory and renamed over the target, which is
   * atomic on a POSIX filesystem: an interrupted write leaves the previous file whole rather
   * than truncating it (docs/design.md, "Storage"). Both writes go through this, so neither
   * can lose the cleanup the other has.
   */
  const writeAtomically = async (
    ref: WorkspaceRef | BackupRef,
    target: string,
    /**
     * The text of a JSON file, or the **bytes** of one. A snapshot is written from the bytes
     * the save read, so that a backup of a file somebody had written with a BOM is that file
     * and not a re-encoding of what this adapter decoded (`contentOf`, and the revision rule in
     * `docs/design.md`, "Encoding"): a restore of it must read back as the same revision.
     */
    contents: string | Uint8Array,
  ): Promise<void> => {
    const temporary = temporaryPath(ref);
    try {
      await writeFile(temporary, contents);
      await rename(temporary, target);
    } catch (error) {
      // The cleanup's own failure may not replace the refusal. `force` covers a temporary that
      // is not there and nothing else, so a directory holding the temporary's name — which
      // `writeFile` cannot write and `rm` without `recursive` cannot remove — threw out of this
      // handler ahead of the refusal, raw, by a third door of #121. Found by the sweep in
      // workspace.fs.test.ts rather than by a reading of this. What is left behind is a stray
      // temporary, which is in no listing and whose name says which write it was of, and the
      // failure below is the news.
      await rm(temporary, { force: true }).catch(() => undefined);
      // and the refusal leaves, never the filesystem's own error: raw, it is caught by nothing
      // and becomes a 500 (#121). `UnwritableError` says why that is the wrong answer.
      throw new UnwritableError(ref, error);
    }
  };

  /** A folder is usable only if it exists *and* stays inside the Workspace. */
  const usablePath = async (path: string): Promise<string | undefined> => {
    const realRoot = await realPathOrAbsent(root);
    const real = await realPathOrAbsent(path);
    if (realRoot === undefined || real === undefined) return undefined;
    return within(real, realRoot) ? path : undefined;
  };

  /** A folder counts towards the Workspace Layout only if it is usable. */
  const usableFolder = (folder: WorkspaceFolder): Promise<string | undefined> =>
    usablePath(join(root, DIRECTORY[folder]));

  /**
   * A write lands in a folder of the Workspace Layout, and that folder has to *be* one.
   *
   * `usablePath` asks whether a path resolves inside the Workspace, not what it is, so a
   * `catalogs` that is a plain **file** is usable. Without this the write opened its temporary
   * below that file and the filesystem answered `ENOTDIR`, raw (#121). `status` no longer calls
   * such a Workspace ready (`layoutOf`, #243), so the use cases in `app` stop at that answer
   * before they write; this is the port keeping its own promise to a caller that writes without
   * asking first, and the refusal names the folder.
   *
   * Asked here rather than by narrowing `usablePath`, which would make a `catalogs` that is a file
   * read as *missing* — and missing is the one thing it is not, since `create` cannot make a
   * folder whose name a file holds. The kind of a folder is a question a write asks, and this is
   * where a write asks it.
   */
  const requireLayoutFolder = async (ref: {
    kind: WorkspaceRef["kind"] | "backup";
  }): Promise<void> => {
    const folder = folderFor(ref);
    // `write` is the only caller and `requireCatalogRef` has already run there, so this line is
    // unreachable today and guards a future one — `requireJsonName`'s standing, and its reason.
    // A State File would need no check here anyway: it lives at the Workspace root, and
    // `missingFolders` answers for that, since a root that is a file holds no folder at all.
    if (folder === undefined) return;
    if (await isDirectory(join(root, DIRECTORY[folder]))) return;
    throw new NotAWorkspaceError({ folder, because: "is there and is not a folder" });
  };

  /**
   * What is wrong with the Workspace Layout, which is what "not a Workspace" means: the parts
   * that are **not there**, and the parts that are **there and are not a folder** (#243).
   *
   * Not there is what `usablePath` answers: no `realpath`, or one outside the Workspace. A part
   * that passes that is then asked what it *is*, because resolving inside the Workspace is all
   * `usablePath` says, and a plain `catalogs` file passes it. That file used to count towards the
   * Layout, so `status` called the Workspace ready and every write into it was refused.
   *
   * The `stat` is answered rather than raised, as everything behind `status` is: a part whose
   * `stat` fails after its `realpath` succeeded went away in between, which is not there.
   */
  const layoutOf = async (): Promise<{
    missing: WorkspaceFolder[];
    notAFolder: WorkspaceFolder[];
  }> => {
    const missing: WorkspaceFolder[] = [];
    const notAFolder: WorkspaceFolder[] = [];
    for (const folder of WORKSPACE_LAYOUT) {
      const path = await usableFolder(folder);
      const folderish =
        path === undefined
          ? undefined
          : await stat(path).then(
              (found) => found.isDirectory(),
              () => undefined,
            );
      if (folderish === undefined) missing.push(folder);
      else if (!folderish) notAFolder.push(folder);
    }
    return { missing, notAFolder };
  };

  /**
   * The parts of the Workspace Layout that are not there. A State File's save asks this and not
   * `layoutOf` as a whole, because a part that is there and is not a folder is refused by name
   * where it is reached: `.backups` by the snapshot (`BackupRefusedError`, #229), and `catalogs`
   * and `requirements` hold nothing a State File's save writes.
   */
  const missingFolders = async (): Promise<WorkspaceFolder[]> => (await layoutOf()).missing;

  return {
    async status(): Promise<WorkspaceStatus> {
      return statusOf(await layoutOf());
    },

    /**
     * Idempotent for a folder that is already there — `recursive` makes an existing directory
     * a success — and refused, rather than raw, for a name that is there and is not one: a
     * plain `catalogs` gives `EEXIST`, which is the same file `requireLayoutFolder` refuses a
     * write into, met from the other side. Reachable whenever a part of the Workspace Layout is a
     * file, because then `status` is not ready (#243) and a page that offers the Layout to every
     * Workspace that is not ready lands here when the student accepts (#121). `notAFolder` is
     * what tells that page to say so instead.
     *
     * **One `mkdir` at a time, and no rollback** (#166). A refusal on `requirements` or
     * `backups` leaves `catalogs` made, which the port's `create` says is allowed and names
     * `status()` as the way to see. Rolling back would need to know which `mkdir` made a folder
     * rather than found it, which `recursive` does not say, and a rollback that guessed wrong
     * would remove a folder the student already had.
     */
    async create(): Promise<void> {
      for (const folder of WORKSPACE_LAYOUT) {
        try {
          await mkdir(join(root, DIRECTORY[folder]), { recursive: true });
        } catch (error) {
          const code = errnoOf(error);
          // A bare `WorkspaceRefusedError` and deliberately not the shared `NotAWorkspaceError`,
          // which is a *write*'s refusal and says so in its first three words: this is a create,
          // and "refusing to write" would be untrue of it. The folder is in the sentence, as
          // `requireJsonName` puts what it refused in its own. The filesystem's error stays on
          // `cause`, where a log can reach it and a response cannot.
          throw new WorkspaceRefusedError(
            { reason: "not-created", subject: { kind: "folder", folder } },
            `refusing to create the Workspace layout: ${folder} could not be made` +
              (code === undefined ? "" : ` (${code})`),
            { cause: error },
          );
        }
      }
    },

    /**
     * Empty for a folder that is not there, and a refusal for one that is there and cannot be
     * listed: `entriesOrAbsent` is where the two are told apart, and its doc says why `ENOTDIR`
     * is not absence here although it is everywhere else in this module (#129).
     *
     * **Absence stays two answers wide**, and both are `[]`. `usablePath` already answers for a
     * folder that is not there, or whose `realpath` cannot be taken — which is a Workspace under
     * an unreadable parent, and `realPathOrAbsent`'s doc says why that reads as missing rather
     * than as a refusal. `entriesOrAbsent`'s `ENOENT` is the same answer for the race: a folder
     * removed between the `realpath` and the `readdir`.
     */
    async list(kind): Promise<WorkspaceRef[]> {
      const folder = await usablePath(folderPath({ kind }));
      if (folder === undefined) return [];

      const entries = await entriesOrAbsent(folder, folderSubject({ kind }));
      if (entries === undefined) return [];
      if (kind === "state") {
        // A State File shares the root with the Workspace Layout and with whatever else the student
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
      requireJsonName(target, ref);

      const check = await contained(target, ref);
      if ("missing" in check) return undefined;

      const bytes = await bytesOrAbsent(check.path, ref);
      return bytes === undefined ? undefined : contentOf(bytes);
    },

    async write(ref, data): Promise<void> {
      // The runtime half of the narrowing to a `CatalogRef` (#113). Also what puts a State
      // File back behind a layout check: the one this used to carry could not be written once
      // the parameter was narrowed, and a cast reached an unguarded write into a folder
      // nobody agreed to. Refusing the ref outright is a stronger check than restoring it.
      requireCatalogRef(ref);
      const target = filePath(ref);
      requireJsonName(target, ref);

      const check = await contained(target, ref);
      // A Catalog's folder not being there is what makes the target missing, so that check
      // is also the one that keeps a Catalog out of a folder nobody agreed to.
      if ("missing" in check) throw new NotAWorkspaceError();
      // and being there without being a folder is the other way it is not one (#121)
      await requireLayoutFolder(ref);
      // serialise first: a value that cannot be written must not reach the filesystem
      await writeAtomically(ref, check.path, JSON.stringify(data, null, 2) + "\n");
    },

    async readStateFile(ref: StateFileRef): Promise<StateFileContents | undefined> {
      const target = filePath(ref);
      requireJsonName(target, ref);

      const check = await contained(target, ref);
      if ("missing" in check) return undefined;

      const bytes = await bytesOrAbsent(check.path, ref);
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
     * **The window this does not close, and what #67 put in it.** Between the hash below and
     * the rename, another process can still write, and no POSIX rename can be made conditional
     * on the target's content. Closing it would need a lock file, which the design already has
     * for a second server on one Workspace and which cannot bind Dropbox or an editor anyway.
     * What this guard is for is a file changed seconds or minutes ago by a sync client, a
     * checkout or another tab, and for those the window is not where the risk is. Said out loud
     * rather than implied by a check that looks total.
     *
     * **The snapshot now sits inside that window** — a `stat`, a `readdir`, a write of the
     * previous file and a rename — so the window grew from a few instructions to one file
     * write. That is a change in degree inside a limitation the paragraph above already
     * concedes, and it buys the ordering that matters: the copy of what is being replaced is on
     * disk *before* anything overwrites it. Putting the snapshot before the guard instead would
     * narrow the window again at the cost of a snapshot on every refused save, and it would not
     * save the other writer's bytes either — the copy is of what *this* save read. The trade was
     * made deliberately and is written here rather than left for the next reader to find.
     *
     * **One thing a pre-image snapshot does not hold.** When another writer overwrites the
     * State File, the next save is refused here and never reaches the snapshot, so the newest
     * thing in `.backups/` is the document as it stood *before* the last save and not the
     * last-saved content itself. That is the scenario `docs/design.md`, "External edits" cares
     * most about, and the answer to it is the refusal: the other writer's bytes are still on
     * disk, unoverwritten, which is the thing worth protecting. Naming it so that nobody reads
     * `.backups/` as holding every revision of the file.
     */
    async saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<StateFileVersion> {
      const target = filePath(ref);
      requireJsonName(target, ref);

      const check = await contained(target, ref);
      if ("missing" in check) throw new NotAWorkspaceError();
      // A State File lives at the root, and a root exists whether or not the folder is a
      // Workspace, so for this one the Workspace Layout is asked about outright. Nothing is written
      // into a folder the student has not agreed to (docs/design.md, "Storage").
      if ((await missingFolders()).length > 0) throw new NotAWorkspaceError();

      // serialise first: a value that cannot be written must not reach the filesystem
      const json = JSON.stringify(save.json, null, 2) + "\n";

      // As late as it can be made short of reordering the snapshot before it, which the doc
      // above weighs: what is between this check and the rename is the snapshot, and nothing
      // else.
      const replacing = await onDisk(check.path, ref);
      if (replacing?.version !== save.basedOn) {
        throw new StateFileChangedError(ref.name, {
          basedOn: save.basedOn,
          found: replacing?.version,
        });
      }

      // The snapshot is of what is about to be replaced, and it is written **before** the
      // rename: a save that landed and then failed to copy what it overwrote would have
      // destroyed the very file `.backups/` exists to hold. A first save replaces nothing and
      // so copies nothing. One extra snapshot of content that is still current — which is what
      // a failed rename after a written snapshot leaves — is harmless and prunes away.
      //
      // A refusal out of the snapshot is said to be one (#229): nothing about the State File
      // was wrong, and a caller that could not tell this from an unreadable one told the
      // student their saved picks could not be read.
      if (replacing !== undefined) {
        await snapshot(ref.name, replacing.bytes).catch((error: unknown) => {
          throw error instanceof WorkspaceRefusedError ? new BackupRefusedError(error) : error;
        });
      }

      await writeAtomically(ref, check.path, json);
      // after the save, because pruning only ever deletes and may not cost a save
      await prune(ref.name);
      // the revision of what was just written: a read of it would hash these same bytes
      return revisionOf(new TextEncoder().encode(json));
    },

    /**
     * The snapshots of one State File, newest first.
     *
     * `[]` for a Workspace with no `.backups/` — `usablePath` answers for that, as it does for
     * `list` — and a refusal for a `.backups` that is there and cannot be listed, which is
     * `entriesOrAbsent`'s doing and the same third answer `list` has (#129). A `.backups` that
     * is a plain **file** is that refusal too, with `ENOTDIR` turned into the sentence, which
     * is the read side of what `snapshot` refuses on the way in.
     *
     * Ordered newest first here rather than by name, although the names sort the same way:
     * what a caller is given is a list of moments, so it is sorted on the moment.
     */
    async listBackups(ref: StateFileRef): Promise<BackupRef[]> {
      // the port's own refusal, before a path is built, exactly as `filePath` makes it
      requireStateFileName(ref.name);

      const folder = await usablePath(folderPath({ kind: "backup" }));
      if (folder === undefined) return [];

      const entries = await entriesOrAbsent(folder, folderSubject({ kind: "backup" }));
      if (entries === undefined) return [];

      return entries
        .flatMap((entry) => {
          const held = backupFromFileName(entry);
          return held !== undefined && held.name === ref.name ? [held] : [];
        })
        .sort((a, b) => b.takenAt - a.takenAt);
    },

    /**
     * What one snapshot holds, and `undefined` when it is not there — absence is not an error,
     * as for `read` and `readStateFile`, and a snapshot the student has already pruned away is
     * exactly the absence a stale listing produces.
     *
     * No revision, and the port's doc says why: nothing ever saves a snapshot, so there is no
     * later write for one to guard.
     */
    async readBackup(ref: BackupRef): Promise<unknown> {
      const target = filePath(ref);
      requireJsonName(target, ref);

      const check = await contained(target, ref);
      if ("missing" in check) return undefined;

      const bytes = await bytesOrAbsent(check.path, ref);
      return bytes === undefined ? undefined : contentOf(bytes);
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
     * started — the Workspace Layout being created, or a clone landing — gets a watcher of its own,
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
 * Which part of the Workspace Layout a reference lives in, or `undefined` for one that lives at the
 * Workspace root — which a State File does, because a Workspace holds one or more of them
 * and the design puts them there (docs/design.md, "Storage").
 */
function folderFor(ref: {
  kind: WorkspaceRef["kind"] | "backup";
}): WorkspaceFolder | undefined {
  switch (ref.kind) {
    case "catalog":
      return "catalogs";
    case "backup":
      return "backups";
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
 *
 * **The path is what is checked and `about` is what the refusal is about** (#216, #249). This
 * was the one refusal in the module naming an *absolute* path, which is the largest a leak out of
 * here could be; every caller already has the ref, so it hands that along with the path as the
 * subject. Nothing reachable today gets this far, so what the change protects is the future
 * caller the guard exists for — which is exactly the caller that would also be the first to put
 * a path in a log line.
 */
function requireJsonName(path: string, about: WorkspaceRefusalSubject): void {
  if (!path.endsWith(".json")) {
    throw new WorkspaceRefusedError(
      { reason: "not-json", subject: about },
      `refusing ${describe(about)}: only .json files are read or written`,
    );
  }
}
