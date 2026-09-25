import {
  CURRENT_STATE_SCHEMA_VERSION,
  parseStateFile,
  stateSchema,
  writeStateFile,
  type State,
  type StateFileVersion,
  type StateFileWarning,
} from "@biu-cs-planner/core";
import { StateFileChangedError, WorkspaceRefusedError, type Workspace } from "./workspace.ts";

/**
 * Editing a State File: read it, apply a pure `state -> state` function from `core`, save
 * the result, and keep what an undo would need.
 *
 * This is the wrapper [ADR-0013](../../docs/adr/0013-undo-is-snapshots-not-commands.md)
 * describes, and the only place in the app that writes a State File. An edit is a plain
 * function, `app` keeps the previous value on a stack with the label the use case supplied,
 * and undo writes an earlier value back through this same save. There is no command
 * concept and nothing implements an inverse, so every editing use case is this function
 * plus a `core` function and a label.
 */

/**
 * The part of a State File an undo restores: the whole document **except** `settings`.
 *
 * ADR-0013: "One stack covers the document, minus settings. Language and exam spacing are
 * preferences that the control which set them can set back, and folding them in would let
 * undoing a Pick flip the UI language." That exclusion is spelled as a type rather than as a
 * habit, so a snapshot cannot carry a preference for a later restore to put back: an entry
 * that does not hold `settings` cannot overwrite them, whoever writes the next use case.
 *
 * The fields come from `stateSchema` rather than being listed here, so a field added to a
 * State File is on the stack from the day it exists. Forgetting to add one would be silent —
 * the edit would save and the undo would leave that field where the edit put it.
 */
export type StateSnapshot = Omit<State, "settings">;

/** Everything a snapshot holds, which is every part of the document but `settings`. */
const SNAPSHOT_KEYS = Object.keys(stateSchema.shape).filter(
  (key) => key !== "settings",
) as (keyof StateSnapshot)[];

/** The document as it stands, minus the preferences an undo must not move. */
export function snapshotOf(state: State): StateSnapshot {
  const snapshot: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) snapshot[key] = state[key];
  return snapshot as StateSnapshot;
}

/**
 * Did this edit move anything an undo would restore?
 *
 * Reference equality per field, which is exactly the question and not an approximation of
 * it: a pure edit returns `{ ...state, settings: next }` when it sets a preference, so every
 * other field of the result *is* the field it was handed. An edit that rebuilt a field
 * identically would be counted as having moved it — the conservative direction, costing one
 * undo entry rather than losing one.
 */
const movedOutsideSettings = (previous: State, next: State): boolean =>
  SNAPSHOT_KEYS.some((key) => next[key] !== previous[key]);

/**
 * One entry on the undo stack (#73): the State File as it stood before one edit, the label
 * the use case gave that edit, and when it happened.
 *
 * `at` is a wall-clock reading, for a UI that wants to say how long ago — never a version
 * and never compared against a file. What identifies a revision is `StateFileVersion`, which
 * the Workspace adapter produces from the bytes.
 *
 * The bounds ADR-0013 sets — the last 100 edits, dropped sooner past 8 MB, in memory and
 * gone on restart — belong to the stack rather than to this: this is one entry, and
 * `server/src/history.ts` is what holds them and how many.
 */
export type StateEdit = { label: string; at: number; previous: StateSnapshot };

/**
 * Where the entries go. A port, so `server/src/history.ts` decides what holds them and how
 * many, and so a test can collect them.
 */
export type EditHistory = {
  /** An edit worth undoing. Called once per save, after the write and never before it. */
  push(edit: StateEdit): void;
  /**
   * The revision the file holds now, after any save — **including one with nothing to
   * undo**. A stack that only heard about undoable edits would still believe the revision
   * before a `settings` save, and would then read the file, see a revision it did not
   * write, and throw the student's undo history away as though Dropbox had been in
   * (`server/src/history.ts`, "invalidation").
   *
   * Optional because a caller that only wants the entries — a test collecting labels — has
   * no revision to keep. The stacks are not optional about implementing it.
   */
  wrote?(version: StateFileVersion): void;
};

/**
 * An edit that puts an earlier snapshot back: undo and redo, both of which are an ordinary
 * edit through `editStateFile` and not a path of their own (ADR-0013, "the save path is the
 * undo path").
 *
 * The current `settings` survive it. They are not on the stack to be restored, and reading
 * them off the document being replaced is what keeps an undo of a Pick from flipping the UI
 * language back.
 */
