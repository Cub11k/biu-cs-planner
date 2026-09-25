import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { NotAWorkspaceError, StateFileChangedError, WorkspaceRefusedError } from "@biu-cs-planner/app";
import type { Workspace, WorkspaceRef } from "@biu-cs-planner/app";
import { fileSystemWorkspace } from "./workspace.fs.ts";

/**
 * Root reads a file whatever its mode says, and Windows does not honour mode bits, so a test
 * that chmods a file to `0o000` there proves nothing while still passing — the silent vacuous
 * pass #109 names. Skipped rather than trusted, the way `server/src/token.test.ts` skips the
 * same trick for the token file. **The behaviour itself is never left to this flag**: every
 * refusal these tests assert is also asserted through a directory where a file belongs, which
 * needs no permissions at all and runs everywhere.
 */
const unreadableFilesArePossible = process.platform !== "win32" && process.getuid?.() !== 0;

/**
 * `read` and `write` take a `CatalogRef`, and #90's narrowing is type-only: the adapter can
 * still name a State File, because `readStateFile` and `saveStateFile` need it to. This is the
 * cast a future caller would reach the whole-file routes through, written out so the tests
 * below say what they are doing (#113).
 */
const asAnyRef = <T>(
  operation: (ref: never, ...rest: never[]) => T,
): ((ref: WorkspaceRef, ...rest: never[]) => T) =>
  operation as unknown as (ref: WorkspaceRef, ...rest: never[]) => T;

const wholeFileRead = (workspace: Workspace) => asAnyRef(workspace.read);
const wholeFileWrite = (workspace: Workspace) => asAnyRef(workspace.write);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-workspace-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CATALOG = {
  schemaVersion: 1,
  academicYear: 2027,
  sources: [],
  offerings: [],
};

it("reports an ordinary folder as not a Workspace, and creates the layout when asked", async () => {
  const workspace = fileSystemWorkspace(root);

  expect(await workspace.status()).toEqual({
    ready: false,
    missing: ["catalogs", "requirements", "backups"],
  });
  expect(await readdir(root)).toEqual([]);

  await workspace.create();

  expect(await workspace.status()).toEqual({ ready: true, missing: [] });
  expect((await readdir(root)).sort()).toEqual([".backups", "catalogs", "requirements"]);
});

it("stores a Catalog and reads it back", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();

  await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);

  expect(await workspace.read({ kind: "catalog", academicYear: 2027 })).toEqual(CATALOG);
  // the file is where a student would look for it, and is readable JSON
  const raw = await readFile(join(root, "catalogs", "2027.json"), "utf8");
  expect(JSON.parse(raw)).toEqual(CATALOG);
});

it("returns nothing for a year with no Catalog, rather than throwing", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();

  expect(await workspace.read({ kind: "catalog", academicYear: 2030 })).toBeUndefined();
});

it("lists the years the Workspace holds", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);
  await workspace.write({ kind: "catalog", academicYear: 2026 }, { ...CATALOG, academicYear: 2026 });
  // something that is not a Catalog file has no business in the listing
  await writeFile(join(root, "catalogs", "notes.txt"), "ignore me");

  expect(await workspace.list("catalog")).toEqual([
    { kind: "catalog", academicYear: 2026 },
    { kind: "catalog", academicYear: 2027 },
  ]);
});

it("leaves the previous Catalog intact when a write fails partway", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);

  // a value JSON cannot serialise: the write must fail before touching the good file
  const unserialisable = { schemaVersion: 1n } as unknown;
  await expect(
    workspace.write({ kind: "catalog", academicYear: 2027 }, unserialisable),
  ).rejects.toThrow();

  expect(await workspace.read({ kind: "catalog", academicYear: 2027 })).toEqual(CATALOG);
  // and no half-written temporary file is left lying in the folder
  expect(await readdir(join(root, "catalogs"))).toEqual(["2027.json"]);
});

it("refuses to follow a folder symlinked out of the Workspace", async () => {
  const outside = await mkdtemp(join(tmpdir(), "biu-outside-"));
  try {
    await mkdir(join(root, "requirements"));
    await mkdir(join(root, ".backups"));
    await symlink(outside, join(root, "catalogs"), "dir");
    const workspace = fileSystemWorkspace(root);

    await expect(
      workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG),
    ).rejects.toThrow(/outside the Workspace/i);

    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it("hands back what a corrupt file actually contains, rather than inventing a value", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await writeFile(join(root, "catalogs", "2027.json"), "{ this is not json");

  // no throw: reporting it is the caller's job, and it needs to see the real content
  const value = await workspace.read({ kind: "catalog", academicYear: 2027 });

  expect(value).toBe("{ this is not json");
});

/**
 * `ENOTDIR` is absence as much as `ENOENT` is, and it is the second entry in the list that says
 * so — a `catalogs` that is a plain file rather than a folder, so nothing can exist below it.
 * Without this the list's other entry could be dropped with nothing failing, and a Workspace in
 * that state would start refusing reads instead of reporting a year with no Catalog.
 */
it("reads a Catalog as absent when its folder is a plain file rather than a folder", async () => {
  await writeFile(join(root, "catalogs"), "not a folder");
  const workspace = fileSystemWorkspace(root);

  await expect(workspace.read({ kind: "catalog", academicYear: 2027 })).resolves.toBeUndefined();
});

/**
 * The Catalog half of #109, and the smaller one: a Catalog is re-importable from its Raw
 * Crawl, so what was at risk is `importCrawl` overwriting a stored Catalog it never managed to
 * read. It already refuses to overwrite one it can read and cannot parse (`app/src/catalog.ts`)
 * — but absent and unreadable were the same answer here, so that refusal depended on the file
 * being readable enough to fail the schema. One fix covers both halves, because both go through
 * the one function that turns a failed read into an answer.
 *
 * A directory where the file belongs needs no permissions trick, so this runs everywhere; the
 * State File test below proves the same refusal behind a mode bit where one is possible.
 */
it("refuses a Catalog it cannot read, rather than reporting the year as having none", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await mkdir(join(root, "catalogs", "2027.json"));

  await expect(workspace.read({ kind: "catalog", academicYear: 2027 })).rejects.toThrow(
    WorkspaceRefusedError,
  );
  // absence is still not an error: only a file that is there answers this way
  await expect(workspace.read({ kind: "catalog", academicYear: 2030 })).resolves.toBeUndefined();
});

