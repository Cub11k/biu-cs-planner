import {
  WORKSPACE_LAYOUT,
  type Workspace,
  type WorkspaceFolder,
  type WorkspaceRef,
  type WorkspaceStatus,
} from "./workspace.ts";

/**
 * A Workspace held in memory. The use-case tests run against this so they exercise the
 * port rather than a filesystem; the real adapter is tested separately, against a real
 * temporary folder, because that is where the interesting failures live.
 */
export type MemoryWorkspace = Workspace & {
  /** Refs written so far, in order, so a test can assert that nothing was written. */
  written(): WorkspaceRef[];
  /** Puts a file there without going through `write`, to set a test up. */
  seed(ref: WorkspaceRef, data: unknown): void;
};

const key = (ref: WorkspaceRef): string => `${ref.kind}:${ref.academicYear}`;

export function memoryWorkspace(
  options: { created?: boolean } = {},
): MemoryWorkspace {
  const files = new Map<string, unknown>();
  const writes: WorkspaceRef[] = [];
  let folders: WorkspaceFolder[] = options.created ? [...WORKSPACE_LAYOUT] : [];

  return {
    async status(): Promise<WorkspaceStatus> {
      const missing = WORKSPACE_LAYOUT.filter((f) => !folders.includes(f));
      return { ready: missing.length === 0, missing };
    },
    async create(): Promise<void> {
      folders = [...WORKSPACE_LAYOUT];
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
    },
    written: () => [...writes],
    seed: (ref, data) => void files.set(key(ref), data),
  };
}