export const restoring = (label: string, snapshot: StateSnapshot): StateEditing => ({
  label,
  apply: (current) => ({ ...snapshot, settings: current.settings }),
});

/** What one edit does, and what an undo of it would be called. */
export type StateEditing = {
  /** The use case's own word for this edit; ADR-0013 has the entry carry it. */
  label: string;
  apply(state: State): State;
};

export type EditOptions = {
  /**
   * Which revision of the State File this edit was based on — the one the student's view was
   * read from, carried here from wherever that view lives (`docs/design.md`, "External
   * edits"). `undefined` claims there was no file, and is guarded as such rather than being
   * a way past the guard.
   *
   * Required, and with no default, because a default is how this hole was open in the first
   * place: #63 gave `writeStateFile` the parameter, nothing could produce a version, and
   * `undefined` went in everywhere while the signature made it look handled. A caller that
   * cannot say what it was based on has not read the file, and cannot safely write it.
   */
  basedOn: StateFileVersion | undefined;
  history?: EditHistory;
};

/**
 * Why an edit did not happen. Never a domain check on what the student chose: each is
 * about the folder or the file, and each is something they can act on.
 */
export type EditRefusal =
  /** The folder is not a Workspace yet, and nothing is made into one behind their back. */
  | "workspace-not-ready"
  | "state-file-unreadable"
  /**
   * The file is not the revision this edit was based on: another tab, Dropbox, git or an
   * editor wrote it in between, and overwriting it would destroy that writer's work. Not a
   * Warning, as none of the refusals in this union is: a Warning travels back with an edit
   * that went through, and this edit must not go through — by the time it had, the other
   * writer's work would be gone. `StateFileChangedError` in `./workspace.ts` says why it is
   * the one refusal that exists for that reason.
   */
  | "state-file-changed"
  | "workspace-refused";

export type EditOutcome =
  /** `version` is the revision this save wrote: what the caller's next save is based on. */
  | {
      kind: "saved";
      state: State;
      version: StateFileVersion;
      /**
       * What an undo of this save would restore, and what it would be called. Produced for
       * every save, including a `settings` one the stack does not take — the caller asked for
       * one edit and is told what it did, and what the history keeps is the history's rule.
       */
      edit: StateEdit;
      warnings: StateFileWarning[];
    }
  /**
   * The edit changed nothing, so nothing was written and there is nothing to undo. It still
   * carries the revision the file holds — `undefined` when there is no file — because the
   * caller's next save has to be based on something.
   */
  | {
      kind: "unchanged";
      state: State;
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

/**
 * A State File that is not there yet. Parsed rather than written out as a literal, so the
 * empty file this produces is exactly the one `parseStateFile` produces from `{}` — one
 * place decides what a new student's data starts as, and it is the schema.
 */
const newState = (): State => stateSchema.parse({ schemaVersion: CURRENT_STATE_SCHEMA_VERSION });

/** What reading the current State File can come back as. */
export type StateFileLoad =
  /**
   * `version` is the revision read, and `undefined` when there was no file: a new State
   * File is based on no revision, which is what a first save has to carry.
   */
  | { state: State; version: StateFileVersion | undefined; warnings: StateFileWarning[] }
  | { refused: EditRefusal; warnings: StateFileWarning[] };

/**
 * Reading is not guarded on the layout and writing is: a folder that is not a Workspace
 * holds no State File, which is an empty week rather than a failure, and a student who has
 * not accepted the layout yet should still see the screen. Writing into one is refused, as
 * `importCrawl` refuses it — nothing is written until they accept (docs/design.md,
 * "Storage").
 */

/**
 * Reads the State File, or hands back a new one when there is none.
 *
 * A file this build cannot read at all is **not** overwritten: it may be hand-edited, and
 * saving over it would cost the student everything in it, silently. That is the rule
 * `importCrawl` already follows for a stored Catalog (docs/design.md, "Storage").
 *
 * Two ways a file is unreadable, and both end here rather than in a new empty State. Bytes
 * that arrive and are not a State File the schema accepts are `state-file-unreadable`. A file
 * whose bytes cannot be *got at* — a mode bit, a directory in its place, failing hardware — is
 * the port's own refusal and comes back as `workspace-refused`; it used to arrive as
 * `undefined`, indistinguishable from no file at all, and this function then built a new empty
 * State and saved over it (#109).
 */
export async function readStateFile(
  workspace: Workspace,
  name: string,
): Promise<StateFileLoad> {
  let stored: { data: unknown; version: StateFileVersion } | undefined;
  try {
    stored = await workspace.readStateFile({ kind: "state", name });
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      return { refused: "workspace-refused", warnings: [] };
    }
    throw error;
  }
  if (stored === undefined) return { state: newState(), version: undefined, warnings: [] };

  // a file is untrusted input whoever wrote it, so every read goes through the schema
  const parsed = parseStateFile(stored.data);
  if (!parsed.state) return { refused: "state-file-unreadable", warnings: parsed.warnings };

  return { state: parsed.state, version: stored.version, warnings: parsed.warnings };
}

