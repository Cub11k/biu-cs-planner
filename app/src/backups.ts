import { parseStateFile, type StateFileVersion, type StateFileWarning } from "@biu-cs-planner/core";
import {
  editStateFile,
  restoring,
  snapshotOf,
  type EditHistory,
  type EditRefusal,
} from "./edit.ts";
import { DEFAULT_STATE_FILE } from "./picks.ts";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

/**
 * The two use cases behind `.backups/`: list the snapshots of a State File, and put one back
 * (#67; `docs/design.md`, "Storage" — "rotating snapshots in `.backups/` … restorable from the
 * Workspace screen").
 *
 * **Writing them is not here.** A snapshot is taken by the guarded save itself, beneath the
 * Workspace port, out of the bytes that save is about to replace; and the pruning to "last 20
 * saves plus one per day for 30 days" happens there too, against the one retention rule both
 * adapters share (`backupsToPrune` in `./workspace.ts`). So there is no backup-shaped write
 * path in `app` at all, which is what keeps `editStateFile` the only writer (CLAUDE.md,
 * `tools/ci/state-file-writer.test.ts`) while still giving every save a backup.
 *
 * **Restoring is an ordinary edit**, and that is the whole of its implementation: it reads the
 * snapshot, puts it through the same reader a State File goes through, and hands the result to
 * `editStateFile` as the pure `state -> state` function ADR-0013 describes. Three things fall
 * out of that rather than being arranged:
 *
 *   - **It backs up what it replaced**, because every save does. A student who restored the
 *     wrong snapshot has a snapshot of what they were looking at a moment ago.
 *   - **It is undoable**, because the wrapper puts the previous document on the undo stack
 *     under the label below, exactly as a Pick is.
 *   - **It is guarded**, because the wrapper carries the revision the restore was based on, so
 *     a restore over somebody else's edit is refused rather than silently winning.
 *
 * **The current `settings` survive a restore**, which `restoring` is what decides: ADR-0013
 * keeps `settings` off a snapshot's type, so a restore of a Plan cannot flip the UI language
 * back to whatever it was that day. Said out loud because a *file* in `.backups/` does hold the
 * settings of its moment and this deliberately does not put them back — the rule is the undo
 * rule, and a restore is an undo of many edits at once.
 */

/** One snapshot, as a student is shown it. */
export type BackupSnapshot = {
  /**
   * When it was taken, in milliseconds. The only thing that tells two snapshots of one State
   * File apart, and what a restore names — never a path, and never a revision (ADR-0002).
   */
  takenAt: number;
};

export type BackupsResult =
  | { kind: "served"; snapshots: BackupSnapshot[] }
  /**
   * `.backups/` is there and cannot be listed — a mode bit, or a plain file standing where the
   * folder belongs.
   *
   * **Not "the folder is not a Workspace yet."** This use case deliberately asks nothing about
   * the Workspace Layout, unlike `restoreBackup` below: a folder nobody has accepted holds no
   * snapshots, which is the empty answer. Both adapters agree — the filesystem one answers `[]`
   * for an absent `.backups/` and the double makes no Layout check at all — and a test pins it
   * from the API's side. Said here because an earlier version of this comment claimed the
   * other thing, which was a doc describing a branch the code cannot take (found in review).
   */
  | { kind: "refused"; reason: "workspace-refused" };

/**
 * The snapshots of one State File, newest first.
 *
 * No Warnings, because nothing is parsed: a listing reads names and not contents, so a
 * snapshot that will turn out to be unreadable is still listed. That is the honest answer —
 * the file is there — and finding out costs reading every snapshot in the folder.
 */
export async function listBackups(
  workspace: Workspace,
  options: { stateFile?: string } = {},
): Promise<BackupsResult> {
  const name = options.stateFile ?? DEFAULT_STATE_FILE;
  try {
    const snapshots = await workspace.listBackups({ kind: "state", name });
    return { kind: "served", snapshots: snapshots.map(({ takenAt }) => ({ takenAt })) };
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      return { kind: "refused", reason: "workspace-refused" };
    }
    throw error;
  }
}

/** Why a restore did not happen. Each is about the folder or a file, never about a choice. */
export type RestoreRefusal =
  | EditRefusal
  /** No snapshot was taken at that moment: a stale listing, or one pruned since it was read. */
  | "backup-not-found"
  /**
   * The snapshot is there and this build cannot read it as a State File. Its Warnings travel
   * with the refusal, as a stored Catalog's do, because the reason alone leaves the student
   * nothing to act on.
   */
  | "backup-unreadable";

