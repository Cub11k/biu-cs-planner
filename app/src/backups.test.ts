import { expect, it } from "vitest";
import { parseStateFile, type State, type StateFileVersion } from "@biu-cs-planner/core";
import { listBackups, restoreBackup, RESTORE_LABEL } from "./backups.ts";
import { editStateFile, type StateEdit, type StateEditing } from "./edit.ts";
import { DEFAULT_STATE_FILE } from "./picks.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";
import { WorkspaceRefusedError, type BackupRef, type StateFileRef } from "./workspace.ts";

/**
 * The two use cases behind `.backups/` (#67). They run against the in-memory Workspace, which
 * is the port — the filesystem adapter is asserted to the same backup behaviour, under the
 * same test titles, in `server/src/workspace.fs.test.ts`.
 *
 * **Every save here goes through `editStateFile`** and nothing in this file reaches the port's
 * save directly, which is the point rather than a nicety: taking a snapshot is the guarded
 * save's own doing, so a test that wrote round it would be proving a backup the app does not
 * take (CLAUDE.md, "Code guardrails"; `tools/ci/state-file-writer.test.ts`).
 */

const ME: StateFileRef = { kind: "state", name: DEFAULT_STATE_FILE };

/** A clock a test drives, so a day apart costs no waiting. */
const clock = (start: number) => {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
};

const NOON = Date.UTC(2026, 9, 7, 12, 0, 0, 0);

/** A document edit, so a save moves something an undo would restore. */
const pinning = (courseNumber: string): StateEditing => ({
  label: `pin-${courseNumber}`,
  apply: (state: State) => ({
    ...state,
    pins: [...state.pins, { courseNumber, requirementId: "core" }],
  }),
});

/**
 * A Workspace with a State File that has been saved `through` times, so there are snapshots to
 * list and to restore. The revision of the file afterwards comes back with it, because every
 * save has to be based on one.
 */
const saved = async (
  workspace: MemoryWorkspace,
  courses: string[],
): Promise<StateFileVersion | undefined> => {
  let version: StateFileVersion | undefined;
  for (const course of courses) {
    const outcome = await editStateFile(workspace, DEFAULT_STATE_FILE, pinning(course), {
      basedOn: version,
    });
    if (outcome.kind !== "saved") throw new Error(`setup did not save: ${outcome.kind}`);
    version = outcome.version;
  }
  return version;
};

it("lists the snapshots of the State File, newest first", async () => {
  const time = clock(NOON);
  const workspace = memoryWorkspace({ created: true, now: time.now });

  expect(await listBackups(workspace)).toEqual({ kind: "served", snapshots: [] });

  let version = await saved(workspace, ["80001"]);
  // the first save replaced nothing, so it left nothing to copy
  expect(await listBackups(workspace)).toEqual({ kind: "served", snapshots: [] });

  time.advance(1000);
  const first = time.now();
  version = await editStateFile(workspace, DEFAULT_STATE_FILE, pinning("80002"), {
    basedOn: version,
  }).then((outcome) => (outcome.kind === "saved" ? outcome.version : undefined));
  time.advance(1000);
  const second = time.now();
  await editStateFile(workspace, DEFAULT_STATE_FILE, pinning("80003"), { basedOn: version });

  expect(await listBackups(workspace)).toEqual({
    kind: "served",
    snapshots: [{ takenAt: second }, { takenAt: first }],
  });
});

it("answers a refusal rather than an empty list when the folder cannot be looked into", async () => {
  // the one answer the double cannot give, so it is injected — exactly as `edit.test.ts`
  // injects an unreadable State File
  const workspace: MemoryWorkspace = {
    ...memoryWorkspace({ created: true }),
    listBackups: () =>
      Promise.reject(
        new WorkspaceRefusedError(
          { reason: "unreadable", subject: { kind: "folder", folder: "backups" } },
          "refusing: it cannot be listed",
        ),
      ),
  };

  expect(await listBackups(workspace)).toEqual({ kind: "refused", reason: "workspace-refused" });
});

it("restores a snapshot, and the file holds what the snapshot held", async () => {
  const time = clock(NOON);
  const workspace = memoryWorkspace({ created: true, now: time.now });

  let version = await saved(workspace, ["80001"]);
  time.advance(1000);
  const takenAt = time.now();
  const second = await editStateFile(workspace, DEFAULT_STATE_FILE, pinning("80002"), {
    basedOn: version,
  });
  version = second.kind === "saved" ? second.version : undefined;

  const restored = await restoreBackup(workspace, { takenAt, basedOn: version });

  expect(restored.kind).toBe("restored");
  const held = await workspace.readStateFile(ME);
  // the one Pin of the snapshot, and not the two the file had grown
  expect(parseStateFile(held?.data).state?.pins).toEqual([
    { courseNumber: "80001", requirementId: "core" },
  ]);
  // the revision the restore wrote is what a next save is based on
  expect(restored.kind === "restored" && restored.version).toBe(held?.version);
});