it("refuses to read a Catalog file symlinked out of the Workspace", async () => {
  const outside = await mkdtemp(join(tmpdir(), "biu-outside-"));
  try {
    await writeFile(join(outside, "secret.json"), JSON.stringify({ secret: "leaked" }));
    const workspace = fileSystemWorkspace(root);
    await workspace.create();
    // the folder is genuinely inside; the file within it points out
    await symlink(join(outside, "secret.json"), join(root, "catalogs", "2027.json"));

    await expect(
      workspace.read({ kind: "catalog", academicYear: 2027 }),
    ).rejects.toThrow(/outside the Workspace/i);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it("does not call a Workspace ready when its folders point outside", async () => {
  const outside = await mkdtemp(join(tmpdir(), "biu-outside-"));
  try {
    await mkdir(join(root, "requirements"));
    await mkdir(join(root, ".backups"));
    await writeFile(join(outside, "2030.json"), JSON.stringify({ schemaVersion: 1 }));
    await symlink(outside, join(root, "catalogs"), "dir");
    const workspace = fileSystemWorkspace(root);

    expect(await workspace.status()).toEqual({ ready: false, missing: ["catalogs"] });
    expect(await workspace.list("catalog")).toEqual([]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it("reads nothing, rather than throwing, before the layout exists", async () => {
  const workspace = fileSystemWorkspace(root);

  // the port promises absence is not an error, and a query must not become a 500
  await expect(workspace.read({ kind: "catalog", academicYear: 2027 })).resolves.toBeUndefined();
});

it("leaves the previous Catalog intact when the write itself fails", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);

  // the value serialises fine; the filesystem is what refuses, so the temporary file
  // is attempted and the failure happens with a good file already in place
  await chmod(join(root, "catalogs"), 0o500);
  try {
    await expect(
      workspace.write({ kind: "catalog", academicYear: 2027 }, { ...CATALOG, academicYear: 9999 }),
    ).rejects.toThrow();
  } finally {
    await chmod(join(root, "catalogs"), 0o700);
  }

  expect(await workspace.read({ kind: "catalog", academicYear: 2027 })).toEqual(CATALOG);
  expect(await readdir(join(root, "catalogs"))).toEqual(["2027.json"]);
});

/**
 * Watching the folder, against a real one. The debounce that turns these raw events into
 * one reload lives in `app/src/changes.ts` and is tested there with a clock the test holds;
 * what only a disk can answer is whether the events arrive at all — and whether a file that
 * *appears* is among them, which is the whole reason the design says folder and not file.
 *
 * Every wait here is bounded and polled rather than slept through: `fs.watch` says nothing
 * about how soon it will call back, and a fixed sleep is either slower than it needs to be
 * or flaky.
 */
const WITHIN_MS = 4000;

/** Polls a condition rather than trusting a delay. Returns whether it came true in time. */
async function within(condition: () => boolean, ms = WITHIN_MS): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  return condition();
}

/** Waits until no event has arrived for `ms`, so a later one can only be the stimulus. */
async function quiet(events: () => number, ms = 700): Promise<void> {
  let last = -1;
  while (last !== events()) {
    last = events();
    await new Promise((settle) => setTimeout(settle, ms));
  }
}

/**
 * Repeats a stimulus until it is observed. A folder cannot be watched before the event
 * announcing it has been heard, so a file written in that same instant is legitimately
 * missed — by any watcher, on any runtime. What is under test is that a folder which
 * appeared ends up watched, not that it is watched within a microsecond of appearing.
 */
async function observed(stimulus: () => Promise<void>, events: () => number): Promise<boolean> {
  const before = events();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await stimulus();
    if (await within(() => events() > before, 500)) return true;
  }
  return false;
}

/**
 * A watcher on `root`, counting raw events, stopped for you when the test ends.
 *
 * **Through the Workspace under test when one is passed**, and that matters for every test
 * about the app's own writes: `server/src/serve.ts` builds one adapter and both the watcher
 * and every write go through it, so a test watching a *second* instance of the adapter could
 * not see an instance-local suppression even if one were added — it would pass against the
 * very change it exists to catch. Measured, not assumed: the first draft of the tests below
 * did watch a second instance, and a suppression deliberately introduced to break them did
 * not.
 *
 * **Pass the Workspace whenever the app writes anything in the test at all**, not only when
 * the app's write is the thing under assertion: an external-edit test that first saves through
 * the adapter is testing a suppression's reach, and watching a second instance would hide it.
 * The default is for the tests where nothing goes through the adapter — a file dropped in by
 * hand, a folder appearing, a chmod — and it is a convenience, not a recommendation.
 */
async function watching(
  workspace: Workspace = fileSystemWorkspace(root),
): Promise<{ events: () => number; stop: () => void }> {
  let count = 0;
  const watcher = await workspace.watch(() => {
    count += 1;
  });
  const stop = () => watcher.stop();
  stoppers.push(stop);
  return { events: () => count, stop };
}

let stoppers: Array<() => void> = [];
beforeEach(() => {
  stoppers = [];
});
afterEach(() => {
  for (const stop of stoppers) stop();
});

it("sees a Catalog that appears in catalogs/ without the app writing it", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const watched = await watching();

  // by hand, not through `write`: this is the Dropbox, git-clone, text-editor case
  await writeFile(join(root, "catalogs", "2027.json"), JSON.stringify(CATALOG), "utf8");

  expect(await within(() => watched.events() > 0)).toBe(true);
});

it("sees a Catalog that is modified, deleted and renamed", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const file = join(root, "catalogs", "2027.json");
  await writeFile(file, JSON.stringify(CATALOG), "utf8");
  const watched = await watching();

  await writeFile(file, JSON.stringify({ ...CATALOG, sources: [] }), "utf8");
  expect(await within(() => watched.events() > 0)).toBe(true);

  const modified = watched.events();
  await rename(file, join(root, "catalogs", "2028.json"));
  expect(await within(() => watched.events() > modified)).toBe(true);

  const renamed = watched.events();
  await rm(join(root, "catalogs", "2028.json"));
  expect(await within(() => watched.events() > renamed)).toBe(true);
});

/** A State File sits in the root itself, so the root is watched as well as the layout. */
it("sees a file that appears in the Workspace root", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const watched = await watching();

  await writeFile(join(root, "alice.state.json"), "{}", "utf8");

  expect(await within(() => watched.events() > 0)).toBe(true);
});

/**
 * A Workspace can be watched before it is one. The layout appearing afterwards — created
 * by the student, or arriving with a clone — has to be picked up, or the first Catalog of
 * a brand new Workspace would be the one change nobody hears about.
 */
it("picks up a layout folder that appears after watching started", async () => {
  const workspace = fileSystemWorkspace(root);
  const watched = await watching();

  await workspace.create();
  expect(await within(() => watched.events() > 0)).toBe(true);

  // The root's own events die down first. Without this, a trailing event from one of
  // `create`'s three `mkdir`s would satisfy the assertion below and the new `catalogs/`
  // watcher would never have had to exist.
  await quiet(watched.events);

  const appeared = () =>
    writeFile(join(root, "catalogs", "2027.json"), JSON.stringify(CATALOG), "utf8");
  expect(await observed(appeared, watched.events)).toBe(true);
});

/**
 * `.backups/` is not watched. A rotating snapshot is written only by the app and nothing in
 * it is ever shown, so it is not news — and once autosave lands, watching it would make
 * every save's snapshot a page reload.
 */
it("ignores .backups, and still hears the folders that matter", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const watched = await watching();

  await writeFile(join(root, ".backups", "2027.json"), JSON.stringify(CATALOG), "utf8");
  expect(await within(() => watched.events() > 0, 500)).toBe(false);

  // the positive control: the same write in a watched folder is heard, so the silence
  // above is `.backups` being left out and not a watcher that does nothing
  await writeFile(join(root, "catalogs", "2027.json"), JSON.stringify(CATALOG), "utf8");
  expect(await within(() => watched.events() > 0)).toBe(true);
});