export type RestoreResult =
  /** `version` is the revision the restore wrote: what the caller's next save is based on. */
  | {
      kind: "restored";
      takenAt: number;
      version: StateFileVersion;
      /** What an undo of the restore would be called, and when it happened. */
      label: string;
      at: number;
      warnings: StateFileWarning[];
    }
  /**
   * The edit moved nothing, so nothing was written and there is nothing to undo. Still carries
   * the revision the file holds, because the caller's next save has to be based on something.
   *
   * **No restore reaches this today, and no test enters it** — measured, not reasoned.
   * `restoring` builds `{ ...snapshot, settings: current.settings }`, which is a fresh document
   * every time, and `editStateFile` asks the question by reference: an edit is unchanged only
   * when it hands back the State it was given. So restoring the snapshot the file already holds
   * writes it again and takes its own snapshot of it, which is the honest answer — the request
   * was honoured — and costs one redundant copy that prunes away. The arm is kept because the
   * wrapper's outcome has three kinds and folding one of them into another here would mean
   * reporting a save that did not happen, or inventing a reason it was refused. `undo` and
   * `redo` in `server/src/history.ts` stand on exactly the same ground, for the same reason.
   */
  | {
      kind: "unchanged";
      takenAt: number;
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    }
  | { kind: "refused"; reason: RestoreRefusal; warnings: StateFileWarning[] };

/** What an undo of a restore is called. ADR-0013 has the use case supply the label. */
export const RESTORE_LABEL = "restore-backup";

/**
 * Puts one snapshot back.
 *
 * The snapshot is read through `parseStateFile` — **the same reader a State File goes
 * through**, with the same migration table behind it (`core/src/state/file.ts`). That is the
 * point rather than a convenience: a snapshot written by an older build has to open, because
 * opening an old file is what a backup is *for*, and a second reader here would be a second
 * place for the migration to be forgotten.
 *
 * And it is forgiving in the same way, deliberately: a snapshot with one unreadable Pick
 * restores the rest and says so in the Warnings, because a student reaching for a backup has
 * already lost something and salvaging what is there beats refusing the lot. Only a snapshot
 * that is not a State File at all comes back as `backup-unreadable`.
 */
export async function restoreBackup(
  workspace: Workspace,
  options: {
    takenAt: number;
    /** The revision the student's view was read from, as every save carries one (#90). */
    basedOn: StateFileVersion | undefined;
    history?: EditHistory;
    stateFile?: string;
  },
): Promise<RestoreResult> {
  const name = options.stateFile ?? DEFAULT_STATE_FILE;
  const { takenAt } = options;

  // Asked before the snapshot is looked for, and in the order every other write asks it:
  // `editStateFile` would refuse this anyway, but by then the answer would be
  // `backup-not-found` — true, since a folder with no `.backups/` holds no snapshot, and the
  // wrong news. A student whose folder is not a Workspace yet has to accept the Workspace
  // Layout, not go looking for a backup that was never taken.
  if (!(await workspace.status()).ready) {
    return { kind: "refused", reason: "workspace-not-ready", warnings: [] };
  }

  let held: unknown;
  try {
    held = await workspace.readBackup({ kind: "backup", name, takenAt });
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      return { kind: "refused", reason: "workspace-refused", warnings: [] };
    }
    throw error;
  }
  if (held === undefined) return { kind: "refused", reason: "backup-not-found", warnings: [] };

  // A snapshot is a file, and a file is untrusted input whoever wrote it — this app included,
  // since the build that wrote it may be older than the one reading it.
  const parsed = parseStateFile(held);
  if (!parsed.state) {
    return { kind: "refused", reason: "backup-unreadable", warnings: parsed.warnings };
  }

  const outcome = await editStateFile(
    workspace,
    name,
    restoring(RESTORE_LABEL, snapshotOf(parsed.state)),
    { basedOn: options.basedOn, ...(options.history ? { history: options.history } : {}) },
  );

  // The snapshot's own Warnings first, then the State File's: both are about files the student
  // may have to go and look at, and which file is which is the news.
  const warnings = [...parsed.warnings, ...outcome.warnings];

  switch (outcome.kind) {
    case "saved":
      return {
        kind: "restored",
        takenAt,
        version: outcome.version,
        label: outcome.edit.label,
        at: outcome.edit.at,
        warnings,
      };
    case "unchanged":
      return { kind: "unchanged", takenAt, version: outcome.version, warnings };
    case "refused":
      return { kind: "refused", reason: outcome.reason, warnings };
  }
}
