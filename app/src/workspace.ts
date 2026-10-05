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
 * Workspace Layout — `alice.state.json` — so the name is what tells them apart (docs/design.md,
 * "Storage"). The name is a name and never a path: `isStateFileName` says which ones are,
 * and an adapter refuses the rest.
 */
export type StateFileRef = { kind: "state"; name: string };

/**
 * A Requirements File: the rules of one Program for one or more Cohorts, in `requirements/` (#287).
 * Named by its file name within that folder without the `.json` — `cs-2027` for
 * `requirements/cs-2027.json` — the way a State File is named without `.state.json`. Free text,
 * so it is held to the same name rule (`isRequirementsFileName`), and an adapter refuses the rest
 * before it builds a path.
 *
 * Read and written whole, as a Catalog is, and for the same reason: nothing edits one in place. A
 * Requirements File is converted by hand from the department's rules and imported or dropped into
 * the folder, so there is no revision to carry and no save to guard (`read` and `write` below).
 */
export type RequirementsFileRef = { kind: "requirements"; name: string };

export type WorkspaceRef = CatalogRef | StateFileRef | RequirementsFileRef;

/**
 * What `read` and `write` take: the files nothing edits in place. A State File is not one of them
 * — it is read with its revision and saved through the guard — and `requireWholeFileRef` refuses
 * one at runtime as well, because a cast gets past the compiler (#113).
 */
export type WholeFileRef = CatalogRef | RequirementsFileRef;

/**
 * One snapshot in `.backups/`: a copy of a State File as it stood before one save, named by
 * which State File it is a copy of and when it was taken (`docs/design.md`, "Storage").
 *
 * **Deliberately not a member of `WorkspaceRef`** (#67). Three reasons, and the first is the
 * one that decides it:
 *
 *   - **Nothing above the port ever asks for one to be written.** A snapshot is made *by* the
 *     guarded save, beneath the port, out of the bytes that save is about to replace — so
 *     there is no write for a ref to name. Putting it in `WorkspaceRef` would hand `write` a
 *     third thing it could be pointed at, which is a second way to put a student's own data
 *     on disk and exactly what `requireCatalogRef` exists to refuse (#113, CLAUDE.md's
 *     one-writer rule).
 *   - **It is not named by the student.** A `CatalogRef` is an Academic Year and a
 *     `StateFileRef` is a name a student chose; `takenAt` is the adapter's own reading of a
 *     clock. A ref the domain cannot construct from anything a student said is not the same
 *     kind of thing as the two that are.
 *   - **`requireCatalogRef` would stop catching a third kind.** Its last line refuses
 *     `ref.name`, and the comment above it says a Requirements File ref "reaches the last
 *     line and fails to compile there". A third kind that happens to carry a `name` would
 *     compile and be refused by a sentence written about State Files — the guard silently
 *     weakened by an unrelated addition.
 *
 * So `app` reaches snapshots through two operations of their own, `listBackups` and
 * `readBackup`, and through nothing else. What that costs is that `app` cannot enumerate
 * `.backups/` the way it enumerates Catalogs, and has to ask the adapter; what it buys is
 * that the only thing that writes into `.backups/` is the save itself.
 *
 * `takenAt` is a wall-clock reading in milliseconds, as `StateEdit.at` is, and it is what
 * tells two snapshots of one State File apart. It is never a revision: what identifies the
 * *content* of a State File is `StateFileVersion`, and nothing compares a file against this.
 */
export type BackupRef = { kind: "backup"; name: string; takenAt: number };

/**
 * How many snapshots of one State File survive on the count rule: the last 20 saves
 * (`docs/design.md`, "Storage").
 */
export const BACKUP_KEEP_SAVES = 20;

/** How many days survive on the daily rule: one snapshot a day for 30 days. */
export const BACKUP_KEEP_DAYS = 30;

/**
 * Which day a snapshot belongs to, as a count of whole days since the epoch in **UTC**.
 *
 * UTC and not the student's own calendar day, which is the tempting answer. A local day
 * depends on the timezone the process happens to be in *at the moment of pruning*, so a
 * student who flies to Israel and opens the app would have their snapshots re-bucketed —
 * two of yesterday's falling into one day, and one that was yesterday's only survivor
 * becoming deletable. Pruning is the part of this that destroys data, so it answers to
 * something that cannot move under it. The names on disk are UTC for the same reason: they
 * sort.
 */