/**
 * Applies one edit and saves.
 *
 * **Guarded on the revision the caller was looking at** (`docs/design.md`, "External
 * edits"). Two checks, and they answer different questions:
 *
 *   - here, before `apply` runs: is the student's *view* still current? An edit is a pure
 *     function of the State, so applying one to a State the student never saw produces a
 *     document nobody asked for — a Pick landing in a Variant someone else renamed. Their
 *     click meant something about what was on their screen, so a stale view is refused
 *     before the edit is applied rather than after it is written.
 *   - in the adapter, at the write: is the *file* still what was just read? Only the thing
 *     holding the file can answer that, and the window between this read and that write is
 *     real however short it is (`server/src/workspace.fs.ts`).
 *
 * The save is based on the revision this function read rather than on the one it was handed.
 * The two are equal by the time the check above has passed, and reading it from the file is
 * what makes that the *only* place a revision enters the write.
 *
 * `StateFileUnwritableError` is left to propagate rather than caught. It can only be
 * reached by a value the schema rejects, `apply` is a pure function over a `State` the
 * schema has already accepted, and the API validates every request body before a `State`
 * is built from it — so the writer's check is a redundant second line and not a domain
 * check. Turning it into a Warning would claim a student's edit was refused, and a
 * student's edit is never refused.
 */
export async function editStateFile(
  workspace: Workspace,
  name: string,
  editing: StateEditing,
  options: EditOptions,
): Promise<EditOutcome> {
  const status = await workspace.status();
  if (!status.ready) {
    return { kind: "refused", reason: "workspace-not-ready", warnings: [] };
  }

  const loaded = await readStateFile(workspace, name);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }

  // The view the edit was made from is gone: another tab, Dropbox, git or an editor wrote
  // the file since. Refused rather than applied, and the caller reloads (#90).
  if (loaded.version !== options.basedOn) {
    return { kind: "refused", reason: "state-file-changed", warnings: loaded.warnings };
  }

  const previous = loaded.state;
  const next = editing.apply(previous);
  // an edit that changed nothing writes nothing: a save moves the Workspace's change
  // count, and a page reloading over an edit that did not happen is noise
  if (next === previous) {
    return {
      kind: "unchanged",
      state: previous,
      version: loaded.version,
      warnings: loaded.warnings,
    };
  }

  const save = writeStateFile(next, { basedOn: loaded.version });
  let version: StateFileVersion;
  try {
    version = await workspace.saveStateFile({ kind: "state", name }, save);
  } catch (error) {
    // The file changed between the read above and this write, which is the half of the
    // guard only the adapter can make. Distinct from a target it will not touch, and
    // checked first, because the two ask the student for different things.
    if (error instanceof StateFileChangedError) {
      return { kind: "refused", reason: "state-file-changed", warnings: loaded.warnings };
    }
    if (error instanceof WorkspaceRefusedError) {
      return { kind: "refused", reason: "workspace-refused", warnings: loaded.warnings };
    }
    throw error;
  }

  // The revision first, and on every save: the stack has to believe what the file holds
  // even when this edit left it nothing to undo.
  options.history?.wrote?.(version);

  // pushed after the write and never before it: an edit that failed to save did not happen,
  // and an undo of it would write back a value the file never held
  const edit: StateEdit = { label: editing.label, at: Date.now(), previous: snapshotOf(previous) };
  // An edit that only set a preference is not on the stack: ADR-0013 keeps `settings` off
  // it, and an entry for one would undo to a document identical but for the language.
  if (movedOutsideSettings(previous, next)) options.history?.push(edit);

  return { kind: "saved", state: next, version, edit, warnings: loaded.warnings };
}
