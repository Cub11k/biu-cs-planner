import type { StateFileSave, StateFileVersion } from "@biu-cs-planner/core";
import {
  NotAWorkspaceError,
  requireCatalogRef,
  requireStateFileName,
  StateFileChangedError,
  WORKSPACE_LAYOUT,
  type StateFileContents,
  type StateFileRef,
  type Workspace,
  type WorkspaceChanged,
  type WorkspaceFolder,
  type WorkspaceRef,
  type WorkspaceStatus,
  type WorkspaceWatcher,
} from "./workspace.ts";

/**
 * A Workspace held in memory. The use-case tests run against this so they exercise the
 * port rather than a filesystem; the real adapter is tested separately, against a real
 * temporary folder, because that is where the interesting failures live.
 *
 * **One answer of the port it cannot give.** A read has three: the bytes, no file, and a file
 * that is there and cannot be read (#109). Nothing here can be unreadable — there are no
 * bytes and no mode bits — and the double is not given a knob for it, because a knob invented
 * for one test would be a behaviour of the double rather than of the port. A use case that
 * needs that answer injects it (`cannotBeRead` in `edit.test.ts`), and the adapter that
 * raises it for real is tested against a real folder. The conflict refusal is different and
 * *is* modelled here, because a revision is something this can hold.
 */
export type MemoryWorkspace = Workspace & {
  /** Refs written so far, in order, so a test can assert that nothing was written. */
  written(): WorkspaceRef[];
  /**
   * Puts a file there without going through `write`, to set a test up — and, because it
   * is the one change this double can make that the app did not, the stand-in for an
   * external edit. Watchers hear it, exactly as a real one hears Dropbox.
   */
  seed(ref: WorkspaceRef, data: unknown): void;
  /** Takes a file away from outside, so a watcher can be asked about a deletion. */
  remove(ref: WorkspaceRef): void;
  /** How many watchers are still open, so a test can assert that `stop` let go. */
  watching(): number;
};

/**
 * A ref as one string, so a Map can be keyed by it — and the place the double makes the same
 * refusal the real adapter makes when it turns a name into a path, through the same function.
 * A double that accepted a name a disk refuses would prove a use case works where it does not.
 *
 * Two things a Map cannot stand in for, and they are the double's known limits rather than
 * the port's: a key is matched exactly, so `alice` and `Alice` are two files here and one on
 * macOS or Windows, and a name is held in the form it arrived in, where macOS stores it
 * decomposed and hands a different string back. A use case that turns on either belongs in
 * `server/src/workspace.fs.test.ts`, against a real folder.
 */
const key = (ref: WorkspaceRef): string => {
  switch (ref.kind) {
    case "catalog":
      return `catalog:${ref.academicYear}`;
    case "state":
      requireStateFileName(ref.name);
      return `state:${ref.name}`;
  }
};

/**
 * What a file holds: JSON, so a value JSON cannot express is refused here as the real adapter
 * refuses it, and what `read` hands back is a copy rather than the caller's own object. A
 * double that stored the object itself would let a use case mutate a "file" after writing it
 * and still pass.
 */
const stored = (data: unknown): unknown => JSON.parse(JSON.stringify(data)) as unknown;

/**
 * The double's stand-in for a revision, and it is the stored text itself.
 *
 * The real adapter hashes the bytes it read (`server/src/workspace.fs.ts`), and it hashes
 * rather than remembers because the version has to be small enough for a browser to hold
 * and hand back on the next save. This one has no browser and no bytes, so it can afford
 * the limit case of the same idea: a revision that *is* the content answers "is the file
 * still what I read?" with no collisions at all, which is the property every test here
 * turns on. Nothing may read the string — it is opaque to everything but a comparison, as
 * `StateFileVersion` says — and a double whose versions were a counter would have hidden
 * the two-tab lost update this guard exists for.
 */
const revisionOf = (data: unknown): StateFileVersion => JSON.stringify(data) ?? "";