/**
 * The property #67 asks for by name: "Restoring is itself an edit, so it should produce a
 * backup of what it replaced. A student who restores the wrong snapshot must be able to get
 * back." It is not arranged here — it falls out of the restore being an ordinary save, which
 * is the whole argument for routing it through `editStateFile`.
 */
it("backs up what it replaced, so the wrong snapshot can be got back from", async () => {
  const time = clock(NOON);
  const workspace = memoryWorkspace({ created: true, now: time.now });

  let version = await saved(workspace, ["80001"]);
  time.advance(1000);
  const old = time.now();
  const second = await editStateFile(workspace, DEFAULT_STATE_FILE, pinning("80002"), {
    basedOn: version,
  });
  version = second.kind === "saved" ? second.version : undefined;

  time.advance(1000);
  const beforeRestore = time.now();
  const restored = await restoreBackup(workspace, { takenAt: old, basedOn: version });
  expect(restored.kind).toBe("restored");

  // the restore took its own snapshot, of the two-Pin document it replaced
  const snapshots = await listBackups(workspace);
  expect(snapshots.kind === "served" && snapshots.snapshots).toEqual([
    { takenAt: beforeRestore },
    { takenAt: old },
  ]);

  // and restoring *that* puts the student back where they were before they reached for a
  // backup at all
  const back = await restoreBackup(workspace, {
    takenAt: beforeRestore,
    basedOn: restored.kind === "restored" ? restored.version : undefined,
  });
  expect(back.kind).toBe("restored");
  const held = await workspace.readStateFile(ME);
  expect(parseStateFile(held?.data).state?.pins).toEqual([
    { courseNumber: "80001", requirementId: "core" },
    { courseNumber: "80002", requirementId: "core" },
  ]);
});

it("is an undoable edit, under a label of its own", async () => {
  const time = clock(NOON);
  const workspace = memoryWorkspace({ created: true, now: time.now });
  const pushed: StateEdit[] = [];
  const history = { push: (edit: StateEdit) => void pushed.push(edit), wrote: () => undefined };

  let version = await saved(workspace, ["80001"]);
  time.advance(1000);
  const takenAt = time.now();
  const second = await editStateFile(workspace, DEFAULT_STATE_FILE, pinning("80002"), {
    basedOn: version,
  });
  version = second.kind === "saved" ? second.version : undefined;

  const restored = await restoreBackup(workspace, { takenAt, basedOn: version, history });

  expect(restored.kind === "restored" && restored.label).toBe(RESTORE_LABEL);
  // one entry, holding the document the restore replaced — which is what makes an undo of a
  // restore an ordinary undo (ADR-0013)
  expect(pushed).toHaveLength(1);
  expect(pushed[0]?.label).toBe(RESTORE_LABEL);
  expect(pushed[0]?.previous.pins).toEqual([
    { courseNumber: "80001", requirementId: "core" },
    { courseNumber: "80002", requirementId: "core" },
  ]);
});

/**
 * ADR-0013 keeps `settings` off a snapshot, so a restore cannot put a preference back: undoing
 * a Pick may not flip the UI language, and a restore is an undo of many edits at once. The
 * *file* in `.backups/` does hold the settings of its moment, and this deliberately leaves them
 * there.
 */
it("leaves the current settings alone, however old the snapshot is", async () => {
  const time = clock(NOON);
  const workspace = memoryWorkspace({ created: true, now: time.now });

  let version = await saved(workspace, ["80001"]);
  time.advance(1000);
  const takenAt = time.now();
  const changed = await editStateFile(
    workspace,
    DEFAULT_STATE_FILE,
    {
      label: "set-settings",
      apply: (state: State) => ({ ...state, settings: { ...state.settings, language: "he" } }),
    },
    { basedOn: version },
  );
  version = changed.kind === "saved" ? changed.version : undefined;

  await restoreBackup(workspace, { takenAt, basedOn: version });

  const held = await workspace.readStateFile(ME);
  expect(parseStateFile(held?.data).state?.settings.language).toBe("he");
});

