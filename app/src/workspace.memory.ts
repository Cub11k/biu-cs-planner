import {
  requireStateFileName,
  WORKSPACE_LAYOUT,
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

export function memoryWorkspace(
  options: { created?: boolean } = {},
): MemoryWorkspace {
  const files = new Map<string, { ref: WorkspaceRef; data: unknown }>();
  const writes: WorkspaceRef[] = [];
  let folders: WorkspaceFolder[] = options.created ? [...WORKSPACE_LAYOUT] : [];
  const watchers = new Set<WorkspaceChanged>();

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
      return files.get(key(ref))?.data;
    },
    async write(ref, data): Promise<void> {
      const at = key(ref);
      // Refused before the layout exists, as the real adapter refuses it: nothing is written
      // into a folder the student has not agreed to make a Workspace.
      if (folders.length < WORKSPACE_LAYOUT.length) {
        throw new Error("refusing to write: the Workspace layout does not exist yet");
      }
      files.set(at, { ref, data: stored(data) });
      writes.push(ref);
      changed();
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
