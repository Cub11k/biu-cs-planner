import {
  editStateFile,
  readStateFile,
  restoring,
  snapshotOf,
  type EditHistory,
  type EditRefusal,
  type StateEdit,
  type Workspace,
} from "@biu-cs-planner/app";
import type { StateFileVersion, StateFileWarning } from "@biu-cs-planner/core";

/**
 * Undo and redo: one snapshot stack pair per State File, held here for the life of the
 * process.
 *
 * [ADR-0013](../../docs/adr/0013-undo-is-snapshots-not-commands.md) rules the shape. An edit
 * is a pure `state -> state` function in `core`, `app/src/edit.ts` wraps it and hands the
 * previous value here, and an undo writes an earlier value back **through that same
 * wrapper** — so the external-edit guard applies to an undo exactly as it applies to the
 * edit it undoes, and there is no second write path to keep in step with the first.
 *
 * **Why the server and not a browser tab.** Undo restores the document, and there is one
 * document. There is also no session to key a stack to: `./token.ts` is one launch token
 * shared by every tab, and two tabs on one State File are the same student looking at their
 * plan twice. One history per State File is the truth rather than a compromise (ADR-0013).
 *
 * **Why it does not survive a restart.** The stacks are in memory and ADR-0013 ruled against
 * a second durable history: `.backups/` is the durable record, and a `.undo/` beside it would
 * be a trap — a stack restored from disk would offer to put back a value written before
 * whatever else touched the folder while the app was not running.
 */

/**
 * The last 100 edits, and dropped sooner once a stack passes 8 MB. Both, because entry count
 * does not bound memory: a State File grows with every Pick, Attempt and Blocked Time, and
 * 100 copies of a large one is a number of megabytes nobody chose.
 */
export const MAX_HISTORY_ENTRIES = 100;
export const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

/** What the UI needs to know to enable or disable two buttons. */
export type HistoryAvailability = { canUndo: boolean; canRedo: boolean };

/** Why an undo or a redo did not happen. Every refusal an edit can make, and four more. */
export type HistoryRefusal =
  | EditRefusal
  /** The stack is empty: nothing has been done yet, or everything has been undone. */
  | "nothing-to-undo"
  | "nothing-to-redo"
  /**
   * The State File is not there now, though this history was built on one that was: the
   * Workspace folder sits on a drive that is not mounted, a sync has moved it, or the file was
   * deleted. Nothing is written — an undo would *create* a file out of a snapshot, which is
   * not what the student asked for — and the stacks are kept, because the folder may be back
   * in a moment. A deletion that lasts is noticed the next time an edit does go through, on
   * the revision it was based on.
   */
  | "state-file-missing"
  /**
   * The State File changed on disk since the history last wrote it, so both stacks were
   * thrown away and nothing was written. The values on them were based on a file that no
   * longer exists, and putting one back would silently overwrite the change the
   * external-edit guard exists to protect (ADR-0013).
   */
  | "history-invalidated";

export type HistoryMove =
  | ({
      kind: "moved";
      /**
       * What was undone or redone, in the use case's own word for it — `pick-group`, not a
       * sentence. A key the UI translates, because UI strings go through translation files
       * and this one has to read in Hebrew too.
       */
      label: string;
      /**
       * When the snapshot that was just put back was captured: for an undo, when the edit
       * itself happened; for a redo, when the undo that displaced it did. Not when the
       * document it restores was first written — nothing records that, and nothing needs to.
       */
      at: number;
      /** The revision the file holds now: what the caller's next save is based on. */
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    } & HistoryAvailability)
  | ({
      kind: "refused";
      reason: HistoryRefusal;
      warnings: StateFileWarning[];
    } & HistoryAvailability);

/**
 * The stacks, and the operations over them. One per server: `createApi` builds it and holds
 * it, which is what makes two tabs share it.
 */
