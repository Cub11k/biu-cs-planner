import { chmod, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
