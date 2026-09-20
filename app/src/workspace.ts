/**
 * The Workspace port: how `app` reaches the student's folder without knowing it is a
 * folder. A file is named by what it is, never by where it lives, so no path is built
 * on this side of the boundary and there is nothing here to escape from
 * (docs/design.md, "Storage"; ADR-0003).
 */
export type WorkspaceFolder = "catalogs" | "requirements" | "backups";

/** A Catalog holds one Academic Year, so the year identifies the file. */
export type CatalogRef = { kind: "catalog"; academicYear: number };

/**
 * A Workspace holds one or more State Files, at its root rather than in a folder of the
 * layout — `alice.state.json` — so the name is what tells them apart (docs/design.md,
 * "Storage"). The name is a name and never a path: `isStateFileName` says which ones are,
 * and an adapter refuses the rest.
 */
export type StateFileRef = { kind: "state"; name: string };

export type WorkspaceRef = CatalogRef | StateFileRef;

/**
 * Literal patterns, never built from data (ADR-0007).
 *
 * `NAME_FORBIDS`: a path separator on either platform, a character Windows refuses in a file
 * name, and — through `\p{C}` — every control, format, surrogate and unassigned code point.
 * The `\p{C}` half is what refuses a zero-width space or a left-to-right mark, which pass a
 * `trim()` and leave two State Files that are indistinguishable in a listing and in the UI.
 * Hebrew, its punctuation and an emoji all pass, which is the point of naming what is refused
 * rather than an alphabet to draw from.
 *
 * `WINDOWS_DEVICE`: names Win32 reserves whatever is appended to them, so `NUL.state.json`
 * resolves to the null device — a save that reports success and writes the bytes nowhere,
 * which is the one failure worse than a refusal. Nothing in the repo claims Windows support
 * and no CI leg runs there, so this is untestable here and is refused rather than risked.
 */
const NAME_FORBIDS = /[/\\:*?"<>|]|\p{C}/u;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i;

/**
 * Whether a name can be a State File's. This is the first ref that carries free text rather
 * than a number, so it is the first that could smuggle a path across the boundary — and the
 * rule lives here, in the port, so that both adapters refuse the same set rather than one of
 * them relying on a check the other happens to make (ADR-0003).
 *
 * A list of what a name may not be rather than an alphabet it must be drawn from, because a
 * student writing Hebrew should be able to name their own file: empty, longer than 64
 * characters, something `NAME_FORBIDS` or `WINDOWS_DEVICE` names, starting with a dot — which
 * is `.` and `..` and every hidden file, the adapter's own temporary among them — or padded
 * with whitespace, which no one can see in a name.
 */
export function isStateFileName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  if (name.startsWith(".")) return false;
  if (name !== name.trim()) return false;
  if (WINDOWS_DEVICE.test(name)) return false;
  return !NAME_FORBIDS.test(name);
}

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
 * The refusal itself, so that both adapters make it in the same words rather than each
 * spelling out its own: a name that is not one is a target a Workspace will not touch.
 */
export function requireStateFileName(name: string): void {
  if (isStateFileName(name)) return;
  throw new WorkspaceRefusedError(
    `refusing a State File named ${JSON.stringify(name)}: a name, never a path`,
  );
}

/**
 * A folder being watched. `stop` is idempotent and leaves nothing behind that could keep
 * the process alive, which is what a caller with a shutdown path needs: the server runs in
 * the foreground of a terminal and Ctrl-C has to end it (docs/design.md, "CLI and
 * distribution").
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
