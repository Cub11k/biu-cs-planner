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