/**
 * **The app's own writes are reported, and that is the #88 ruling rather than an oversight.**
 * A State File save writes `.tmp-<pid>-alice.state.json` into the Workspace root, where State
 * Files live, and renames it onto the real name. Nothing here tries to recognise either event,
 * because the count they feed is one number `server/src/api.ts` serves to every poller, so a
 * write hidden from the page that made it is hidden from the other tab too — for which it is
 * exactly an external change (ADR-0013).
 *
 * **What this asserts is that a save is reported at all**, which is deliberately weaker than
 * the ruling's full claim and is as strong as this port can be made. `Workspace.watch` hands
 * its callback nothing — no event kind, no filename — so a test on this side of the port
 * cannot say *which* of a save's events it heard, and cannot distinguish the temporary from
 * the rename. Option 2 in #88, "suppress the temporaries and let the rename through", is
 * therefore ruled out by argument and not by this test: the rename onto the real name is
 * indistinguishable from an editor saving that file, which is the whole reason the option
 * fails. A test that wanted to separate them would need the port to carry a filename, and
 * giving it one so the app could recognise its own writes is the thing the ruling forbids.
 *
 * **This is the test a suppression of the app's own writes breaks.** Read the ruling on
 * `WATCHED_FOLDERS` before deleting it.
 */
it("reports the app's own State File save, the first one and the overwrite alike", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const watched = await watching(workspace);
  // `create` made three folders a moment ago; drained first, so what follows can only be the
  // save. Without this a trailing `mkdir` event would satisfy the assertion on its own.
  await quiet(watched.events);
  const beforeSaving = watched.events();

  const version = await workspace.saveStateFile(ALICE, firstSave(STATE));
  expect(await within(() => watched.events() > beforeSaving)).toBe(true);

  // and the overwrite, which is the shape autosave takes: a second save onto a file that is
  // already there, guarded by the revision the first one handed back. A suppression keyed on
  // the file not existing yet would pass the assertion above and fail this one.
  await quiet(watched.events);
  const afterFirstSave = watched.events();
  await workspace.saveStateFile(ALICE, {
    json: { ...STATE, settings: { language: "en", examSpacingDays: 4 } },
    basedOn: version,
  });
  expect(await within(() => watched.events() > afterFirstSave)).toBe(true);
});

/**
 * The same ruling for the other writer the app has today. A Catalog import writes
 * `.tmp-<pid>-<year>.json` into `catalogs/` and renames it, and the import is reported: a
 * Catalog that has just arrived is something every open tab should be showing. As above, what
 * is asserted is that the import is heard and not which of its two events did it.
 */
it("reports the app's own Catalog import", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const watched = await watching(workspace);
  await quiet(watched.events);
  const beforeImporting = watched.events();

  await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);

  expect(await within(() => watched.events() > beforeImporting)).toBe(true);
});

/**
 * And the half the ruling may not cost: a **genuine external edit still reloads**, which is
 * what this watcher exists for (docs/design.md, "External edits" — Dropbox, git, an editor).
 * Only a State File *appearing* was covered above; this is one being edited in place, at the
 * very name the app writes and just after the app wrote it. A fix that silenced the app's
 * saves by name, by folder, or by "we wrote this file recently" would swallow this one, and
 * it is the edit whose loss is a student's work.
 *
 * **Measured, not supposed.** The precise version of #88's option 1 — a set of the filenames a
 * write is about to touch, held for the write plus the grace its asynchronous events need —
 * fails exactly here, because the name a student's editor writes is the same name the app
 * writes. That is the trap the ticket predicted in words.
 */
it("sees a State File edited from outside, at the very name the app writes", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.saveStateFile(ALICE, firstSave(STATE));
  const watched = await watching(workspace);
  // the app's own save is drained before the outside edit, so the event below is attributable
  // to that edit and not to a tail of the save that preceded it
  await quiet(watched.events);
  const beforeTheOutsideEdit = watched.events();

  // by hand onto the real name, not through `saveStateFile`: the editor and sync-client case
  await writeFile(
    join(root, "alice.state.json"),
    JSON.stringify({ ...STATE, pins: ["89-101"] }),
    "utf8",
  );

  expect(await within(() => watched.events() > beforeTheOutsideEdit)).toBe(true);
});

/**
 * The case a suppression would most plausibly get wrong: the app saves and somebody else
 * writes the Workspace at the same moment, so the two are one burst that
 * `app/src/changes.ts` collapses into a single reload — which re-reads both, because
 * collapsing is not swallowing.
 *
 * **What is asserted here, exactly.** That the concurrent pair is heard, and that the watcher
 * is still hearing the folder afterwards — the second assertion drains the pair first, so its
 * event is attributable to the edit that caused it. What *cannot* be asserted on this side of
 * the port is that the external event of the pair was the one heard: two events collapsed into
 * "something happened" are not separable by a callback that carries no argument, and a count
 * of one is what both a working watcher and a watcher that lost one of the two would report.
 * That is not a gap in the test so much as the shape of the port, and it is the reason the
 * assertion below is about the folder still being live rather than about the pair.
 */
it("hears a save and an outside write that land together, and keeps hearing the folder", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const watched = await watching(workspace);
  await quiet(watched.events);
  const beforeTheBurst = watched.events();

  const saving = workspace.saveStateFile(ALICE, firstSave(STATE));
  const external = writeFile(join(root, "catalogs", "2027.json"), JSON.stringify(CATALOG), "utf8");
  await Promise.all([saving, external]);

  expect(await within(() => watched.events() > beforeTheBurst)).toBe(true);

  // and an outside edit after the pair is still heard: a suppression that latched on the save,
  // or whose window outlived it, would stop here
  await quiet(watched.events);
  const afterTheBurst = watched.events();
  await writeFile(
    join(root, "catalogs", "2027.json"),
    JSON.stringify({ ...CATALOG, sources: [] }),
    "utf8",
  );
  expect(await within(() => watched.events() > afterTheBurst)).toBe(true);
});

/**
 * A folder the operating system will not let it watch is one folder lost, not a server
 * down. Node and Bun refuse by throwing from `watch`; Deno does it asynchronously on the
 * watcher, which unhandled would be an uncaught error.
 */
it("skips a folder it cannot watch, and keeps watching the rest", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await chmod(join(root, "requirements"), 0o000);

  try {
    const watched = await watching();

    await writeFile(join(root, "catalogs", "2027.json"), JSON.stringify(CATALOG), "utf8");
    expect(await within(() => watched.events() > 0)).toBe(true);
  } finally {
    await chmod(join(root, "requirements"), 0o700);
  }
});

/**
 * Non-recursive on purpose. A Workspace that came from a git clone keeps `.git` inside it,
 * and a recursive watch would turn every commit, fetch and checkout into a page reload.
 */
it("stays quiet about churn deep inside a nested folder such as .git", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await mkdir(join(root, ".git", "objects", "ab"), { recursive: true });
  const watched = await watching();

  await writeFile(join(root, ".git", "objects", "ab", "cdef"), "object", "utf8");

  // deliberately the opposite assertion: the wait has to pass without an event
  expect(await within(() => watched.events() > 0, 500)).toBe(false);

  // and the watcher is awake, not merely absent: the same write one folder up is seen.
  // Without this, a `watch` that did nothing at all would pass the assertion above.
  await writeFile(join(root, "catalogs", "2027.json"), JSON.stringify(CATALOG), "utf8");
  expect(await within(() => watched.events() > 0)).toBe(true);
});