export type EditHistories = {
  /**
   * The port an ordinary edit pushes onto, for one State File. Handed to every editing use
   * case, so no use case decides anything about history beyond the label it supplies.
   */
  of(name: string): EditHistory;
  /** Whether that State File has anything to undo or redo, without touching the disk. */
  availability(name: string): HistoryAvailability;
  undo(name: string, basedOn: StateFileVersion | undefined): Promise<HistoryMove>;
  redo(name: string, basedOn: StateFileVersion | undefined): Promise<HistoryMove>;
};

/** Injected so a test can cross a bound without building eight megabytes of Picks. */
export type HistoryBounds = { maxEntries?: number; maxBytes?: number };

/** One entry, with what it costs. Measured once on the way in and never recomputed. */
type Held = { edit: StateEdit; bytes: number };

/** One State File's history. */
type Stacks = {
  undo: Held[];
  redo: Held[];
  /**
   * The revision the history believes the State File holds: the one the last save it heard
   * about wrote. `undefined` before it has heard about any, which is also the honest claim
   * that there is no file.
   *
   * This is what invalidation compares against, and it is a different question from the one
   * a save's `basedOn` asks. `basedOn` asks whether the *caller's view* is current — a stale
   * tab, which reloads and tries again. This asks whether the *file* is still the one these
   * snapshots came from, which no caller can answer: a tab that reloaded after Dropbox wrote
   * the folder holds a perfectly current revision, and an undo based on it would put back a
   * value from before that write.
   */
  version: StateFileVersion | undefined;
  /**
   * One undo or redo at a time, per State File.
   *
   * A step reads the file, awaits a write and only then moves an entry between the stacks, so
   * two steps interleaved could each pass the empty check, each pass invalidation, and each
   * pop an entry the other had already written — and the adapter's own guard cannot be relied
   * on to stop the second write, because it says itself that the window between its hash and
   * its rename is open (`./workspace.fs.ts`). A single-user app on loopback makes that
   * unlikely rather than impossible, and the entry it would lose is the student's.
   */
  turn: Promise<unknown>;
};

const utf8 = new TextEncoder();

/**
 * What one entry costs, as the UTF-8 byte length of its snapshot — the encoding the file is
 * written in, so the number means the same thing as ADR-0013's 8 MB does. Bytes rather than
 * string length because a Hebrew course name is one character and two bytes, and a bound that
 * counted characters would let a Hebrew plan take twice the memory an English one may.
 *
 * **A proxy for the memory, not a measure of it.** What a stack retains is the parsed object
 * graph, which is some multiple of its serialised size, and no runtime here will say what that
 * multiple is. The budget is therefore a stable, portable number that moves with the size of
 * the plan — which is the thing that actually grows — rather than an exact ceiling in heap.
 * The label and the timestamp are left out for the same reason: a handful of bytes beside a
 * snapshot, and counting them would suggest a precision this does not have.
 */
const bytesOf = (edit: StateEdit): number =>
  utf8.encode(JSON.stringify(edit.previous)).length;

const bytesIn = (stack: Held[]): number =>
  stack.reduce((total, held) => total + held.bytes, 0);