export const backupDay = (takenAt: number): number => Math.floor(takenAt / 86_400_000);

/**
 * Which snapshots of one State File may be deleted, given all of them and the time now.
 *
 * **One rule, shared by both adapters**, as `isStateFileName` and `requireStateFileName` are
 * shared and for the same reason: a copy per adapter is a copy free to drift, and here the
 * drift deletes a student's only record of what their Plan used to be. It is a pure function
 * over the snapshots and the clock, so the three cases below are tested directly rather than
 * only through a disk.
 *
 * **"Last 20 saves plus one per day for 30 days" is a union, and the two halves disagree**
 * (#67). So the keeping is additive and the deleting is what is left over — never the other
 * way round, because a snapshot either rule wants must survive the other rule not wanting it:
 *
 *   - 200 saves in one afternoon: the count rule keeps the last 20, and the daily rule keeps
 *     the newest of that day as well, so once those 20 age out that day still has one.
 *   - the app opened once a month: the daily rule's window has long passed those saves, and
 *     the count rule keeps them anyway because they are among the last 20. Age alone never
 *     deletes anything.
 *   - a day with nothing saved: the window is walked over the snapshots that exist rather
 *     than over 30 calendar days, so a gap is simply a day with nothing to keep and is no
 *     reason to hold on to something older.
 *
 * **The newest of each day** is the one the daily rule keeps: it is that day's last word, and
 * a student asking for "yesterday" means where they left off rather than where they started.
 *
 * **A snapshot dated in the future is kept**, so a clock that has run *ahead* — a laptop
 * waking with a bad time, a sync client stamping forward — is not a reason to delete data: the
 * window is the last 30 days *and everything after now*.
 *
 * **The other direction is not defended, and saying so is the honest answer.** A clock that
 * jumps *backwards* by more than 30 days makes the snapshot a save has just written look old,
 * and with 20 newer ones already there the same save's pruning deletes it. That is this rule
 * reading its inputs correctly — the snapshot genuinely claims to be from before the others —
 * and the alternative is for the rule to know which snapshot the caller just made, which is a
 * clock the pure function does not have. Written down rather than guarded, because the guard
 * would have to be a lie about one of the two numbers.
 *
 * The answer is in newest-first order, which is this function's own and not the input's.
 *
 * **One State File's snapshots, and it refuses a mixed list rather than documenting that it
 * wants one.** The count rule is "the last 20 *of this file*", so a list holding two names
 * would apply one allowance across both and delete the whole of the quieter file's history to
 * make room for the busier one's — measured, not reasoned: 30 of each produced 20 deletions,
 * every one of them the second name's. Both callers filter first, so this guards a future one,
 * which is `requireStateFileName`'s standing and its reason. An unguarded precondition is a
 * poor trade on the one function in this repository whose mistake *deletes* a student's data.
 *
 * **A moment identifies a snapshot, so the list is read as a set of moments.** Within one State
 * File both adapters refuse to let two snapshots share a millisecond — the save nudges past a
 * name that is taken — so two refs carrying one moment are two references to one file. Read any
 * other way they cost a slot each: a list holding one of the twenty twice kept nineteen
 * snapshots rather than twenty, and an identity `Set` then disagreed with itself about whether
 * the duplicate was kept. Neither is reachable from either adapter, which builds a fresh ref per
 * directory entry, and a shared rule should not be wrong in a way a third adapter could find.
 * The answer therefore holds at most one ref per moment, which is all a caller needs: it deletes
 * by the name and the moment, and that is one file.
 */
export function backupsToPrune(snapshots: BackupRef[], now: number): BackupRef[] {
  const names = new Set(snapshots.map((snapshot) => snapshot.name));
  if (names.size > 1) {
    throw new WorkspaceRefusedError(
      {
        reason: "mixed-snapshots",
        subject: { kind: "folder", folder: "backups" },
      },
      "refusing to prune the snapshots of more than one State File at once: " +
        `the last ${BACKUP_KEEP_SAVES} saves are one file's, and these name ` +
        [...names].sort().map((name) => JSON.stringify(name)).join(", "),
    );
  }

  const byMoment = new Map<number, BackupRef>();
  for (const snapshot of snapshots) {
    if (!byMoment.has(snapshot.takenAt)) byMoment.set(snapshot.takenAt, snapshot);
  }
  const newestFirst = [...byMoment.values()].sort((a, b) => b.takenAt - a.takenAt);
  const keep = new Set<number>(
    newestFirst.slice(0, BACKUP_KEEP_SAVES).map((snapshot) => snapshot.takenAt),
  );

  const today = backupDay(now);
  const daysKept = new Set<number>();
  for (const snapshot of newestFirst) {
    const day = backupDay(snapshot.takenAt);
    if (today - day >= BACKUP_KEEP_DAYS) continue;
    if (daysKept.has(day)) continue;
    daysKept.add(day);
    keep.add(snapshot.takenAt);
  }

  return newestFirst.filter((snapshot) => !keep.has(snapshot.takenAt));
}

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

