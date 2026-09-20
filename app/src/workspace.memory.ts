import {
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

const key = (ref: WorkspaceRef): string => `${ref.kind}:${ref.academicYear}`;

export function memoryWorkspace(
  options: { created?: boolean } = {},
): MemoryWorkspace {
  const files = new Map<string, unknown>();
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
      return [...files.keys()]
        .filter((k) => k.startsWith(`${kind}:`))
        .map((k) => ({ kind: "catalog", academicYear: Number(k.split(":")[1]) }));
    },
    async read(ref): Promise<unknown> {
      return files.get(key(ref));
    },
    async write(ref, data): Promise<void> {
      files.set(key(ref), data);
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
      files.set(key(ref), data);
      changed();
    },
    remove: (ref) => {
      files.delete(key(ref));
      changed();
    },
    watching: () => watchers.size,
  };
}