export function memoryWorkspace(
  options: { created?: boolean } = {},
): MemoryWorkspace {
  const files = new Map<string, { ref: WorkspaceRef; data: unknown }>();
  const writes: WorkspaceRef[] = [];
  let folders: WorkspaceFolder[] = options.created ? [...WORKSPACE_LAYOUT] : [];
  const watchers = new Set<WorkspaceChanged>();

  /**
   * Nothing is written into a folder the student has not agreed to make a Workspace, which is
   * the refusal the real adapter makes and in the order it makes it: before it looks at what
   * the file holds. A double that asked in the other order would answer a save into a folder
   * that is not a Workspace with a conflict.
   *
   * `NotAWorkspaceError` from the port, so this refusal is the real adapter's own and not a
   * copy of its sentence: it was a plain `Error` spelling the same words out again here, which
   * is a refusal nothing catches by name and a wording free to drift from the one a student
   * actually meets (#121).
   *
   * **The other way a layout is not one, this double cannot hold**: a plain file standing where
   * a folder of the layout belongs, which the real adapter refuses with the same error naming
   * the folder. There is nothing here a `WorkspaceFolder` could be the wrong kind of, and the
   * double is not given a knob for it for the reason it is given none for an unreadable file —
   * a knob invented for one test is a behaviour of the double rather than of the port.
   */
  const requireLayout = (): void => {
    if (folders.length < WORKSPACE_LAYOUT.length) throw new NotAWorkspaceError();
  };

  /**
   * Storing a file, which both writes go through so that the layout check and the copy are
   * made in one place and cannot drift apart between them.
   */
  const writeFile = (ref: WorkspaceRef, data: unknown): void => {
    const at = key(ref);
    requireLayout();
    files.set(at, { ref, data: stored(data) });
    writes.push(ref);
    changed();
  };

  /**
   * Every change to the folder, whoever made it. A real watcher cannot tell the app's own
   * write from an editor's, so this one does not either — a double that were quieter than
   * the thing it stands in for would prove the quieter behaviour.
   */
  const changed = (): void => {
    for (const watcher of [...watchers]) watcher();
  };

  return {
    async status(): Promise<WorkspaceStatus> {
      const missing = WORKSPACE_LAYOUT.filter((f) => !folders.includes(f));
      return { ready: missing.length === 0, missing };
    },
    async create(): Promise<void> {
      folders = [...WORKSPACE_LAYOUT];
      changed();
    },
    async list(kind): Promise<WorkspaceRef[]> {
      // Ordered by key, because the real adapter's listing is ordered: a test that read this
      // one in the order things were written in would pass here and not on a disk.
      return [...files]
        .filter(([, held]) => held.ref.kind === kind)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, held]) => held.ref);
    },
    async read(ref): Promise<unknown> {
      // The same refusal the real adapter makes, through the same function and so in the same
      // words: a State File is read with its revision or not at all (#113).
      requireCatalogRef(ref);
      return files.get(key(ref))?.data;
    },
    async write(ref, data): Promise<void> {
      // Refused before the layout is looked at, as the real adapter refuses it: the ref being
      // one this port will not write whole is about the target, not about the folder. A double
      // that answered a cast with a conflict, or with a layout error, would prove the wrong
      // refusal (#113).
      requireCatalogRef(ref);
      writeFile(ref, data);
    },
    async readStateFile(ref: StateFileRef): Promise<StateFileContents | undefined> {
      const held = files.get(key(ref));
      return held === undefined ? undefined : { data: held.data, version: revisionOf(held.data) };
    },
    async saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<StateFileVersion> {
      // The name is refused before anything else looks at the file, as the real adapter
      // refuses it before it builds a path, and the layout before the revision, as the real
      // adapter asks in that order too.
      const at = key(ref);
      requireLayout();
      const found = files.get(at);
      const version = found === undefined ? undefined : revisionOf(found.data);
      if (version !== save.basedOn) {
        throw new StateFileChangedError(ref.name, { basedOn: save.basedOn, found: version });
      }
      writeFile(ref, save.json);
      return revisionOf(stored(save.json));
    },
    async watch(onChange): Promise<WorkspaceWatcher> {
      watchers.add(onChange);
      // `stop` is idempotent: a Set forgets a watcher once, and a second call is a no-op
      return { stop: () => void watchers.delete(onChange) };
    },
    written: () => [...writes],
    seed: (ref, data) => {
      files.set(key(ref), { ref, data: stored(data) });
      changed();
    },
    remove: (ref) => {
      files.delete(key(ref));
      changed();
    },
    watching: () => watchers.size,
  };
}