it("stops watching when asked, and reports nothing afterwards", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const watched = await watching();

  await writeFile(join(root, "catalogs", "2027.json"), JSON.stringify(CATALOG), "utf8");
  expect(await within(() => watched.events() > 0)).toBe(true);

  watched.stop();
  const afterStopping = watched.events();
  await writeFile(join(root, "catalogs", "2028.json"), JSON.stringify(CATALOG), "utf8");
  await rm(join(root, "catalogs", "2027.json"));

  expect(await within(() => watched.events() > afterStopping, 500)).toBe(false);
  // stopping twice is a no-op, not a crash: the server may stop after an error already did
  watched.stop();
});

/** A folder that is not there is not an error: nothing is watched and nothing throws. */
it("watches an ordinary folder that is not a Workspace yet without failing", async () => {
  const workspace = fileSystemWorkspace(join(root, "not-here"));

  const watcher = await workspace.watch(() => {});

  expect(watcher).toBeDefined();
  watcher.stop();
});

/**
 * A State File sits at the Workspace root rather than in a folder of the layout, because a
 * Workspace holds one or more of them and the name is what tells them apart
 * (docs/design.md, "Storage").
 */
const STATE = {
  schemaVersion: 1,
  attempts: [],
  timetables: [],
  pins: [],
  settings: { language: "en", examSpacingDays: 3 },
};

const ALICE = { kind: "state", name: "alice" } as const;

/** A save based on no file: the claim that this State File does not exist yet. */
const firstSave = (data: unknown) => ({ json: data as Record<string, unknown>, basedOn: undefined });

/** The State File as it sits on disk, whoever wrote it. */
const aliceOnDisk = (): Promise<string> => readFile(join(root, "alice.state.json"), "utf8");

it("stores a State File at the Workspace root, under the name it was given", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();

  await workspace.saveStateFile(ALICE, firstSave(STATE));

  expect((await workspace.readStateFile(ALICE))?.data).toEqual(STATE);
  expect(JSON.parse(await aliceOnDisk())).toEqual(STATE);
});

it("reports a State File that is not there as absent rather than failing", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();

  expect(await workspace.readStateFile({ kind: "state", name: "nobody" })).toBeUndefined();
});

/**
 * The external-edit guard (#90). A revision is a hash of the file's bytes as read, which is
 * the choice `docs/design.md`, "External edits" needs and the one the maintainer ruled for:
 * it answers the question actually being asked — is the file still what I read? — where an
 * mtime answers a different one and misfires on a `git checkout`.
 */
it("hands a revision back with a State File, and takes it back on the save", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();

  const written = await workspace.saveStateFile(ALICE, firstSave(STATE));

  const held = await workspace.readStateFile(ALICE);
  // the revision a save reports having written is the one the next read finds, so a page
  // saving twice in a row needs no read in between
  expect(held?.version).toBe(written);
  // a hash and not the file: 64 hex characters of SHA-256, small enough for a page to hold
  expect(held?.version).toMatch(/^[0-9a-f]{64}$/);
  await expect(
    workspace.saveStateFile(ALICE, { json: { schemaVersion: 1 }, basedOn: held?.version }),
  ).resolves.toMatch(/^[0-9a-f]{64}$/);
});

/**
 * The revision is computed from the file and remembered nowhere, so a second server over the
 * same folder agrees about it. An adapter that remembered the bytes it last read would agree
 * with itself and with nobody else — which is the two-tab lost update this guard exists for.
 */
it("agrees with a second Workspace over the same folder about what revision a file is", async () => {
  const first = fileSystemWorkspace(root);
  await first.create();
  await first.saveStateFile(ALICE, firstSave(STATE));

  const second = fileSystemWorkspace(root);

  expect((await second.readStateFile(ALICE))?.version).toBe(
    (await first.readStateFile(ALICE))?.version,
  );
});

it("refuses to overwrite a State File that changed on disk since it was read", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.saveStateFile(ALICE, firstSave(STATE));
  const stale = (await workspace.readStateFile(ALICE))?.version;
  // Dropbox, git, an editor, or the other tab
  const fromOutside = JSON.stringify({ ...STATE, pins: [{ courseNumber: "89-110" }] });
  await writeFile(join(root, "alice.state.json"), fromOutside, "utf8");

  const refused = workspace.saveStateFile(ALICE, { json: { schemaVersion: 1 }, basedOn: stale });

  await expect(refused).rejects.toThrow(StateFileChangedError);
  // a refusal costs the other writer nothing: their file is there, byte for byte
  expect(await aliceOnDisk()).toBe(fromOutside);
  // and nothing was left lying in the folder by the write that did not happen
  expect((await readdir(root)).sort()).toEqual([
    ".backups",
    "alice.state.json",
    "catalogs",
    "requirements",
  ]);
});

/**
 * A conflict is not a target the Workspace will not touch. The two ask the student for
 * different things — reload, or fix a file name — so a caller must be able to tell them
 * apart (app/src/workspace.ts).
 */
it("makes a conflict distinguishable from a refusal about the target itself", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.saveStateFile(ALICE, firstSave(STATE));

  const error = await workspace
    .saveStateFile(ALICE, firstSave({ schemaVersion: 1 }))
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(StateFileChangedError);
  expect(error).not.toBeInstanceOf(WorkspaceRefusedError);
  expect((error as StateFileChangedError).basedOn).toBeUndefined();
  expect((error as StateFileChangedError).found).toMatch(/^[0-9a-f]{64}$/);
});

/**
 * The property a content revision buys, and the acceptance criterion that asked whether the
 * scheme could tell: a tool that rewrote the file with the same bytes changed nothing, so
 * nothing is refused. `git checkout` of an unchanged file is exactly this case, and it is
 * where an mtime would have misfired.
 */
it("does not refuse a save when the file was rewritten with identical content", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const version = await workspace.saveStateFile(ALICE, firstSave(STATE));
  const asWritten = await aliceOnDisk();

  await rm(join(root, "alice.state.json"));
  await writeFile(join(root, "alice.state.json"), asWritten, "utf8");

  expect((await workspace.readStateFile(ALICE))?.version).toBe(version);
  await expect(
    workspace.saveStateFile(ALICE, { json: { schemaVersion: 1 }, basedOn: version }),
  ).resolves.toEqual(expect.any(String));
});

/**
 * Hashing the **bytes** and not the parsed document, which is the less obvious half of the
 * ruling. `parseStateFile` is deliberately forgiving — it drops an entry it cannot read and
 * keeps the rest — so a hash of what it parsed would be a hash of the *repaired* file, and an
 * external edit that damaged only a dropped entry would be invisible to the guard. That is
 * precisely the case where the file needs looking at.
 *
 * The cost, stated rather than hidden: a pure reformat of a file only the app writes is a
 * false refusal, whose remedy is to reload and look.
 */