export function editHistories(
  workspace: Workspace,
  bounds: HistoryBounds = {},
): EditHistories {
  const maxEntries = bounds.maxEntries ?? MAX_HISTORY_ENTRIES;
  const maxBytes = bounds.maxBytes ?? MAX_HISTORY_BYTES;

  /**
   * Keyed by State File name, which is what ADR-0013 keys a history to. A Workspace holds
   * one or more State Files at its root and the API works in the default one until there is
   * a picker (`app/src/picks.ts`), so today there is one key — and the day a second State
   * File can be opened, it gets its own history without this changing.
   *
   * Nothing is ever removed from the map. There is no "close a State File" event to remove
   * it on, and the entries it holds are the stacks themselves, which are bounded.
   */
  const byStateFile = new Map<string, Stacks>();

  function stacksFor(name: string): Stacks {
    const held = byStateFile.get(name);
    if (held) return held;

    const fresh: Stacks = { undo: [], redo: [], version: undefined, turn: Promise.resolve() };
    byStateFile.set(name, fresh);
    return fresh;
  }

  /**
   * Drops from the bottom — the oldest edit — until the stack is inside both bounds.
   *
   * **The last entry is never dropped.** A single snapshot past 8 MB means the student's
   * plan is that large, and the process is already holding a copy of it to have saved it;
   * dropping the edit they just made, so that the one thing they might want back is the one
   * thing they cannot have, would be a worse answer than one stack of one large State.
   *
   * Only ever bites the undo stack in practice, and that is a property rather than a
   * coincidence: an undo moves one entry from `undo` to `redo` and a redo moves it back, so
   * the two stacks' total only grows when an edit pushes — and a push both bounds `undo` and
   * empties `redo`. The call on the far side is there so that reasoning does not have to
   * hold for the bound to.
   */
  function bound(stack: Held[]): void {
    while (stack.length > maxEntries) stack.shift();

    let bytes = bytesIn(stack);
    while (stack.length > 1 && bytes > maxBytes) bytes -= stack.shift()!.bytes;
  }

  /**
   * **`stacksFor` is the only thing that inserts, and only `of` calls it.** Everything a
   * request reaches — the availability a `GET` asks for, the step a `POST` asks for — takes
   * the map as it finds it, because a lookup that inserted would let a caller grow it a key
   * at a time on the day a request can name a State File: a memory sink reachable by asking
   * a question. `of` inserting is right, and is not that: it is called once per State File at
   * wiring time, for a file that is about to be written.
   *
   * Absent and empty are the same answer here, which is why this takes `undefined` rather
   * than making its callers check.
   */
  const availability = (stacks: Stacks | undefined): HistoryAvailability => ({
    canUndo: (stacks?.undo.length ?? 0) > 0,
    canRedo: (stacks?.redo.length ?? 0) > 0,
  });

  const refused = (
    reason: HistoryRefusal,
    stacks: Stacks | undefined,
    warnings: StateFileWarning[],
  ): HistoryMove => ({ kind: "refused", reason, warnings, ...availability(stacks) });

  /**
   * One step in either direction. Undo and redo are the same operation over two stacks: take
   * the entry off one, write its snapshot back through the wrapper, and put what it displaced
   * on the other. Writing them as one function is not a saving — it is the reason redo cannot
   * drift from undo, which is the bug an inverse per direction would invite.
   */
  async function step(
    name: string,
    stacks: Stacks,
    direction: "undo" | "redo",
    basedOn: StateFileVersion | undefined,
  ): Promise<HistoryMove> {
    const from = direction === "undo" ? stacks.undo : stacks.redo;
    const onto = direction === "undo" ? stacks.redo : stacks.undo;

    // Answered without touching the disk, and before anything else: an empty stack is the
    // ordinary state of a session that has not edited anything yet.
    if (from.length === 0) {
      const nothing = direction === "undo" ? "nothing-to-undo" : "nothing-to-redo";
      return refused(nothing, stacks, []);
    }

    const loaded = await readStateFile(workspace, name);
    // A folder that is not a Workspace, a file that cannot be read, a file this build does
    // not understand: all reasons to write nothing, and none of them a reason to throw the
    // stacks away. The file may be readable again in a moment, and the snapshots are still
    // the ones it was built from.
    if ("refused" in loaded) return refused(loaded.refused, stacks, loaded.warnings);

    // Absence is not a refusal — an absent State File reads as an empty one, based on no
    // revision — and it is not a changed file either, so it must not take the branch below.
    // An unmounted drive, a sync moving the folder and a deleted file all arrive here, and
    // none of them is a reason to write a snapshot into a file that is not there or to cost
    // the student a history the folder coming back would make good again.
    if (loaded.version === undefined && stacks.version !== undefined) {
      return refused("state-file-missing", stacks, loaded.warnings);
    }

    // Invalidation (ADR-0013): the file is not the one these snapshots came from. Dropbox,
    // git, an editor or another tool wrote it, and putting a snapshot back would overwrite
    // that writer's work behind their back — the very thing the external-edit guard exists
    // to prevent, which a caller holding a freshly reloaded revision could not stop.
    if (loaded.version !== stacks.version) {
      stacks.undo.length = 0;
      stacks.redo.length = 0;
      return refused("history-invalidated", stacks, loaded.warnings);
    }

    const held = from[from.length - 1]!;
    // Read, applied and saved by the wrapper, which reads the file a second time and refuses
    // on `basedOn` — so an undo from a stale tab is refused exactly as its edits are, and the
    // document `loaded.state` holds is the one this write displaced. The entry stays on the
    // stack until the write succeeds, so a refusal costs the student nothing.
    const outcome = await editStateFile(
      workspace,
      name,
      restoring(held.edit.label, held.edit.previous),
      { basedOn },
    );
    if (outcome.kind === "refused") {
      // Not cleared, even on `state-file-changed`. Either the caller's view is stale, which
      // a reload fixes and the history survives, or the file moved between the read above and
      // the write — and the next attempt reads it again, sees a revision it did not write and
      // invalidates there. The stacks heal on the read rather than guessing here.
      return refused(outcome.reason, stacks, outcome.warnings);
    }

    from.pop();
    // `saved` and `unchanged` are one branch on purpose, so there is no path here that no
    // test can enter. `restoring` builds a fresh object, so `unchanged` cannot arrive today;
    // if it ever did it would mean the file already held this snapshot, and every line below
    // would still be right — `outcome.version` is the revision the file holds either way.
    // What the other direction now puts back: the document as it stood before this step,
    // under the same label — so redoing an undone `pick-group` is a `pick-group` again.
    const displaced: StateEdit = {
      label: held.edit.label,
      at: Date.now(),
      previous: snapshotOf(loaded.state),
    };
    onto.push({ edit: displaced, bytes: bytesOf(displaced) });
    bound(onto);
    stacks.version = outcome.version;

    return {
      kind: "moved",
      label: held.edit.label,
      at: held.edit.at,
      version: outcome.version,
      warnings: outcome.warnings,
      ...availability(stacks),
    };
  }

  /**
   * One step at a time per State File. The queue is the `Stacks` itself, so two State Files
   * never wait on each other, and a step that rejects does not poison the queue behind it —
   * the chain is continued from a swallowed copy while the caller still sees the rejection.
   */
  function move(
    name: string,
    direction: "undo" | "redo",
    basedOn: StateFileVersion | undefined,
  ): Promise<HistoryMove> {
    const stacks = byStateFile.get(name);
    // A State File with no history has nothing to undo, and asking about it is no reason to
    // start one — see `availability` above for why this does not reach for `stacksFor`.
    if (stacks === undefined) {
      const nothing = direction === "undo" ? "nothing-to-undo" : "nothing-to-redo";
      return Promise.resolve(refused(nothing, undefined, []));
    }

    const taken = stacks.turn.then(() => step(name, stacks, direction, basedOn));
    stacks.turn = taken.catch(() => undefined);
    return taken;
  }

  return {
    of(name) {
      const stacks = stacksFor(name);
      return {
        push(edit) {
          stacks.undo.push({ edit, bytes: bytesOf(edit) });
          bound(stacks.undo);
          // A new edit is a new future: what was undone can no longer be redone, because
          // the document it would be redone onto is not the one it was undone from.
          stacks.redo.length = 0;
        },
        wrote({ basedOn, version }) {
          // The file this edit was based on is not the one this history last wrote, so
          // somebody else wrote it in between: Dropbox, git, an editor, another tool. Every
          // snapshot already held predates their change, and an undo down to one would put
          // their work back out of the file — so they go, and this edit's own entry, which
          // *is* based on what they wrote, is pushed onto the empty stack straight after.
          //
          // This is the only moment it can be seen. An edit based on the changed file goes
          // through, so nothing further along is refused and nothing else compares the two.
          if (basedOn !== stacks.version) {
            stacks.undo.length = 0;
            stacks.redo.length = 0;
          }
          stacks.version = version;
        },
      };
    },
    availability: (name) => availability(byStateFile.get(name)),
    undo: (name, basedOn) => move(name, "undo", basedOn),
    redo: (name, basedOn) => move(name, "redo", basedOn),
  };
}
