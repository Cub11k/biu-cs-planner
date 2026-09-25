import type { StateFileSave, StateFileVersion } from "@biu-cs-planner/core";

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
 * A Workspace refused an operation: the target resolves outside it, is not a kind of file a
 * Workspace holds, or is a file that is there and whose contents cannot be read.
 *
 * Distinct from absence, which is not an error — the port's `read` returns undefined for
 * that. **A file that cannot be read is not absence**, and reporting it as such is what let a
 * save based on there being no file overwrite one that was there all along (#109): only
 * nothing at that name may come back as undefined.
 *
 * A refusal is a Warning the student can act on, and never a crashed server
 * (docs/design.md, "API and data rules"), which is why an adapter raises this rather than
 * letting a filesystem error out of the port.
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
 * The other half of narrowing `read` and `write` to a `CatalogRef`, and the half a compiler
 * cannot make: one refusal, shared by both adapters and in the same words, for anything handed
 * to a whole-file read or write that is not really a Catalog's reference (#113).
 *
 * **Two ways it is not one**, and a cast is what produces either. The ref is a State File's,
 * the case the ticket was filed for. Or it claims to be a Catalog's and its year is not a
 * number — and that one is the same hole with a different key, because an adapter turns the
 * year straight into a file name: a year of `"../alice.state"` builds a path back out of
 * `catalogs/` and onto a State File at the Workspace root, which then gets overwritten whole
 * with no revision guard, no name rule and no layout check. Measured, not reasoned: it
 * destroyed a Pin and wrote into a folder that was not a Workspace. A year is the reason a
 * `CatalogRef` needed no name rule, so the rule for it is that it really is a year.
 *
 * **The narrowing is type-only.** Both adapters still know how to name a State File, because
 * `readStateFile` and `saveStateFile` need them to, so a cast reaches a read that comes back
 * with no revision and a write with no guard at all — and, until this, no layout check
 * either: the `ref.kind === "state"` layout check `write` used to carry could not survive the
 * narrowing, because the compiler rejects that comparison on a `CatalogRef`, so it moved into
 * `saveStateFile` and left `write` covering nothing. `requireJsonName` in
 * `server/src/workspace.fs.ts` already states the principle: every caller in the repo
 * satisfies the rule, so this guards a future one, and the rule should not depend on being
 * remembered. With a student's only copy of their own data behind it, more so.
 *
 * **The read is refused in the same words as the write**, although it costs less — an
 * unversioned read rather than a lost file. Content without its revision is content nothing
 * can safely save afterwards, which is the trap the narrowing exists to set a compiler
 * against; and one rule is one thing to remember about this port rather than two.
 */
export function requireCatalogRef(ref: WorkspaceRef): void {
  // Spelled as what it *requires* rather than what it refuses, so a third kind of file in a
  // Workspace — a Requirements File ref — reaches the last line and fails to compile there,
  // rather than passing a check named for Catalogs and being written whole without a guard.
  if (ref.kind === "catalog") {
    // A safe integer and nothing else: every one of those is digits with at most a leading
    // minus, so there is no separator and no `..` for an adapter to resolve. The range a year
    // may sensibly fall in is the API's business; a path is this rule's.
    if (!Number.isSafeInteger(ref.academicYear)) {
      throw new WorkspaceRefusedError(
        `refusing a Catalog for the Academic Year ${JSON.stringify(ref.academicYear)}: ` +
          "a year is a whole number, never a path",
      );
    }
    return;
  }
  throw new WorkspaceRefusedError(
    `refusing the State File ${JSON.stringify(ref.name)} here: a State File is read through ` +
      "readStateFile and saved through saveStateFile, which carry the revision a guarded save needs",
  );
}

/**
 * A write into a folder that is not a Workspace: the layout is not there yet, or something
 * that is not a folder stands where a folder of the layout belongs.
 *
 * **One refusal shared by both adapters**, as `requireStateFileName` is, and for the same
 * reason: it was two plain `Error`s in `server/src/workspace.fs.ts` and a third copy of the
 * same sentence as a literal in `app/src/workspace.memory.ts`, so the two adapters could
 * drift apart on the wording of a refusal a caller reads, and neither copy was a type
 * anything could catch by name (#121).
 *
 * **A `WorkspaceRefusedError` and not a kind of its own.** That error means a target a
 * Workspace will not touch, and a folder nobody has agreed to make a Workspace is exactly
 * that: the request names a file the Workspace has no place to put, which is a mistake in the
 * request and not a fact about the file. `StateFileChangedError`'s doc already draws the line
 * this side of itself — "the same class of refusal as a folder that is not a Workspace yet" —
 * and the boundary needs no new arm for this: `app/src/edit.ts` and `app/src/catalog.ts`
 * already catch `WorkspaceRefusedError` and word it as `workspace-refused`, which
 * `server/src/api.ts` answers with a 409. A kind of its own would have to be added to every
 * one of those to be answered at all, and until it was it would be the unnamed 500 this
 * subclass exists to remove.
 *
 * **It is a subclass anyway, rather than the base error with a message**, so that a test can
 * say which refusal it got and a future caller can tell "not a Workspace" from a name that is
 * a path without reading the sentence. `name` is deliberately left as the base class's, as
 * `OutsideWorkspaceError` and `UnreadableError` leave it: the name is the category a boundary
 * reports, and there is exactly one of those.
 */
export class NotAWorkspaceError extends WorkspaceRefusedError {
  /**
   * The part of the layout that is what is wrong, when one part is; `undefined` when the
   * answer is the layout as a whole, which is what a folder nobody has created yet gives.
   */
  readonly folder: WorkspaceFolder | undefined;

  /**
   * `because` says what is wrong with that one folder, in the adapter's own words, because what
   * can be wrong with it is the adapter's business: a filesystem knows a plain file standing
   * where a folder belongs, and another adapter will know something else. A shared sentence
   * covering all of them would have to be vague enough to be useless, so the *stem* is what is
   * shared and it is here.
   *
   * One thing this is deliberately **not** stretched to cover: `create` failing to make a folder
   * of the layout, which `server/src/workspace.fs.ts` refuses with a `WorkspaceRefusedError` of
   * its own. Every sentence here begins "refusing to write", and that is untrue of a create.
   */
  constructor(part?: { folder: WorkspaceFolder; because: string }) {
    super(
      "refusing to write: the Workspace layout does not exist yet" +
        (part === undefined ? "" : ` — ${part.folder} ${part.because}`),
    );
    this.folder = part?.folder;
  }
}

/**
 * What a State File holds, and which revision that content is.
 *
 * The version is produced by whatever read the file, because that is the only thing that
 * can: `core` is handed already-parsed JSON and performs no I/O, so it never sees what a
 * revision would have to be computed from (`StateFileVersion` in
 * `core/src/state/file.ts`). Each adapter says in its own words what it hashes.
 */
export type StateFileContents = { data: unknown; version: StateFileVersion };

/**
 * A save was based on a revision the State File no longer holds: something else wrote it
 * between the read the student is looking at and this save. The overwrite is refused, which
 * is what `docs/design.md`, "External edits" promises.
 *
 * **Deliberately not a `WorkspaceRefusedError`.** That one means a target a Workspace will
 * not touch — a name that is a path, a file outside the folder — and is a mistake in the
 * request. This target is perfectly legitimate and the request is well formed; what is
 * stale is the revision it was based on. A caller that folded the two together would tell a
 * student to fix a file name when what they need to do is reload.
 *
 * **And it is a refusal at all, in an app where every domain check is a Warning and the
 * edit goes through** (CLAUDE.md; ADR-0013). That grain holds because a Warning costs
 * nothing: a Clash is reported and the Pick is kept, so the student decides. Here "going
 * through" means the bytes of somebody's work are gone, with nothing left to decide and
 * nothing to warn about afterwards — the Warning would be a note attached to the loss. So
 * this is not an exception to the rule but the other side of it: the rule is that the app
 * never overrules a student about their own data, and overwriting an edit they cannot see
 * is exactly that. It is also not a check on what they chose. It is a check on what the
 * file is, which is the same class of refusal as a folder that is not a Workspace yet.
 *
 * `found` is the revision the file holds now, and `undefined` means it holds none: it was
 * deleted, or — when `basedOn` is `undefined` — it was created after this save was based on
 * its absence.
 */
export class StateFileChangedError extends Error {
  override readonly name = "StateFileChangedError";
  /** The revision the save was based on; `undefined` claims there was no file. */
  readonly basedOn: StateFileVersion | undefined;
  /** The revision the file holds now; `undefined` means there is no file. */
  readonly found: StateFileVersion | undefined;

  constructor(
    name: string,
    revisions: { basedOn: StateFileVersion | undefined; found: StateFileVersion | undefined },
  ) {
    super(
      `refusing to overwrite the State File ${JSON.stringify(name)}: ` +
        (revisions.found === undefined
          ? revisions.basedOn === undefined
            ? "it is not there"
            : "it is no longer there"
          : revisions.basedOn === undefined
            ? "it already exists, and this save was based on there being no file"
            : "it changed since the save was based on it"),
    );
    this.basedOn = revisions.basedOn;
    this.found = revisions.found;
  }
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
   *
   * A `CatalogRef` and not a `WorkspaceRef`, because a State File is read through
   * `readStateFile` and there is deliberately no second way to read one: a read that
   * handed back content without its revision would be a read nothing can safely save
   * after, and the compiler is what keeps that from being written by accident. A Catalog
   * needs none — it is re-importable from its Raw Crawl and nothing edits one in place.
   * `requireCatalogRef` refuses a State File here at runtime as well, because a cast gets
   * past the compiler (#113).
   */
  read(ref: CatalogRef): Promise<unknown>;
  /**
   * Atomic: an interrupted write leaves the previous file intact. Throws
   * `WorkspaceRefusedError` on a target a Workspace will not touch.
   *
   * For the files nothing edits in place. A State File is saved through `saveStateFile`,
   * and `requireCatalogRef` refuses one here at runtime rather than trusting the narrowing
   * above, which a cast defeats (#113).
   */
  write(ref: CatalogRef, data: unknown): Promise<void>;
  /**
   * What a State File holds and which revision that is, or undefined when it is not there.
   * Absence is not an error, exactly as for `read`.
   *
   * This is the half of the external-edit guard that `core` cannot reach: the version has
   * to be produced where the file is, and it travels from here through the use case, the
   * API and the page, back to `saveStateFile`.
   */
  readStateFile(ref: StateFileRef): Promise<StateFileContents | undefined>;
  /**
   * Saves a State File, and refuses to overwrite one that is not the revision the save was
   * based on: `StateFileChangedError`, whose doc says why this one refuses rather than
   * warning. Atomic as `write` is, and it hands back the revision it wrote so the next save
   * from the same page needs no re-read.
   *
   * It takes the whole `StateFileSave` that `core`'s `writeStateFile` produced rather than
   * the JSON and a version separately. They are produced together so that no caller has to
   * remember to ask for the version, and this is where they are also *consumed* together:
   * there is no way to hand a State File's content to a Workspace without the revision it
   * was based on, which is the hole #90 was filed for.
   */
  saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<StateFileVersion>;
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
   *
   * **Every event, whoever caused it — this port's own writes included (#88).** An
   * implementation may not filter out the events its `write` and `saveStateFile` cause:
   * the count they feed is one number shared by every poller, so a write hidden from the
   * page that made it is hidden from the other tab too, for which that write is exactly an
   * external change (ADR-0013). `./changes.ts` carries the ruling and why the page rather
   * than this port is what was changed. Telling one writer from another is the save guard's
   * job, and it does it from content.
   */
  watch(onChange: WorkspaceChanged): Promise<WorkspaceWatcher>;
};