it("hashes the bytes it read, not the document they parse to", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.saveStateFile(ALICE, firstSave(STATE));
  const version = (await workspace.readStateFile(ALICE))?.version;

  // same JSON, different bytes: an editor's reformat, or a damaged entry the reader drops
  await writeFile(join(root, "alice.state.json"), JSON.stringify(STATE), "utf8");

  const reformatted = await workspace.readStateFile(ALICE);
  expect(reformatted?.data).toEqual(STATE);
  expect(reformatted?.version).not.toBe(version);
});

/**
 * A State File the app cannot read still has a revision, because the guard is about the file
 * and not about the document: whatever decides what to do with unreadable content
 * (`app/src/edit.ts` refuses to overwrite it) needs to be able to say which revision it saw.
 */
it("gives content that is not JSON a revision, as it gives one to a file it can read", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await writeFile(join(root, "alice.state.json"), "{ this is not json", "utf8");

  const held = await workspace.readStateFile(ALICE);

  expect(held?.data).toBe("{ this is not json");
  expect(held?.version).toMatch(/^[0-9a-f]{64}$/);
});

/**
 * #109, and the direction the external-edit guard may not fail in. A State File that is there
 * and cannot be read reported **no revision**, so `basedOn: undefined` — the claim that there
 * is no file — matched, the guard passed, and the atomic rename destroyed a file the app could
 * not read. A file whose contents cannot be seen is exactly the file the guard exists for.
 *
 * A directory where the file belongs is `EISDIR`: a file that is there, needing no permissions
 * trick, so this half of the proof runs everywhere including as root.
 */
it("refuses a State File it cannot read, rather than reporting it absent", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await mkdir(join(root, "alice.state.json"));

  await expect(workspace.readStateFile(ALICE)).rejects.toThrow(WorkspaceRefusedError);
  // The refusal names the file the way this adapter's other one does: relative to the Workspace
  // root, never absolutely. `app/src/queries.ts` puts this message into a Warning the API
  // serves, so what is in it is what a student is shown (docs/design.md, "API and data rules").
  const refusal = await workspace
    .readStateFile(ALICE)
    .then(() => undefined)
    .catch((thrown: unknown) => thrown as Error);
  expect(refusal?.message).toContain("./alice.state.json");
  expect(refusal?.message).not.toContain(root);
  // the save a report of absence would have let through, based on there being no file
  await expect(workspace.saveStateFile(ALICE, firstSave(STATE))).rejects.toThrow(
    WorkspaceRefusedError,
  );
  // refused before anything was written, so not even a temporary is left at the root
  expect((await readdir(root)).sort()).toEqual([
    ".backups",
    "alice.state.json",
    "catalogs",
    "requirements",
  ]);
});

/**
 * The same refusal behind a mode bit, which is the shape #109 was reported as and the one a
 * student meets: their own `chmod`, a sync client, a backup tool. `EACCES` and `EISDIR` are the
 * same answer — a file that is there and cannot be read — and this is the one that proves the
 * **bytes survive the refused save**, because an inaccessible directory has no content to lose.
 *
 * Skipped where every file is readable regardless (root, Windows): there it would pass without
 * proving anything, which is worse than not running. The test above covers the refusal there.
 */
it.skipIf(!unreadableFilesArePossible)(
  "leaves a State File it may not read exactly as it found it when a save is refused",
  async () => {
    const workspace = fileSystemWorkspace(root);
    await workspace.create();
    const path = join(root, "alice.state.json");
    const held = '{"schemaVersion":1,"pins":[{"courseNumber":"89-110"}]}\n';
    await writeFile(path, held, "utf8");
    await chmod(path, 0o000);

    try {
      await expect(workspace.readStateFile(ALICE)).rejects.toThrow(WorkspaceRefusedError);
      await expect(workspace.saveStateFile(ALICE, firstSave({ schemaVersion: 1 }))).rejects.toThrow(
        WorkspaceRefusedError,
      );
    } finally {
      await chmod(path, 0o600);
    }

    // byte for byte, Pin included: the whole point of the refusal
    expect(await aliceOnDisk()).toBe(held);
  },
);

/**
 * A leading UTF-8 BOM is part of the encoding and not content. #103 changed this without
 * meaning to — `read` used to decode and parse in one step and now reads bytes, because the
 * revision has to be taken from them, and `TextDecoder` drops a BOM where a Node `utf8` read
 * keeps it. So a file an editor wrote with a BOM used to come back as raw text, `JSON.parse`
 * throwing on it, and now parses. **That is the behaviour this project wants**: several Windows
 * editors add a BOM, and a hand-dropped Catalog is the case docs/design.md, "Storage" cares
 * about. Nothing would have noticed it going away again (#109).
 */
it("reads a file whose bytes begin with a UTF-8 BOM as the JSON it holds", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const BOM = "\uFEFF";
  await writeFile(join(root, "catalogs", "2027.json"), BOM + JSON.stringify(CATALOG), "utf8");
  await writeFile(join(root, "alice.state.json"), BOM + JSON.stringify(STATE), "utf8");

  expect(await workspace.read({ kind: "catalog", academicYear: 2027 })).toEqual(CATALOG);
  expect((await workspace.readStateFile(ALICE))?.data).toEqual(STATE);
});

/** And the revision stays a hash of the bytes as read, BOM included. */
it("gives a State File that carries a BOM a revision of its own", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await writeFile(join(root, "alice.state.json"), JSON.stringify(STATE), "utf8");
  const plain = (await workspace.readStateFile(ALICE))?.version;

  await writeFile(join(root, "alice.state.json"), "\uFEFF" + JSON.stringify(STATE), "utf8");
  const carried = await workspace.readStateFile(ALICE);

  // the same document, two files on disk: a guard that called them one revision would be blind
  // to whichever tool added or removed the BOM
  expect(carried?.data).toEqual(STATE);
  expect(carried?.version).not.toBe(plain);
});

it("lists the State Files the Workspace holds, and nothing else at its root", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.saveStateFile({ kind: "state", name: "bob" }, firstSave(STATE));
  await workspace.saveStateFile(ALICE, firstSave(STATE));
  await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);
  // neither a Catalog nor anything else at the root is a State File
  await writeFile(join(root, "notes.txt"), "ignore me");
  await writeFile(join(root, "alice.json"), "{}");

  expect(await workspace.list("state")).toEqual([
    { kind: "state", name: "alice" },
    { kind: "state", name: "bob" },
  ]);
  expect(await workspace.list("catalog")).toEqual([{ kind: "catalog", academicYear: 2027 }]);
});

/**
 * #129, and the whole of it: `list` answered `[]` for a `readdir` that failed for any reason,
 * so a folder nobody may look into read as one holding nothing.
 *
 * **This is the trigger that needs no mode bit**, so it runs everywhere rather than being
 * skipped where the test user can read anything. `usablePath` asks whether a path resolves
 * inside the Workspace and not what it *is*, so a `catalogs` that is a plain file is usable,
 * counts towards the layout, and makes `status` report the Workspace **ready** (#121) — and the
 * listing then said "no Catalogs" about a Workspace the port had just called ready. That is
 * #109's lie in the one place a student would be looking straight at it.
 *
 * The refusal says which of the two it met, because the file reads perfectly well as the file
 * it is: "cannot be read" would be untrue of it, and `ENOTDIR` alone is worth less than the
 * sentence to whoever reads it (`UnwritableError`'s own reasoning).
 */
