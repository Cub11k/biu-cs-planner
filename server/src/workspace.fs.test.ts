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
import { StateFileChangedError, WorkspaceRefusedError } from "@biu-cs-planner/app";
import { fileSystemWorkspace } from "./workspace.fs.ts";

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

/** A watcher on `root`, counting raw events, stopped for you when the test ends. */
async function watching(): Promise<{ events: () => number; stop: () => void }> {
  const workspace = fileSystemWorkspace(root);
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
 * A State File's temporary is written at the Workspace root rather than in a folder of the
 * layout, so the cleanup that keeps a failed save from littering the Workspace has a path of
 * its own. The failure has to come from the *rename* for that path to run at all: a value
 * `JSON.stringify` rejects never reaches the filesystem, and a root a write cannot open never
 * gets a temporary to clean up. A directory where the file belongs is a rename that cannot be
 * made with the temporary already written — which is the only shape that proves the `rm`.
 */
it("cleans up its temporary when the rename it needs cannot be made", async () => {
  const workspace = fileSystemWorkspace(root);
  await workspace.create();
  await mkdir(join(root, "alice.state.json"));

  await expect(workspace.saveStateFile(ALICE, firstSave(STATE))).rejects.toThrow();

  expect((await readdir(root)).sort()).toEqual([
    ".backups",
    "alice.state.json",
    "catalogs",
    "requirements",
  ]);
});

/**
 * A State File sits at the root, and a root exists whether or not the folder is a Workspace,
 * so the refusal a Catalog gets from the folder that is not there has to be made outright for
 * this one. Nothing is written into a folder the student has not agreed to (docs/design.md).
 */
it("refuses to write a State File into a folder that is not a Workspace yet", async () => {
  const workspace = fileSystemWorkspace(root);

  await expect(workspace.saveStateFile(ALICE, firstSave(STATE))).rejects.toThrow(
    /layout does not exist/,
  );
  expect(await readdir(root)).toEqual([]);
});