/**
 * Whether a name can be a Requirements File's (#287): **the same rule as a State File's name**,
 * and for the same reason — it is free text that becomes a file name, so it is the other ref that
 * could smuggle a path across the boundary. One rule rather than a second copy, so the two kinds of
 * name cannot drift apart on what a path is.
 */
export function isRequirementsFileName(name: string): boolean {
  return isStateFileName(name);
}

/**
 * Whether a folder is a Workspace, and if not, what about its Workspace Layout is wrong.
 *
 * **Two ways a part of the Layout is not usable, and they are reported apart** (#243). A part
 * that is *not there* is `missing`, and `create` makes it. A part that is *there and is not a
 * folder* — a plain `catalogs` file — is `notAFolder`, and `create` cannot make it, because the
 * name is taken. One list for both would have told a student their `catalogs` was absent when it
 * is standing in the folder in front of them, and sent them to accept a Layout that `create` then
 * refuses on the same file. `ready` is true only when both are empty.
 *
 * `notAFolder` is **left out rather than empty** when no part is the wrong kind of thing, so the
 * answer for every other Workspace is the one it has always been, and a reader that knows only
 * `missing` still reads `ready` right. `statusOf` is where both adapters build this, so the rule
 * that joins the two lists into `ready` is written once.
 */
export type WorkspaceStatus = {
  ready: boolean;
  /** The parts of the Workspace Layout that are not there yet. */
  missing: WorkspaceFolder[];
  /** The parts of the Workspace Layout that are there and are not a folder; absent when none. */
  notAFolder?: WorkspaceFolder[];
};

/**
 * A Workspace's status, out of what is wrong with its Layout: the one rule both adapters answer
 * `status` with (#243). An adapter that cannot hold a part of the wrong kind — the in-memory one
 * cannot — still says what `ready` means through this, so the promise is pinned in the port's own
 * test rather than only where a disk can reach it.
 */
export function statusOf(layout: {
  missing: WorkspaceFolder[];
  notAFolder: WorkspaceFolder[];
}): WorkspaceStatus {
  const { missing, notAFolder } = layout;
  const ready = missing.length === 0 && notAFolder.length === 0;
  return notAFolder.length === 0 ? { ready, missing } : { ready, missing, notAFolder };
}