it("refuses to list Catalogs when catalogs is a plain file, rather than reporting none", async () => {
  await mkdir(join(root, "requirements"));
  await mkdir(join(root, ".backups"));
  await writeFile(join(root, "catalogs"), "not a folder");
  const workspace = fileSystemWorkspace(root);

  // the setup, asserted rather than assumed: a ready Workspace is what makes the old answer a
  // lie rather than a fair report of one that is not set up
  expect(await workspace.status()).toEqual({ ready: true, missing: [] });

  const refusal = await workspace.list("catalog").catch((error: unknown) => error);

  expect(refusal).toBeInstanceOf(WorkspaceRefusedError);
  expect((refusal as Error).message).toBe(
    "refusing ./catalogs: it is there and is not a folder (ENOTDIR)",
  );
  // no absolute path in what a caller could pass on as a Warning
  expect((refusal as Error).message).not.toContain(root);
  // and the file is untouched, as a listing has no business changing anything
  expect(await readFile(join(root, "catalogs"), "utf8")).toBe("not a folder");
});

/**
 * The same mistake one level up: the Workspace root itself is a plain file, which is where a
 * State File would be listed from. `ENOTDIR` is absence for every *file* path this module
 * builds and `ABSENT` says so; for the folder being listed it is the opposite answer, and
 * reusing that list here is the defect this ticket's amendment warned about.
 */
it("refuses to list State Files when the Workspace root is a file rather than a folder", async () => {
  const notAFolder = join(root, "workspace");
  await writeFile(notAFolder, "not a folder");
  const workspace = fileSystemWorkspace(notAFolder);

  const refusal = await workspace.list("state").catch((error: unknown) => error);

  expect(refusal).toBeInstanceOf(WorkspaceRefusedError);
  expect((refusal as Error).message).toMatch(/is there and is not a folder \(ENOTDIR\)/);
});

/**
 * The other half of the ticket, and the half a fix could break: absence is still not a refusal.
 * Two answers reach it — `usablePath`, for a folder that is not there or whose `realpath` cannot
 * be taken, and `entriesOrAbsent`'s `ENOENT` for a folder removed between the two — and both are
 * `[]`. A query must not become a 500 for a Workspace that is simply not set up yet.
 */
it("lists nothing for a Workspace with no layout, an empty one, and a root that is not there", async () => {
  const workspace = fileSystemWorkspace(root);

  // before the layout exists: the folder is absent, and the root holds no State File
  expect(await workspace.list("catalog")).toEqual([]);
  expect(await workspace.list("state")).toEqual([]);

  await workspace.create();
  expect(await workspace.list("catalog")).toEqual([]);
  expect(await workspace.list("state")).toEqual([]);

  const nowhere = fileSystemWorkspace(join(root, "never-created"));
  expect(await nowhere.list("catalog")).toEqual([]);
  expect(await nowhere.list("state")).toEqual([]);
});

/**
 * The mode-bit shape, which is how the ticket was reported and what a student actually hits —
 * their own `chmod`, a sync client, a backup tool. `EACCES` is the same answer as `ENOTDIR` in
 * class and a different one in words, and this is the case that proves the **Catalogs were there
 * all along**, which a folder that is inaccessible by being a file cannot.
 *
 * Skipped rather than trusted where every folder is readable regardless (root, Windows): there
 * it would pass without proving anything, which is worse than not running. The tests above cover
 * the refusal there, so the behaviour is never left to this flag.
 */
it.skipIf(!unreadableFilesArePossible)(
  "refuses to list a folder nobody may look into, rather than reporting it empty",
  async () => {
    const workspace = fileSystemWorkspace(root);
    await workspace.create();
    await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);
    await chmod(join(root, "catalogs"), 0o000);

    try {
      const refusal = await workspace.list("catalog").catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(WorkspaceRefusedError);
      expect((refusal as Error).message).toBe(
        "refusing ./catalogs: it is there and cannot be read (EACCES)",
      );
      expect((refusal as Error).message).not.toContain(root);
    } finally {
      await chmod(join(root, "catalogs"), 0o700);
    }

    // the Catalog the empty answer denied, listed once the folder can be looked into again
    expect(await workspace.list("catalog")).toEqual([{ kind: "catalog", academicYear: 2027 }]);
  },
);

/**
 * The first ref that carries free text rather than a number, so this is where a path could be
 * smuggled in. A name is a name: the adapter builds the path and refuses anything that would
 * steer it (ADR-0003).
 */
it("refuses a State File whose name is a path rather than a name", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();

  for (const name of ["../escaped", "sub/alice", "alice/../../escaped", "", ".hidden", ".."]) {
    await expect(workspace.readStateFile({ kind: "state", name })).rejects.toThrow(
      /WorkspaceRefusedError|refusing/,
    );
    await expect(
      workspace.saveStateFile({ kind: "state", name }, firstSave(STATE)),
    ).rejects.toThrow(/WorkspaceRefusedError|refusing/);
  }
  expect((await readdir(root)).sort()).toEqual([".backups", "catalogs", "requirements"]);
});

/**
 * The cleanup that keeps a failed write from littering the Workspace. The failure has to come
 * from the *rename* for that path to run at all: a value `JSON.stringify` rejects never reaches
 * the filesystem, and a folder a write cannot open never gets a temporary to clean up. A
 * directory where the file belongs is a rename that cannot be made with the temporary already
 * written — which is the only shape that proves the `rm`.
 *
 * **Asked of a Catalog, which is where that shape is still reachable.** It used to be asked of
 * a State File, and #109 closed that route on purpose: a directory where a State File belongs
 * is now a file that is there and cannot be read, so the save is refused before a temporary
 * exists — which is what the refusal test above asserts, by finding no temporary at the root.
 *
 * So one thing is deliberately no longer covered, said plainly rather than implied: **no test
 * now makes a State File's own temporary fail its rename**, because no shape reaches that
 * rename any more — the read the guard needs fails first, whatever is in the file's place.
 * What is still covered is the `rm` itself, which both writes share through the one
 * `writeAtomically`, and the fact that a refused save leaves the Workspace root clean.
 */
it("cleans up its temporary when the rename it needs cannot be made", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await mkdir(join(root, "catalogs", "2027.json"));

  const refusal = await workspace
    .write({ kind: "catalog", academicYear: 2027 }, CATALOG)
    .catch((error: unknown) => error);

  // A refusal and not the filesystem's own error, which is caught by nothing and would be an
  // unnamed 500 (#121). It names the Catalog in the domain's words, because a message travels
  // out as a Warning and the API exposes domain operations, never a file path.
  expect(refusal).toBeInstanceOf(WorkspaceRefusedError);
  expect((refusal as Error).message).toMatch(/the Catalog for the Academic Year 2027/);
  expect((refusal as Error).message).not.toContain(root);
  // the errno is kept, so a student is told what went wrong, and the error itself is on `cause`
  expect((refusal as Error).message).toMatch(/\(E[A-Z]+\)/);
  expect((refusal as Error).cause).toBeInstanceOf(Error);

  expect(await readdir(join(root, "catalogs"))).toEqual(["2027.json"]);
});

