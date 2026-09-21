import {
  CURRENT_STATE_SCHEMA_VERSION,
  parseStateFile,
  stateSchema,
  writeStateFile,
  type State,
  type StateFileWarning,
} from "@biu-cs-planner/core";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

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
 * What #73 pushes onto its undo stack: the State File as it stood before one edit, and the
 * label the use case gave that edit. Produced here on every save and handed both to the
 * caller and to `history`, so the stack that ticket adds has somewhere to hang without any
 * use case changing.
 *
 * The bounds ADR-0013 sets — the last 100 edits, dropped sooner past 8 MB, in memory and
 * gone on restart — belong to the stack and not to this, which is why there is no stack
 * here yet: this owes the entries, and #73 owes what holds them.
 */
export type StateEdit = { label: string; previous: State };

/** Where the entries go. A port, so #73 decides what holds them and how many. */
export type EditHistory = { push(edit: StateEdit): void };

/** What one edit does, and what an undo of it would be called. */
export type StateEditing = {
  /** The use case's own word for this edit; ADR-0013 has the entry carry it. */
  label: string;
  apply(state: State): State;
};

export type EditOptions = { history?: EditHistory };

/** Why an edit did not happen. Never a domain check: both are about the file itself. */
export type EditRefusal = "state-file-unreadable" | "workspace-refused";

export type EditOutcome =
  | { kind: "saved"; state: State; edit: StateEdit; warnings: StateFileWarning[] }
  /** The edit changed nothing, so nothing was written and there is nothing to undo. */
  | { kind: "unchanged"; state: State; warnings: StateFileWarning[] }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

/**
 * A State File that is not there yet. Parsed rather than written out as a literal, so the
 * empty file this produces is exactly the one `parseStateFile` produces from `{}` — one
 * place decides what a new student's data starts as, and it is the schema.
 */
const newState = (): State => stateSchema.parse({ schemaVersion: CURRENT_STATE_SCHEMA_VERSION });

/** What reading the current State File can come back as. */
export type StateFileLoad =
  | { state: State; warnings: StateFileWarning[] }
  | { refused: EditRefusal; warnings: StateFileWarning[] };

/**
 * Reads the State File, or hands back a new one when there is none.
 *
 * A file this build cannot read at all is **not** overwritten: it may be hand-edited, and
 * saving over it would cost the student everything in it, silently. That is the rule
 * `importCrawl` already follows for a stored Catalog (docs/design.md, "Storage").
 */
export async function readStateFile(
  workspace: Workspace,
  name: string,
): Promise<StateFileLoad> {
  let stored: unknown;
  try {
    stored = await workspace.read({ kind: "state", name });
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      return { refused: "workspace-refused", warnings: [] };
    }
    throw error;
  }
  if (stored === undefined) return { state: newState(), warnings: [] };

  // a file is untrusted input whoever wrote it, so every read goes through the schema
  const parsed = parseStateFile(stored);
  if (!parsed.state) return { refused: "state-file-unreadable", warnings: parsed.warnings };

  return { state: parsed.state, warnings: parsed.warnings };
}

/**
 * Applies one edit and saves.
 *
 * **`basedOn` is `undefined`, deliberately.** `writeStateFile` takes the version the save
 * was based on so that the external-edit guard can refuse an overwrite of a file that
 * changed on disk meanwhile, but nothing can produce a version yet: `StateFileRead` carries
 * none and `Workspace.write(ref, data)` takes none. `undefined` is the only argument
 * available and is the accepted state until #90 gives the port a version to carry.
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
  options: EditOptions = {},
): Promise<EditOutcome> {
  const loaded = await readStateFile(workspace, name);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }

  const previous = loaded.state;
  const next = editing.apply(previous);
  // an edit that changed nothing writes nothing: a save moves the Workspace's change
  // count, and a page reloading over an edit that did not happen is noise
  if (next === previous) {
    return { kind: "unchanged", state: previous, warnings: loaded.warnings };
  }

  const save = writeStateFile(next, { basedOn: undefined });
  try {
    await workspace.write({ kind: "state", name }, save.json);
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      return { kind: "refused", reason: "workspace-refused", warnings: loaded.warnings };
    }
    throw error;
  }

  // pushed after the write and never before it: an edit that failed to save did not happen,
  // and an undo of it would write back a value the file never held
  const edit: StateEdit = { label: editing.label, previous };
  options.history?.push(edit);

  return { kind: "saved", state: next, edit, warnings: loaded.warnings };
}
