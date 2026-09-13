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
};