/**
 * A State File sits at the root, and a root exists whether or not the folder is a Workspace,
 * so the refusal a Catalog gets from the folder that is not there has to be made outright for
 * this one. Nothing is written into a folder the student has not agreed to (docs/design.md).
 */
it("refuses to write a State File into a folder that is not a Workspace yet", async () => {
  const workspace = fileSystemWorkspace(root);

  await expect(workspace.saveStateFile(ALICE, firstSave(STATE))).rejects.toThrow(
    NotAWorkspaceError,
  );
  // the sentence lives in the port now, so this adapter and the in-memory double cannot word
  // it differently (#121)
  await expect(workspace.saveStateFile(ALICE, firstSave(STATE))).rejects.toThrow(
    /layout does not exist/,
  );
  expect(await readdir(root)).toEqual([]);
});

/**
 * #113. `write` takes a `CatalogRef` so that a State File can only be saved through the guarded
 * `saveStateFile`, and that narrowing is type-only: this adapter still builds a path for a
 * `StateFileRef`, so a cast reached an unguarded whole-file write of a student's only copy. No
 * caller in the repo does this and the compiler stops an honest one — which is the same standing
 * `requireJsonName` has, and it says why it exists anyway: the rule should not depend on being
 * remembered.
 */
it("refuses a whole-file write of a State File, cast past the narrowing", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.saveStateFile(ALICE, firstSave(STATE));

  await expect(wholeFileWrite(workspace)(ALICE, { schemaVersion: 1 } as never)).rejects.toThrow(
    WorkspaceRefusedError,
  );

  // the guarded save is the only way in, and what it wrote is still there
  expect((await workspace.readStateFile(ALICE))?.data).toEqual(STATE);
});

/**
 * The half of #113 that is a regression rather than a pre-existing gap. `write` used to carry
 * `if (ref.kind === "state" && (await missingFolders()).length > 0)`, and narrowing the
 * parameter made that comparison a compile error, so the check *moved* into `saveStateFile` and
 * `write` was left with no layout check covering a State File at all. "Nothing is written into a
 * folder the student has not agreed to" (docs/design.md, "Storage") was then enforced in exactly
 * one place, and this route went around it.
 */
it("refuses a cast whole-file write of a State File into a folder that is not a Workspace", async () => {
  const workspace = fileSystemWorkspace(root);

  await expect(wholeFileWrite(workspace)(ALICE, { schemaVersion: 1 } as never)).rejects.toThrow(
    WorkspaceRefusedError,
  );
  expect(await readdir(root)).toEqual([]);
});

/**
 * The same hole with a different key, found by a reviewer of this change and measured: a
 * `CatalogRef` is narrowed by *kind* only, and its year becomes a file name directly, so a cast
 * that makes the year `"../alice.state"` builds a path back out of `catalogs/` and onto a State
 * File at the Workspace root — overwritten whole, with no revision guard, no name rule and no
 * layout check. #113's second criterion says a State File may not reach such a write by **any**
 * route, so the shared refusal checks that a Catalog's year really is one.
 */
it("refuses a Catalog whose year is a path rather than a year, cast past the type", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.saveStateFile(ALICE, firstSave(STATE));
  const pathAsYear = { kind: "catalog", academicYear: "../alice.state" } as unknown as WorkspaceRef;

  await expect(wholeFileWrite(workspace)(pathAsYear, { schemaVersion: 1 } as never)).rejects.toThrow(
    WorkspaceRefusedError,
  );
  await expect(wholeFileRead(workspace)(pathAsYear)).rejects.toThrow(WorkspaceRefusedError);

  // the State File the crafted year resolved to is untouched
  expect((await workspace.readStateFile(ALICE))?.data).toEqual(STATE);
  expect((await readdir(root)).sort()).toEqual([
    ".backups",
    "alice.state.json",
    "catalogs",
    "requirements",
  ]);
});

/**
 * And into a folder that is not a Workspace by that route either, which is the sentence #113
 * quotes from docs/design.md, "Storage".
 */
it("refuses a cast year that would write a State File into a folder that is not a Workspace", async () => {
  await mkdir(join(root, "catalogs"));
  const workspace = fileSystemWorkspace(root);
  const pathAsYear = { kind: "catalog", academicYear: "../alice.state" } as unknown as WorkspaceRef;

  await expect(wholeFileWrite(workspace)(pathAsYear, { schemaVersion: 1 } as never)).rejects.toThrow(
    WorkspaceRefusedError,
  );
  expect(await readdir(root)).toEqual(["catalogs"]);
});

/**
 * And the read, in the same words, although the cost is smaller: content rather than a lost
 * file. A State File read this way comes back with no revision, which is content nothing can
 * safely save afterwards — the trap the narrowing exists to set a compiler against.
 */
it("refuses a whole-file read of a State File, which would come back with no revision", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await workspace.saveStateFile(ALICE, firstSave(STATE));

  await expect(wholeFileRead(workspace)(ALICE)).rejects.toThrow(WorkspaceRefusedError);
  // the same refusal the in-memory double makes, in the same words (app/src/workspace.memory.test.ts)
  await expect(wholeFileRead(workspace)(ALICE)).rejects.toThrow(
    /refusing the State File "alice" here/,
  );
});

/**
 * #121's reachable door, and the one the ticket was really filed for. `usablePath` asks whether
 * a folder of the layout resolves inside the Workspace and not what it *is*, so a `catalogs`
 * that is a plain file is usable, counts towards the layout, and makes `status` report the
 * Workspace **ready** — and the Catalog write then opened its temporary below that file and met
 * a raw `ENOTDIR`. A ready Workspace producing a raw filesystem error is the unnamed 500 by a
 * different door from the unreachable one the ticket is named after.
 */
it("refuses a Catalog when catalogs is a file rather than a folder, and says which folder", async () => {
  await mkdir(join(root, "requirements"));
  await mkdir(join(root, ".backups"));
  await writeFile(join(root, "catalogs"), "not a folder");
  const workspace = fileSystemWorkspace(root);

  // the setup, asserted rather than assumed: this is what makes the write below reachable
  expect(await workspace.status()).toEqual({ ready: true, missing: [] });

  const refusal = await workspace
    .write({ kind: "catalog", academicYear: 2027 }, CATALOG)
    .catch((error: unknown) => error);

  expect(refusal).toBeInstanceOf(NotAWorkspaceError);
  expect((refusal as NotAWorkspaceError).folder).toBe("catalogs");
  expect((refusal as Error).message).toMatch(/catalogs is there and is not a folder/);
  // refused before a byte is written, so what the student is told is the layout mistake rather
  // than the filesystem's word for its consequence
  expect((refusal as Error).message).not.toMatch(/ENOTDIR/);
  // and the file it would have written below is exactly as it was
  expect(await readFile(join(root, "catalogs"), "utf8")).toBe("not a folder");
});