/**
 * The **Workspace Layout**: the folders a Workspace holds, which is what this module and both
 * adapters mean whenever they say "the layout".
 *
 * Named because the bare word was ambiguous. `CONTEXT.md` glosses **Suggested Layout** — the
 * department's recommended placement of Courses across Semesters — and the code used "the
 * layout" for something entirely unrelated: `catalogs/`, `requirements/` and `.backups/`, the
 * folders `create` makes and `status` reports missing. Two meanings, one of them glossed and
 * the other not, and a reader meeting "the layout does not exist yet" had no way to tell which
 * was meant (#174). This constant already spelled the term; the prose now uses it.
 */
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
 * A refusal is an answer the student can act on, and never a crashed server
 * (docs/design.md, "API and data rules"), which is why an adapter raises this rather than
 * letting a filesystem error out of the port. **It is not a Warning** (#149): a Warning is a
 * problem found in something that was read, and a refusal is the case where nothing could be,
 * so a caller answers it with an arm of its own rather than in a list of Warnings.
 *
 * **What `app` reads off it is `refusal`, and never `message`** (#249). `refusal` is a reason
 * code and a subject, both drawn from closed sets this port defines, and it is required: an
 * adapter cannot raise one without saying which of them it is. The sentence `app` serves is
 * worded from it, by `app` (`./refusal.ts`), so an adapter has no string of its own choosing that
 * can reach a response. The message is the adapter's own account, for a log (#165) — what used
 * to go out over the Catalog routes, until #216 found it naming a path and this found that
 * nothing but adapter discipline stopped the next one from doing so.
 */
export class WorkspaceRefusedError extends Error {
  /*
   * **`cause` is for the `--debug` log and nothing else** (#165). An adapter keeps the error it
   * met there — the filesystem's, absolute path and errno included — and no use case reads it:
   * every `catch` in `app` answers a refusal with a reason code, and the page is told only that.
   * Under `--debug` the server's `loggingWorkspace` (`server/src/debug.ts`) writes the reason
   * code, the errno and the `cause` chain to stderr; otherwise nothing reads it at all. The
   * absolute Workspace path may appear in that log, and **the launch token may never**, in any
   * mode. A `catch` that wants to log a refusal itself is the place that rule has to be kept.
   */
  override readonly name = "WorkspaceRefusedError";
  /** Why, and about what, in this port's words. The only part of a refusal `app` reads. */
  readonly refusal: WorkspaceRefusal;

  constructor(refusal: WorkspaceRefusal, message: string, options?: ErrorOptions) {
    super(message, options);
    this.refusal = refusal;
  }
}

/**
 * Why a Workspace refused, as a code rather than a sentence (#249). One per refusal this port and
 * its adapters make; `./refusal.ts` holds the sentence for each, in a record that is total over
 * this union, so a reason added here does not compile until `app` has words for it.
 *
 *   - `outside-workspace`: the target, or the folder it lives in, resolves outside the Workspace.
 *   - `unreadable`: it is there and its contents cannot be read.
 *   - `not-a-folder`: what was named as a folder is there and is not one, so it cannot be listed.
 *   - `unwritable`: the write was attempted and could not be made.
 *   - `not-a-workspace`: the Workspace Layout, or the one part of it the subject names, is not
 *     there to write into (`NotAWorkspaceError`).
 *   - `not-created`: a part of the Workspace Layout could not be made by `create`.
 *   - `not-json`: only `.json` files are read or written.
 *   - `not-a-name`: a State File's or a Requirements File's name that is not one — a path, among
 *     other things.
 *   - `not-a-year`: a Catalog's Academic Year that is not a whole number.
 *   - `not-a-moment`: a snapshot's moment that is not a whole number of milliseconds.
 *   - `not-a-catalog`: a State File handed to a whole-file read or write (`requireCatalogRef`).
 *   - `mixed-snapshots`: one pruning asked about the snapshots of more than one State File.
 */
export type WorkspaceRefusalReason =
  | "outside-workspace"
  | "unreadable"
  | "not-a-folder"
  | "unwritable"
  | "not-a-workspace"
  | "not-created"
  | "not-json"
  | "not-a-name"
  | "not-a-year"
  | "not-a-moment"
  | "not-a-catalog"
  | "mixed-snapshots";

/**
 * What a refusal was about: one of the refs a caller named, a folder of the Workspace Layout, or
 * the Workspace as a whole — its root, or the Layout when no single part of it is what is wrong.
 *
 * **The refs carry values a caller handed in, and `app` still checks them before it says them.**
 * A name refused as `not-a-name` is by definition one that is not safe to repeat, and an adapter
 * that built a subject out of something else entirely would compile; so `./refusal.ts` says a
 * name only when `isStateFileName` passes it and a number only when it is a whole one, and says
 * "a State File whose name is not one" otherwise. The subject is what lets the page say which
 * Catalog, which Academic Year and which State File; the check is what keeps it from being a
 * second channel for exactly what the message no longer is.
 */
export type WorkspaceRefusalSubject =
  | WorkspaceRef
  | BackupRef
  | { kind: "folder"; folder: WorkspaceFolder }
  | { kind: "workspace" };

/** A refusal in the port's own words: why, and about what (#249). */
export type WorkspaceRefusal = {
  reason: WorkspaceRefusalReason;
  subject: WorkspaceRefusalSubject;
};

/**
 * The refusal itself, so that both adapters make it in the same words rather than each
 * spelling out its own: a name that is not one is a target a Workspace will not touch.
 */
export function requireStateFileName(name: string): void {
  if (isStateFileName(name)) return;
  throw new WorkspaceRefusedError(
    { reason: "not-a-name", subject: { kind: "state", name } },
    `refusing a State File named ${JSON.stringify(name)}: a name, never a path`,
  );
}

/**
 * The refusal for a Requirements File's name, so both adapters make it in the same words, as
 * `requireStateFileName` is for a State File's (#287).
 */
export function requireRequirementsFileName(name: string): void {
  if (isRequirementsFileName(name)) return;
  throw new WorkspaceRefusedError(
    { reason: "not-a-name", subject: { kind: "requirements", name } },
    `refusing a Requirements File named ${JSON.stringify(name)}: a name, never a path`,
  );
}

/**
 * The refusal for a snapshot's reference, so both adapters make it in the same words — and the
 * other half of what `requireStateFileName` does for a State File.
 *
 * **`takenAt` is guarded for the reason `requireCatalogRef` guards a year.** That doc's
 * argument is that an adapter turns the year straight into a file name, so "a year that is not
 * a number is the same hole with a different key", and that "the rule should not depend on
 * being remembered". A snapshot's moment is that same key: an adapter turns it into a file name
 * too. Nothing reachable today gets past it — `server/src/api.ts` parses the body with
 * `z.number().int().safe()`, and the adapter composes the name out of `String(...).padStart(...)`
 * output, which cannot produce a separator or a `..` whatever number it is handed — so this
 * guards a future caller and is here rather than in the one caller that currently exists.
 */
export function requireBackupRef(ref: BackupRef): void {
  requireStateFileName(ref.name);
  if (!Number.isSafeInteger(ref.takenAt)) {
    throw new WorkspaceRefusedError(
      { reason: "not-a-moment", subject: ref },
      `refusing a snapshot of the State File ${JSON.stringify(ref.name)} taken at ` +
        `${JSON.stringify(ref.takenAt)}: a moment is a whole number of milliseconds, never a path`,
    );
  }
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
 * with no revision guard, no name rule and no Workspace Layout check. Measured, not reasoned: it
 * destroyed a Pin and wrote into a folder that was not a Workspace. A year is the reason a
 * `CatalogRef` needed no name rule, so the rule for it is that it really is a year.
 *
 * **The narrowing is type-only.** Both adapters still know how to name a State File, because
 * `readStateFile` and `saveStateFile` need them to, so a cast reaches a read that comes back
 * with no revision and a write with no guard at all — and, until this, no Workspace Layout
 * check either: the `ref.kind === "state"` check `write` used to carry could not survive the
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
  // Workspace reaches the last line and fails to compile there, rather than passing a check named
  // for Catalogs and being written whole without a guard. The Requirements File was that third
  // kind, and it is answered by `requireWholeFileRef` below, before this is asked (#287).
  if (ref.kind === "requirements") {
    throw new WorkspaceRefusedError(
      { reason: "not-a-catalog", subject: ref },
      "refusing a Requirements File where only a Catalog is read or written",
    );
  }
  if (ref.kind === "catalog") {
    // A safe integer and nothing else: every one of those is digits with at most a leading
    // minus, so there is no separator and no `..` for an adapter to resolve. The range a year
    // may sensibly fall in is the API's business; a path is this rule's.
    if (!Number.isSafeInteger(ref.academicYear)) {
      throw new WorkspaceRefusedError(
        { reason: "not-a-year", subject: ref },
        `refusing a Catalog for the Academic Year ${JSON.stringify(ref.academicYear)}: ` +
          "a year is a whole number, never a path",
      );
    }
    return;
  }
  throw new WorkspaceRefusedError(
    { reason: "not-a-catalog", subject: ref },
    `refusing the State File ${JSON.stringify(ref.name)} here: a State File is read through ` +
      "readStateFile and saved through saveStateFile, which carry the revision a guarded save needs",
  );
}

/**
 * What a whole-file `read` or `write` is handed, held to what it may be: a Catalog's ref whose year
 * is a year, or a Requirements File's whose name is a name — and never a State File's (#287). Both
 * adapters ask this and nothing narrower, so the rule for each kind is said once, here.
 */
export function requireWholeFileRef(ref: WorkspaceRef): void {
  if (ref.kind === "requirements") {
    requireRequirementsFileName(ref.name);
    return;
  }
  requireCatalogRef(ref);
}

/**
 * A write into a folder that is not a Workspace: the Workspace Layout is not there yet, or
 * something that is not a folder stands where a folder of it belongs.
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
   * The part of the Workspace Layout that is what is wrong, when one part is; `undefined` when
   * the answer is the Layout as a whole, which is what a folder nobody has created yet gives.
   */
  readonly folder: WorkspaceFolder | undefined;

  /**
   * `because` says what is wrong with that one folder, in the adapter's own words, because what
   * can be wrong with it is the adapter's business: a filesystem knows a plain file standing
   * where a folder belongs, and another adapter will know something else. A shared sentence
   * covering all of them would have to be vague enough to be useless, so the *stem* is what is
   * shared and it is here. It is a message and so goes only to a log (#165, #249): what `app`
   * reads is the subject, which names the folder and not what is wrong with it.
   *
   * One thing this is deliberately **not** stretched to cover: `create` failing to make a folder
   * of the Workspace Layout, which `server/src/workspace.fs.ts` refuses with a
   * `WorkspaceRefusedError` of its own. Every sentence here begins "refusing to write", and
   * that is untrue of a create.
   */
  constructor(part?: { folder: WorkspaceFolder; because: string }) {
    super(
      {
        reason: "not-a-workspace",
        subject:
          part === undefined ? { kind: "workspace" } : { kind: "folder", folder: part.folder },
      },
      "refusing to write: the Workspace layout does not exist yet" +
        (part === undefined ? "" : ` — ${part.folder} ${part.because}`),
    );
    this.folder = part?.folder;
  }
}

/**
 * A save refused because the snapshot it takes into `.backups/` could not be made — and not
 * because of anything about the State File being saved (#229).
 *
 * `saveStateFile` copies what it is about to replace before it replaces it, and refuses the
 * save when the copy cannot be made (its doc says why). Every refusal out of that step used
 * to arrive as a bare `WorkspaceRefusedError`, indistinguishable from a State File that
 * cannot be read or written, so `app/src/edit.ts` worded it as one and the page told the
 * student their saved picks could not be read — about a file that had read perfectly well.
 * This subclass is how the one case is told apart: an adapter raises it for whatever went
 * wrong in the snapshot step, with its own refusal on `cause`, that refusal's sentence as its
 * message and that refusal's reason code and subject as its own `refusal` (#249), so nothing it
 * said is lost and `app` can still tell which folder or snapshot the save was refused over.
 *
 * **Still a `WorkspaceRefusedError`**, so every caller that answers one keeps answering this
 * one, and `name` is left as the base class's for `NotAWorkspaceError`'s reason. Nothing is
 * written when it is raised: the snapshot is taken before the rename, so the State File is
 * the one the save found.
 */
export class BackupRefusedError extends WorkspaceRefusedError {
  constructor(refusal: WorkspaceRefusedError) {
    super(refusal.refusal, refusal.message, { cause: refusal });
  }
}

/**
 * What a State File holds, and which revision that content is.
 *
 * `version` is the field's name, and what it holds is the State File's **revision** (`CONTEXT.md`;
 * ADR-0015). The revision is produced by whatever read the file, because that is the only thing that
 * can: `core` is handed already-parsed JSON and performs no I/O, so it never sees what a
 * revision would have to be computed from (`StateFileVersion` in
 * `core/src/state/file.ts`). Each adapter says in its own words what it hashes.
 */
export type StateFileContents = { data: unknown; version: StateFileVersion };

/**
 * **What a State File's revision looks like, stated once, here** (#311): the SHA-256 of the file's
 * bytes, spelled as **64 lowercase hexadecimal digits** and nothing else — which is what
 * `createHash("sha256").digest("hex")` produces. ADR-0015 records why it is a hash of the bytes
 * and points here for the spelling.
 *
 * `StateFileVersion` is a plain `string` in `core`, so the type holds no adapter to this, and an
 * adapter could hand back the file's content or a path as its "revision" and the API would serve
 * it to the page. So `app` checks every revision it is handed by the port, on a read and on a
 * save alike (`./edit.ts`), and one that is not in this format is a refusal of that read or save
 * rather than a value passed on: a revision is the one adapter-produced string that travels to
 * the page, and #249 already closed the other channel, a refusal's sentence.
 *
 * A literal pattern, never built from data (ADR-0007). Anchored at both ends with no `m` flag, so
 * a trailing newline is not a revision either.
 */
const REVISION = /^[0-9a-f]{64}$/;

/** Whether a value an adapter handed back is a revision in the format above. */
export function isStateFileRevision(value: unknown): value is StateFileVersion {
  return typeof value === "string" && REVISION.test(value);
}

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
  /**
   * Whether this folder is a Workspace: built by `statusOf`, so `ready` is false when any part
   * of the Workspace Layout is missing **or** is there and is not a folder (#243).
   */
  status(): Promise<WorkspaceStatus>;
  /**
   * Creates the Workspace Layout. Called only after the student accepts.
   *
   * **Not transactional, and a refusal does not undo what it made** (#166). An adapter may make
   * the parts one at a time — the filesystem one does, one `mkdir` each — so a create refused
   * part way leaves the parts it had already made. What a refused create promises is only that
   * nothing already standing there was replaced, never that the folder is as it was found.
   *
   * **`status()` is how to see what a refused create left**: it reports which parts of the
   * Workspace Layout are missing, and accepting the Workspace Layout again makes the rest once
   * whatever refused it is fixed. (A name the Workspace Layout needs that a plain file holds is
   * not missing: `status` reports it under `notAFolder` and not ready, and a create or a write
   * refuses it by name, #243.) That is
   * the reason this need not roll back while a State File write must be atomic: a half-made
   * Workspace Layout is empty folders, a state the app can describe and recover from, and a
   * half-written file is neither. A rollback would also have to tell the folders this call made
   * from the ones that were already there, which `recursive` hides — and removing one that was
   * already there is the one thing a create must never do.
   *
   * The filesystem adapter refuses a part it cannot make with a `WorkspaceRefusedError` naming
   * it; `createWorkspace` in `./setup.ts` answers that refusal rather than letting it out of the
   * route, and this is why its answer cannot be "nothing was changed".
   */
  create(): Promise<void>;
  /**
   * What the Workspace holds of one kind, empty when there is **no folder** to hold it — and
   * `WorkspaceRefusedError` when there is something there that cannot be listed.
   *
   * Three answers and not two, for the reason `read` has three (#109): an empty folder and one
   * nobody may look into are different, and answering both with `[]` tells a student "no
   * Catalogs" when the truth is "I could not look". The first caller will be a screen whose
   * whole job is to show them what is in their folder, so the lie would be a visible one
   * (#129). An absent folder answers empty and so does a real folder holding nothing, because
   * that is the same news to a student: there is none of this kind here. **What may never come
   * back empty is a folder that could not be listed.**
   *
   * A folder that is not a folder at all — a plain `catalogs` file — is one of the two ways to
   * reach that refusal, and it is deliberately *not* absence: what was named is there, and it
   * is the wrong kind of thing. The write side refuses the same file by name
   * (`NotAWorkspaceError`, #121) and `status` reports it under `notAFolder` (#243), and an
   * adapter that read it as absence here would report its Catalogs as none.
   */
  list(kind: WorkspaceRef["kind"]): Promise<WorkspaceRef[]>;
  /**
   * Parsed JSON, or undefined when the file is not there. Never throws for absence;
   * throws `WorkspaceRefusedError` when the target is one a Workspace will not touch.
   *
   * A `WholeFileRef` and not a `WorkspaceRef`, because a State File is read through
   * `readStateFile` and there is deliberately no second way to read one: a read that
   * handed back content without its revision would be a read nothing can safely save
   * after, and the compiler is what keeps that from being written by accident. A Catalog
   * needs none — it is re-importable from its Raw Crawl and nothing edits one in place — and
   * neither does a Requirements File, which is imported or dropped in whole (#287).
   * `requireWholeFileRef` refuses a State File here at runtime as well, because a cast gets
   * past the compiler (#113).
   */
  read(ref: WholeFileRef): Promise<unknown>;
  /**
   * Atomic: an interrupted write leaves the previous file intact. Throws
   * `WorkspaceRefusedError` on a target a Workspace will not touch.
   *
   * For the files nothing edits in place. A State File is saved through `saveStateFile`,
   * and `requireWholeFileRef` refuses one here at runtime rather than trusting the narrowing
   * above, which a cast defeats (#113).
   */
  write(ref: WholeFileRef, data: unknown): Promise<void>;
  /**
   * What a State File holds and which revision that is, or undefined when it is not there.
   * Absence is not an error, exactly as for `read`.
   *
   * This is the half of the external-edit guard that `core` cannot reach: the revision has
   * to be produced where the file is, and it travels from here through the use case, the
   * API and the page, back to `saveStateFile`. It is in the format `isStateFileRevision`
   * states, and `app` refuses the read when it is not (#311).
   */
  readStateFile(ref: StateFileRef): Promise<StateFileContents | undefined>;
  /**
   * Saves a State File, and refuses to overwrite one that is not the revision the save was
   * based on: `StateFileChangedError`, whose doc says why this one refuses rather than
   * warning. Atomic as `write` is, and it hands back the revision it wrote so the next save
   * from the same page needs no re-read — in the format `isStateFileRevision` states, which
   * `app` checks before passing it on (#311).
   *
   * **It also writes the snapshot into `.backups/`, out of the bytes it is about to replace**
   * (#67; `docs/design.md`, "Storage"). That is beneath the port on purpose: `app` has no
   * second write to remember and no way to save without backing up, which is the same
   * argument that put the revision and the JSON into one value below. A first save replaces
   * nothing, so it leaves no snapshot; every save after it does. Pruning to the retention rule
   * — `backupsToPrune` above — happens here too, after the save has landed.
   *
   * **A snapshot that cannot be written refuses the save.** `.backups/` is part of the
   * Workspace Layout and this method already refuses a save when any part of it is missing, so
   * an unwritable one is a refusal too: a Warning the student can act on. It is raised as
   * `BackupRefusedError`, which every adapter owes the caller (#229), so that it is worded as
   * the backup's and not as the State File's. The alternative — saving anyway and quietly keeping no backup — is the failure #67
   * was filed about, and it is invisible until the day it matters. **Pruning is the other way
   * round**: it runs after the save, it only deletes, and a snapshot it could not remove is
   * one too many rather than one too few, so it never costs a student their save.
   *
   * It takes the whole `StateFileSave` that `core`'s `writeStateFile` produced rather than
   * the JSON and a revision separately. They are produced together so that no caller has to
   * remember to ask for the revision, and this is where they are also *consumed* together:
   * there is no way to hand a State File's content to a Workspace without the revision it
   * was based on, which is the hole #90 was filed for.
   */
  saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<StateFileVersion>;
  /**
   * The snapshots of one State File, newest first (#67).
   *
   * `[]` when there are none, and `[]` when there is no `.backups/` at all — the same news to
   * a student either way, exactly as `list` answers for a folder that is not there. A folder
   * that is there and cannot be listed is `WorkspaceRefusedError`, which is the third answer
   * `list` has and for the same reason (#129): "I could not look" may never come back empty.
   *
   * **This asks nothing about the Workspace Layout**, deliberately and unlike `restoreBackup`
   * in `./backups.ts`: a folder nobody has made a Workspace yet holds no snapshots, which is
   * the empty answer and not a refusal. A student should be able to open the screen before
   * they have accepted the Layout, exactly as reading the State File is unguarded while
   * writing it is not (`app/src/edit.ts`).
   *
   * Per State File, because retention is per State File: `alice` keeping her last 20 saves
   * says nothing about `bob`'s.
   */
  listBackups(ref: StateFileRef): Promise<BackupRef[]>;
  /**
   * What one snapshot holds, or undefined when it is not there. Absence is not an error, as
   * for `read` and `readStateFile`.
   *
   * **No revision comes back, and that is not the hole it looks like.** A revision is what a
   * save has to be based on, and nothing ever saves a snapshot: `.backups/` is written by the
   * guarded save and pruned by it, and a restore writes the *State File* — through
   * `editStateFile`, carrying that file's revision (ADR-0013, "the save path is the undo
   * path"). So there is no later write for a snapshot's revision to guard, which is the
   * difference from `read`, where the narrowing to a `CatalogRef` exists precisely because a
   * State File does have one.
   *
   * Parsed JSON, as `read` hands it back, and the caller puts it through the same reader a
   * State File goes through: a snapshot written by an older build has to open, which is what
   * backups are for.
   */
  readBackup(ref: BackupRef): Promise<unknown>;
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
   *
   * **Binds #80, #67 and #73**, the three tickets that write through this port: none may add
   * suppression to an implementation of it.
   */
  watch(onChange: WorkspaceChanged): Promise<WorkspaceWatcher>;
};
