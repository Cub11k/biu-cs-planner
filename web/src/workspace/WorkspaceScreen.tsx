import { useEffect, useLayoutEffect, useState } from "react";
import { api } from "../api.ts";
import { unauthorizedSaid, type ScreenDefinition, type ScreenProps } from "../AppShell.tsx";
import { useEditing } from "../editing.ts";
import { t, type Language, type StringKey } from "../i18n/strings.ts";
import {
  createWorkspace,
  fetchBackups,
  fetchWorkspaceStatus,
  restoreBackup,
  type BackupsResult,
  type CreateResult,
  type RestoreRefusal,
  type StateFileRefusal,
  type StatusResult,
} from "./workspace.ts";

/**
 * The Workspace screen (#238, `docs/design.md` "Screens", item 5), in its first cut: whether the
 * folder is a Workspace, creating its Workspace Layout when it is not, and the State File's backups
 * with a Restore on each. Import, the State File picker and settings come later.
 *
 * **Restore is here and not on the Timetable** because it is rare and consequential (the ruling on
 * #238). It is still an ordinary edit: one request, one guarded save based on the revision on
 * screen, and one undo step (ADR-0013), so it goes through `useEditing` as the Plan's edits do.
 *
 * It reaches the domain only through the typed client (`./workspace.ts`).
 */

type BackupsState = { kind: "loading" } | BackupsResult;

/** Why the State File's revision could not be had, said as what it costs here: no restore. */
const STATE_FILE_STRING = {
  "workspace-refused": "workspaceStateFileUnreadable",
} as const satisfies Record<NonNullable<StateFileRefusal>, StringKey>;

/**
 * Why a restore was not made, in words about a restore. Two are the shell's generic save sentences,
 * true of any save: `workspaceNotReady` and `saveUnconfirmed`.
 */
const RESTORE_REFUSAL_STRING = {
  "workspace-not-ready": "workspaceNotReady",
  "state-file-unreadable": "workspaceRestoreFileUnreadable",
  "state-file-changed": "workspaceRestoreStale",
  "workspace-refused": "workspaceRestoreRefused",
  "backup-refused": "workspaceRestoreBackupRefused",
  "save-revision-unreadable": "saveUnconfirmed",
  "backup-not-found": "workspaceRestoreNotFound",
  "backup-unreadable": "workspaceRestoreUnreadable",
} as const satisfies Record<NonNullable<RestoreRefusal>, StringKey>;

/** A sentence the screen owes the student, kept as its key so a language switch re-says it. */
type Said = { key: StringKey; takenAt?: number };

/** The moment a snapshot was taken, in the student's language; seconds, because two saves can share a minute. */
const whenSaid = (language: Language, takenAt: number): string =>
  new Date(takenAt).toLocaleString(language, { dateStyle: "medium", timeStyle: "medium" });

const say = (language: Language, said: Said): string =>
  t(language, said.key, said.takenAt === undefined ? undefined : { when: whenSaid(language, said.takenAt) });

/** A part of the Workspace Layout by the name it has on disk: the backups folder is hidden. */
const onDisk = (part: string): string => (part === "backups" ? ".backups" : part);

const readBackups = (): Promise<BackupsResult> => fetchBackups(api);

/** What a create answered, as the sentence it is owed. */
function createdSaid(answer: CreateResult, tokenHeld: boolean, language: Language): string {
  switch (answer.kind) {
    case "created":
      return t(language, "workspaceCreated");
    case "refused":
      return t(language, answer.reason === undefined ? "workspaceCreateNotDone" : "workspaceCreateRefused");
    case "unreadable-answer":
      return t(language, "workspaceAnswerUnreadable");
    case "unauthorized":
      return unauthorizedSaid(language, tokenHeld);
    case "unreachable":
      return t(language, "apiUnreachable");
  }
}