/**
 * Restoring the snapshot the file already holds is a save like any other, and says so.
 *
 * It is not `unchanged`: `restoring` builds a fresh document each time and `editStateFile` asks
 * the question by reference, so the wrapper sees an edit that moved something. The request was
 * honoured either way; what it costs is one redundant snapshot, which prunes away. `./backups.ts`
 * carries the ruling, and the arm for `unchanged` is unreachable because of it.
 */
it("writes, and snapshots, even a restore of what the file already holds", async () => {
  const time = clock(NOON);
  const workspace = memoryWorkspace({ created: true, now: time.now });

  let version = await saved(workspace, ["80001"]);
  time.advance(1000);
  const takenAt = time.now();
  // a settings edit, so the document outside `settings` is untouched and the snapshot of it
  // is identical to what the file holds now
  const changed = await editStateFile(
    workspace,
    DEFAULT_STATE_FILE,
    {
      label: "set-settings",
      apply: (state: State) => ({ ...state, settings: { ...state.settings, language: "he" } }),
    },
    { basedOn: version },
  );
  version = changed.kind === "saved" ? changed.version : undefined;

  const before = (await listBackups(workspace)) as { kind: "served"; snapshots: unknown[] };
  // the clock has to move, or the extra snapshot lands a nudged millisecond later and the
  // listing below would be about the nudge rather than about the save
  time.advance(1000);
  const outcome = await restoreBackup(workspace, { takenAt, basedOn: version });

  expect(outcome.kind).toBe("restored");
  // the document is what the snapshot held, which is what it already held
  const held = await workspace.readStateFile(ME);
  expect(parseStateFile(held?.data).state?.pins).toEqual([
    { courseNumber: "80001", requirementId: "core" },
  ]);
  // and it took a snapshot of its own, as every save does
  const after = (await listBackups(workspace)) as { kind: "served"; snapshots: unknown[] };
  expect(after.snapshots).toHaveLength(before.snapshots.length + 1);
});

it("refuses a snapshot that is not there, rather than writing an empty State File", async () => {
  const workspace = memoryWorkspace({ created: true, now: () => NOON });
  const version = await saved(workspace, ["80001"]);

  const outcome = await restoreBackup(workspace, { takenAt: NOON - 99_000, basedOn: version });

  expect(outcome).toEqual({ kind: "refused", reason: "backup-not-found", warnings: [] });
  // the file is exactly as it was
  expect((await workspace.readStateFile(ME))?.version).toBe(version);
});

it("refuses a restore into a folder that is not a Workspace", async () => {
  const workspace = memoryWorkspace({ created: true, now: () => NOON });
  const version = await saved(workspace, ["80001", "80002"]);
  // the same Workspace, with the Workspace Layout taken away from under it
  const notReady: MemoryWorkspace = {
    ...workspace,
    status: () => Promise.resolve({ ready: false, missing: ["backups"] }),
  };

  const outcome = await restoreBackup(notReady, { takenAt: NOON, basedOn: version });

  expect(outcome.kind === "refused" && outcome.reason).toBe("workspace-not-ready");
});

it("refuses a restore the file has moved under, rather than overwriting the other writer", async () => {
  const workspace = memoryWorkspace({ created: true, now: () => NOON });
  await saved(workspace, ["80001", "80002"]);

  // somebody else wrote the file: Dropbox, git, an editor, another tab
  workspace.seed(ME, { schemaVersion: 1, pins: [] });

  const outcome = await restoreBackup(workspace, { takenAt: NOON, basedOn: "a stale revision" });

  expect(outcome.kind === "refused" && outcome.reason).toBe("state-file-changed");
});

/**
 * **A snapshot is read through the same reader a State File is** — `parseStateFile`, with the
 * same migration table behind it (`core/src/state/file.ts`). That is the criterion #67 states
 * as "a snapshot written under an older schema version still opens, via the same migration
 * path as a State File", and it is asserted as the equivalence it is: the Warnings a restore
 * reports for a given snapshot are exactly the Warnings `parseStateFile` reports for it.
 *
 * There is no *older* version to migrate from — `CURRENT_STATE_SCHEMA_VERSION` is 1 and
 * `STATE_MIGRATIONS` is empty, because there has only ever been one version (#16) — so what
 * these pin is the path rather than a walk along it. A snapshot that leaves out every defaulted
 * field, which is what a file written by a build that did not have them looks like, opens and
 * restores; a snapshot at a version nothing reads is refused with the same Warning a State File
 * at that version gets, so the day there is a version 2 the migration is already in the path.
 */