/**
 * The same file met from the other side. With one part of the layout a file and another
 * genuinely missing, `status` is not ready, the student is offered the layout, and accepting it
 * reaches `mkdir` — which is `EEXIST` for a name a plain file holds. Raw, that is the same
 * unnamed 500 one function further along, so it is refused by name too (#121).
 */
it("refuses to create the layout when a name it needs is held by a file", async () => {
  await writeFile(join(root, "catalogs"), "not a folder");
  const workspace = fileSystemWorkspace(root);

  expect(await workspace.status()).toEqual({ ready: false, missing: ["requirements", "backups"] });

  await expect(workspace.create()).rejects.toThrow(WorkspaceRefusedError);
  await expect(workspace.create()).rejects.toThrow(/catalogs could not be made \(EEXIST\)/);
  // nothing half-made: the folders it had not reached are still not there
  expect(await readdir(root)).toEqual(["catalogs"]);
});

/**
 * The other of the two `contained` refusals in `saveStateFile`, which the test above does not
 * reach: that one gets past `contained` — the root exists, so the file's parent resolves — and
 * is refused by the outright layout question. This one has no root at all, so `contained` itself
 * answers `missing`. Both were the same plain `Error` (#121).
 */
it("refuses a State File save when the Workspace root is not there at all", async () => {
  const workspace = fileSystemWorkspace(join(root, "never-created"));

  await expect(workspace.saveStateFile(ALICE, firstSave(STATE))).rejects.toThrow(NotAWorkspaceError);
  // and it made no root on the way to refusing
  expect(await readdir(root)).toEqual([]);
});

/**
 * A write fails, and then the cleanup of its own temporary fails too. `rm` with `force` covers a
 * temporary that is not there and nothing else, so its error used to replace the refusal and
 * leave the port raw — the third door of #121, and the one the sweep below found rather than a
 * reading of the code. A directory holding the temporary's name reaches it with no permission
 * trick: `writeFile` cannot write a directory, and `rm` without `recursive` cannot remove one.
 *
 * What the student loses is a stray temporary, which is in no listing and whose name says which
 * write it was of. What they gain is being told why the write failed.
 */
it("refuses when the cleanup of its own temporary cannot be made either", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  const temporary = join(root, "catalogs", `.tmp-${process.pid}-2027.json`);
  await mkdir(temporary);

  await expect(workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG)).rejects.toThrow(
    WorkspaceRefusedError,
  );

  // the Catalog was not written, and the temporary that could not be cleaned up is still there
  expect(await workspace.read({ kind: "catalog", academicYear: 2027 })).toBeUndefined();
  expect(await readdir(join(root, "catalogs"))).toEqual([`.tmp-${process.pid}-2027.json`]);
});

/**
 * **The property rather than one more example of it**, and #121's fourth criterion answered
 * where these tests can answer it: every refusal this port makes is one the boundary catches by
 * name, so nothing out of it can become an unnamed 500 in `server/src/api.ts`.
 *
 * A sweep over the ways a write can fail rather than a list of the ones known to fail, because
 * the hole this closes was not a missing case in a list — it was a refusal with no type at all,
 * and it sat in the same three functions a list would have been drawn from. An operation that
 * *succeeds* here is not a failure of the test: several of these Workspaces are broken only for
 * one of the three, and the claim is about what comes back when one refuses.
 *
 * `StateFileChangedError` is the other name the boundary knows, and none of these produces one:
 * that refusal is about a revision, is covered where the guard is, and is a 409 by its own arm.
 */
const brokenWorkspaces: [string, (at: string) => Promise<string>][] = [
  ["a folder nobody has made a Workspace", async (at) => at],
  ["a root that is not there at all", async (at) => join(at, "never-created")],
  [
    "a catalogs that is a file rather than a folder",
    async (at) => {
      await mkdir(join(at, "requirements"));
      await mkdir(join(at, ".backups"));
      await writeFile(join(at, "catalogs"), "not a folder");
      return at;
    },
  ],
  [
    "a Catalog's own name held by a directory, so the rename cannot be made",
    async (at) => {
      await mkdir(join(at, "catalogs", "2027.json"), { recursive: true });
      await mkdir(join(at, "requirements"));
      await mkdir(join(at, ".backups"));
      return at;
    },
  ],
];

it.each(brokenWorkspaces)(
  "refuses by a name the boundary knows, never with a plain Error: %s",
  async (_what, setUp) => {
    const workspace = fileSystemWorkspace(await setUp(root));

    // `create` last, because it is the one that would repair the Workspace under the others
    const attempts = [
      () => workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG),
      () => workspace.saveStateFile(ALICE, firstSave(STATE)),
      () => workspace.create(),
    ];
    let refusals = 0;
    for (const attempt of attempts) {
      const thrown: unknown = await attempt().then(
        () => undefined,
        (error: unknown) => error,
      );
      if (thrown === undefined) continue;
      expect(thrown).toBeInstanceOf(WorkspaceRefusedError);
      refusals += 1;
    }
    // A property of what was thrown is worth nothing without something thrown: every one of
    // these Workspaces is broken for at least one of the three, and a setup that stopped being
    // broken would otherwise turn this into the vacuous pass #109 named.
    expect(refusals).toBeGreaterThan(0);
  },
);

/**
 * The mode-bit half, out of the sweep and skipped rather than trusted, because root writes
 * whatever the mode says and a bare `if` inside the sweep's setup made it *pass* there — a
 * healthy Workspace, three operations that succeed, and nothing asserted. That is the vacuous
 * pass #109 named, and it was in the test written to prevent it. `skipIf` is what the rest of
 * this file and server/src/token.test.ts use, and it reports as skipped.
 *
 * Both writes, because they are the two `describeRef` words differently and the State File is
 * the one with a student's edits behind it: a `catalogs` nothing may write into for the Catalog,
 * and a root nothing may write into for the State File.
 */
it.skipIf(!unreadableFilesArePossible)(
  "refuses by name when the Workspace is one nothing may write into",
  async () => {
    const workspace = fileSystemWorkspace(root);
    await workspace.create();
    await chmod(join(root, "catalogs"), 0o500);

    const catalog = await workspace
      .write({ kind: "catalog", academicYear: 2027 }, CATALOG)
      .catch((error: unknown) => error);
    expect(catalog).toBeInstanceOf(WorkspaceRefusedError);
    expect((catalog as Error).message).toMatch(
      /refusing to write the Catalog for the Academic Year 2027: it could not be written \(EACCES\)/,
    );

    await chmod(root, 0o500);
    const state = await workspace
      .saveStateFile(ALICE, firstSave(STATE))
      .catch((error: unknown) => error);
    expect(state).toBeInstanceOf(WorkspaceRefusedError);
    // the State File named as a State File, which is the other half of `describeRef`
    expect((state as Error).message).toMatch(
      /refusing to write the State File "alice": it could not be written \(EACCES\)/,
    );
    // no path in what a caller could pass on as a Warning, and the filesystem's own error —
    // which does carry the absolute path — kept where only a log can reach it
    expect((state as Error).message).not.toContain(root);
    expect((state as Error).cause).toBeInstanceOf(Error);

    // so the temporary directory can be cleaned up after this test
    await chmod(root, 0o700);
    await chmod(join(root, "catalogs"), 0o700);
  },
);