export function WorkspaceScreen({
  language,
  tokenHeld,
  workspaceChanges,
  stepRereads,
  steps,
  onEdited,
  onActed,
  onRevision,
  notices,
}: ScreenProps): React.JSX.Element {
  /** Re-reads this screen asks for itself: after a restore, a stale listing, or a create. */
  const [asked, setAsked] = useState(0);
  const editing = useEditing(readBackups, workspaceChanges + stepRereads + asked, onEdited);
  const backups: BackupsState = editing.answer;
  const sending = editing.sending || editing.spent;
  const changes = workspaceChanges + stepRereads + asked + editing.rereads;

  const [status, setStatus] = useState<StatusResult | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void fetchWorkspaceStatus(api).then((fresh) => {
      if (current) setStatus(fresh);
    });
    return () => {
      current = false;
    };
  }, [changes]);

  /** What the last restore did; retired by the next act or a step. */
  const [restored, setRestored] = useState<Said[]>([]);
  const [created, setCreated] = useState<CreateResult | undefined>(undefined);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (steps > 0) {
      setRestored([]);
      setCreated(undefined);
    }
  }, [steps]);

  // the revision a press of undo is based on, heard before the browser paints (`TimetablePane`)
  useLayoutEffect(() => {
    onRevision(
      backups.kind === "served" && backups.version !== undefined && !sending
        ? { version: backups.version, answer: backups }
        : undefined,
    );
  }, [backups, sending, onRevision]);

  const restore = (takenAt: number, shown: BackupsResult & { kind: "served" }): void => {
    const sent = editing.send(
      (basedOn) => restoreBackup(api, takenAt, basedOn, shown.snapshots),
      (answer) => {
        if (answer.kind === "served" && answer.restored !== undefined) {
          const { moved, warned, overUnreadable } = answer.restored;
          setRestored([
            {
              key: !moved
                ? "workspaceRestoreUnchanged"
                : overUnreadable
                  ? "workspaceRestoredOverUnreadable"
                  : "workspaceRestored",
              takenAt,
            },
            ...(warned ? [{ key: "workspaceRestoredPartly" as const }] : []),
          ]);
          // the restore took a snapshot of what it replaced, which the listing on screen lacks
          if (moved) setAsked((count) => count + 1);
          return;
        }
        if (answer.kind === "refused") {
          setRestored([
            {
              key:
                answer.reason === undefined
                  ? "workspaceRestoreNotDone"
                  : RESTORE_REFUSAL_STRING[answer.reason as NonNullable<RestoreRefusal>],
            },
          ]);
          if (answer.reason === "backup-not-found") setAsked((count) => count + 1);
          return;
        }
        if (answer.kind === "unreadable-answer") setRestored([{ key: "workspaceRestoreAnswerUnreadable" }]);
        else if (answer.kind === "unreachable") setRestored([{ key: "apiUnreachable" }]);
        else if (answer.kind === "unauthorized") setRestored([{ key: tokenHeld ? "tokenRetired" : "tokenMissing" }]);
      },
    );
    if (!sent) return;
    onActed();
    setRestored([]);
    setCreated(undefined);
  };

  const create = (): void => {
    onActed();
    setRestored([]);
    setCreated(undefined);
    setCreating(true);
    void createWorkspace(api).then((answer) => {
      setCreating(false);
      setCreated(answer);
      // a refused create may still have made some of the folders (#166), so either way look again,
      // and so does whatever else was told the folder is not a Workspace yet
      setAsked((count) => count + 1);
      onEdited();
    });
  };

  const said = backupsSaid(language, backups, tokenHeld);
  const served = backups.kind === "served" ? backups : undefined;
  const folder = status?.kind === "served" ? status.status : undefined;
  const notAFolder = folder?.notAFolder ?? [];

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      {/* every account of what just happened, the shell's and this screen's */}
      <p role="status" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft empty:hidden">
        {said === undefined ? null : <span>{said}</span>}
        {created === undefined ? null : <span data-workspace-created>{createdSaid(created, tokenHeld, language)}</span>}
        {restored.map((line) => (
          <span key={line.key} data-workspace-restored>
            {say(language, line)}
          </span>
        ))}
        {notices}
      </p>

      {folder === undefined || folder.ready ? null : (
        <section data-workspace-not-ready className="mb-4 rounded-sm border border-rule bg-hint p-3 text-sm text-ink">
          {folder.missing.length === 0 ? null : (
            <p>{t(language, "workspaceMissing", { folders: folder.missing.map(onDisk).join(t(language, "workspaceListSeparator")) })}</p>
          )}
          {notAFolder.length === 0 ? null : (
            <p>{t(language, "workspaceNotAFolder", { folders: notAFolder.map(onDisk).join(t(language, "workspaceListSeparator")) })}</p>
          )}
          <button
            type="button"
            data-workspace-create
            // a file standing in a folder's place makes every create refuse, until it is moved
            disabled={creating || sending || notAFolder.length > 0}
            onClick={create}
            className="mt-2 rounded-sm border border-rule bg-paper px-3 py-1 text-ink-soft disabled:opacity-50"
          >
            {t(language, "workspaceCreate")}
          </button>
        </section>
      )}

      <section aria-labelledby="workspace-backups" className="max-w-prose">
        <h2 id="workspace-backups" className="mb-1 text-base font-semibold text-ink">
          {t(language, "workspaceBackups")}
        </h2>
        <p className="mb-3 text-sm text-pencil">{t(language, "workspaceBackupsAbout")}</p>
        {served === undefined ? null : served.snapshots.length === 0 ? (
          <p className="text-sm text-pencil">{t(language, "workspaceBackupsNone")}</p>
        ) : (
          <ul data-workspace-backups className="divide-y divide-rule rounded-sm border border-rule bg-paper">
            {served.snapshots.map(({ takenAt }) => (
              <li key={takenAt} data-backup={takenAt} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <time dateTime={new Date(takenAt).toISOString()} className="text-ink">
                  {whenSaid(language, takenAt)}
                </time>
                <button
                  type="button"
                  data-restore
                  disabled={sending || creating}
                  aria-label={t(language, "workspaceRestoreLabel", { when: whenSaid(language, takenAt) })}
                  onClick={() => restore(takenAt, served)}
                  className="rounded-sm border border-rule bg-paper px-3 py-1 text-ink-soft disabled:opacity-50"
                >
                  {t(language, "workspaceRestore")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/** What the screen says about the read itself, and nothing once it is served. */
function backupsSaid(language: Language, backups: BackupsState, tokenHeld: boolean): string | undefined {
  switch (backups.kind) {
    case "loading":
      return t(language, "workspaceBackupsLoading");
    case "served":
      return undefined;
    case "refused":
      // never on screen: `useEditing` puts only a served edit's answer there, and `restore` says the rest
      if (backups.of === "restore") return undefined;
      if (backups.of === "backups") return t(language, "workspaceBackupsUnreadable");
      return t(language, backups.reason === undefined ? "workspaceStateFileUnreadable" : STATE_FILE_STRING[backups.reason]);
    case "unauthorized":
      return unauthorizedSaid(language, tokenHeld);
    case "unreadable-answer":
      return t(language, "workspaceBackupsAnswerUnreadable");
    case "unreachable":
      return t(language, "apiUnreachable");
  }
}

/** The Workspace screen's entry in the registry: last, at `/workspace`, as `docs/design.md` orders it. */
export const WORKSPACE_SCREEN: ScreenDefinition = {
  path: "/workspace",
  label: "workspace",
  render: (props) => <WorkspaceScreen {...props} />,
};