it("reads a snapshot through the same reader, and the same migration path, as a State File", async () => {
  const workspace = memoryWorkspace({ created: true, now: () => NOON });
  const version = await saved(workspace, ["80001", "80002"]);
  const snapshot: BackupRef = { kind: "backup", name: DEFAULT_STATE_FILE, takenAt: NOON };

  // a snapshot as a build without the defaulted fields would have written it: a version and
  // nothing else
  const bare = { schemaVersion: 1 };
  const bareWorkspace: MemoryWorkspace = { ...workspace, readBackup: () => Promise.resolve(bare) };

  const restored = await restoreBackup(bareWorkspace, { takenAt: NOON, basedOn: version });
  expect(restored.kind).toBe("restored");
  expect(await bareWorkspace.readBackup(snapshot)).toEqual(bare);
  const held = await workspace.readStateFile(ME);
  expect(parseStateFile(held?.data).state?.pins).toEqual([]);

  // and a snapshot at a version nothing reads is refused in the reader's own words, which is
  // what makes the path the same path
  const unsupported = { schemaVersion: 0, pins: [] };
  const old: MemoryWorkspace = {
    ...workspace,
    readBackup: () => Promise.resolve(unsupported),
  };
  const refused = await restoreBackup(old, {
    takenAt: NOON,
    basedOn: restored.kind === "restored" ? restored.version : undefined,
  });

  expect(refused.kind === "refused" && refused.reason).toBe("backup-unreadable");
  expect(refused.warnings).toEqual(parseStateFile(unsupported).warnings);
  expect(refused.warnings).toEqual([{ kind: "schema-version-unsupported", found: 0 }]);
});

/**
 * The reader is forgiving in the same way it is for a State File, and deliberately: a student
 * reaching for a backup has already lost something, so a snapshot with one unreadable entry
 * restores the rest and says what it dropped. Only a snapshot that is not a State File at all
 * is refused.
 */
it("restores what it can of a damaged snapshot, and says what it dropped", async () => {
  const workspace = memoryWorkspace({ created: true, now: () => NOON });
  const version = await saved(workspace, ["80001", "80002"]);
  const damaged = {
    schemaVersion: 1,
    pins: [{ courseNumber: "80001", requirementId: "core" }, "not a Pin"],
  };
  const withDamage: MemoryWorkspace = {
    ...workspace,
    readBackup: () => Promise.resolve(damaged),
  };

  const outcome = await restoreBackup(withDamage, { takenAt: NOON, basedOn: version });

  expect(outcome.kind).toBe("restored");
  expect(outcome.warnings).toEqual(parseStateFile(damaged).warnings);
  expect(outcome.warnings).toEqual([{ kind: "entry-dropped", at: "pins[1]" }]);
  const held = await workspace.readStateFile(ME);
  expect(parseStateFile(held?.data).state?.pins).toEqual([
    { courseNumber: "80001", requirementId: "core" },
  ]);
});

it("refuses a snapshot that is not a State File at all", async () => {
  const workspace = memoryWorkspace({ created: true, now: () => NOON });
  const version = await saved(workspace, ["80001", "80002"]);
  const rubbish: MemoryWorkspace = {
    ...workspace,
    readBackup: () => Promise.resolve("not JSON this build can read"),
  };

  const outcome = await restoreBackup(rubbish, { takenAt: NOON, basedOn: version });

  expect(outcome.kind === "refused" && outcome.reason).toBe("backup-unreadable");
  expect(outcome.warnings).toEqual([{ kind: "file-unreadable" }]);
  // and nothing was written over the file this build could not read a backup of
  expect((await workspace.readStateFile(ME))?.version).toBe(version);
});

it("names a State File, never a path, and defaults to the one the app works in", async () => {
  const workspace = memoryWorkspace({ created: true, now: () => NOON });

  // the port refuses a name that is a path, and the use case words it the way every other
  // refusal out of this port is worded rather than letting it out as an exception
  expect(await listBackups(workspace, { stateFile: "../alice" })).toEqual({
    kind: "refused",
    reason: "workspace-refused",
  });
  expect(
    await restoreBackup(workspace, { takenAt: NOON, basedOn: undefined, stateFile: "../alice" }),
  ).toEqual({ kind: "refused", reason: "workspace-refused", warnings: [] });
  // the default is the name every other use case defaults to, so the snapshots a student is
  // shown are of the file they are editing
  expect(DEFAULT_STATE_FILE).toBe("me");
  await saved(workspace, ["80001", "80002"]);
  const listed = await workspace.listBackups(ME);
  expect(listed.map((held) => held.name)).toEqual(["me"]);
  expect(await listBackups(workspace)).toEqual({
    kind: "served",
    snapshots: [{ takenAt: NOON }],
  });
});
