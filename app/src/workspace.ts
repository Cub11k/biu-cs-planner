/**
 * The Workspace port: how `app` reaches the student's folder without knowing it is a
 * folder. A file is named by what it is, never by where it lives, so no path is built
 * on this side of the boundary and there is nothing here to escape from
 * (docs/design.md, "Storage"; ADR-0003).
 */
export type WorkspaceFolder = "catalogs" | "requirements" | "backups";

/** A Catalog holds one Academic Year, so the year identifies the file. */
export type CatalogRef = { kind: "catalog"; academicYear: number };

export type WorkspaceRef = CatalogRef;

export type WorkspaceStatus = {
  ready: boolean;
  /** The parts of the layout that do not exist yet. */
  missing: WorkspaceFolder[];
};

export const WORKSPACE_LAYOUT: WorkspaceFolder[] = ["catalogs", "requirements", "backups"];

/**
 * A Workspace refused an operation: the target resolves outside it, or is not a kind of
 * file a Workspace holds. Distinct from absence, which is not an error — the port's
 * `read` returns undefined for that. A refusal is a Warning the student can act on, and
 * never a crashed server (docs/design.md, "API and data rules").
 */
export class WorkspaceRefusedError extends Error {
  override readonly name = "WorkspaceRefusedError";
}

/**
 * A folder being watched. `stop` is idempotent and must leave nothing behind that keeps
 * the process alive: the server runs in the foreground of a terminal and Ctrl-C has to
 * end it (docs/design.md, "CLI and distribution").
 */
export type WorkspaceWatcher = {
  stop(): void;
};

/**
 * Something in the Workspace moved. Deliberately says nothing about *what*: `fs.watch`
 * names a file only on some platforms and never says what happened to it, so a port that
 * promised the name would be promising something an adapter cannot keep. The UI reloads
 * (docs/design.md, "Storage"), and reloading needs no name.
 */
export type WorkspaceChanged = () => void;

export type Workspace = {
  status(): Promise<WorkspaceStatus>;
  /** Creates the layout. Called only after the student accepts. */
  create(): Promise<void>;
  list(kind: WorkspaceRef["kind"]): Promise<WorkspaceRef[]>;
  /**
   * Parsed JSON, or undefined when the file is not there. Never throws for absence;
   * throws `WorkspaceRefusedError` when the target is one a Workspace will not touch.
   */
  read(ref: WorkspaceRef): Promise<unknown>;
  /**
   * Atomic: an interrupted write leaves the previous file intact. Throws
   * `WorkspaceRefusedError` on a target a Workspace will not touch.
   */
  write(ref: WorkspaceRef, data: unknown): Promise<void>;
  /**
   * Watches the **folder**, not individual files, and calls back once per event it sees —
   * creation, modification, deletion and rename alike. Watching individual files cannot
   * see the file that appears, which is the case this exists for: a Catalog dropped into
   * `catalogs/` by hand, or a Workspace arriving from a git clone (docs/design.md,
   * "Storage").
   *
   * Raw events, not one per change: an editor saving a file emits several and a clone
   * emits a burst. Collapsing them belongs one layer up, in `watchWorkspace`, so that
   * both adapters get the same collapsing and a test can drive a burst without a disk.
   */
  watch(onChange: WorkspaceChanged): Promise<WorkspaceWatcher>;
};
