import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BackupRefusedError, WorkspaceRefusedError, type Workspace } from "@biu-cs-planner/app";
import { createApi } from "./api.ts";
import { loggingWorkspace, refusalLine } from "./debug.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

/**
 * #165, as ruled: a caught refusal is logged nowhere unless the server runs with `--debug`, and
 * then to stderr with its reason code, errno and `cause` — the absolute Workspace path allowed,
 * the launch token never. The flag itself is parsed in `./cli.test.ts`; this is what it turns on.
 */

const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-debug-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A filesystem error as Node raises one: a code, and a message carrying the absolute path. */
const fsError = (code: string, path: string): Error =>
  Object.assign(new Error(`${code}: permission denied, open '${path}'`), { code });

it("writes a refusal's reason code, errno and cause, absolute path included", () => {
  const path = "/home/alice/Workspace/catalogs/2027.json";
  const refusal = new WorkspaceRefusedError(
    { reason: "unreadable", subject: { kind: "catalog", academicYear: 2027 } },
    "refusing the Catalog for the Academic Year 2027: it is there and cannot be read (EACCES)",
    { cause: fsError("EACCES", path) },
  );

  expect(refusalLine("read", refusal, TOKEN)).toBe(
    `biu-cs-planner debug: read refused (unreadable) errno=EACCES cause: Error: EACCES: permission denied, open '${path}'`,
  );
});

it("follows the cause chain to the errno, as a backup refusal wraps the one below it", () => {
  const inner = new WorkspaceRefusedError(
    { reason: "unwritable", subject: { kind: "folder", folder: "backups" } },
    "refusing the folder holding the Workspace's snapshots: it could not be written (ENOSPC)",
    { cause: fsError("ENOSPC", "/home/alice/Workspace/.backups") },
  );

  const line = refusalLine("a save", new BackupRefusedError(inner), TOKEN);

  expect(line).toContain("errno=ENOSPC");
  expect(line).toContain("/home/alice/Workspace/.backups");
});

it("never writes the launch token, whatever put it in a refusal", () => {
  const refusal = new WorkspaceRefusedError(
    { reason: "unreadable", subject: { kind: "catalog", academicYear: 2027 } },
    "refused",
    { cause: new Error(`a cause that somehow holds ${TOKEN} twice: ${TOKEN}`) },
  );

  const line = refusalLine("read", refusal, TOKEN);

  expect(line).not.toContain(TOKEN);
  expect(line).toContain("[launch token]");
});

it("still writes a line when nothing can be read off the refusal", () => {
  const unreadable = Object.create(WorkspaceRefusedError.prototype, {
    refusal: {
      get() {
        throw new Error("no");
      },
    },
  }) as WorkspaceRefusedError;

  expect(refusalLine("read", unreadable, TOKEN)).toBe(
    "biu-cs-planner debug: read refused (no reason code) errno=none",
  );
});

it("logs each refusal the port raises and rethrows it unchanged, and logs nothing else", async () => {
  const refusal = new WorkspaceRefusedError(
    { reason: "unreadable", subject: { kind: "catalog", academicYear: 2027 } },
    "refused",
  );
  const crash = new Error("not a refusal");
  let next: Error | undefined = refusal;
  const real = fileSystemWorkspace(root);
  const throwing: Workspace = {
    ...real,
    read: () => (next === undefined ? Promise.resolve(undefined) : Promise.reject(next)),
  };
  const lines: string[] = [];
  const logged = loggingWorkspace(throwing, (line) => lines.push(line), TOKEN);

  // the very error, so every caller catches and answers what it would have without --debug
  await expect(logged.read({ kind: "catalog", academicYear: 2027 })).rejects.toBe(refusal);
  expect(lines).toEqual(["biu-cs-planner debug: read refused (unreadable) errno=none"]);

  // a throw that is not a refusal is not caught by `app`, so it was never silent: not logged here
  next = crash;
  await expect(logged.read({ kind: "catalog", academicYear: 2027 })).rejects.toBe(crash);
  next = undefined;
  await expect(logged.read({ kind: "catalog", academicYear: 2027 })).resolves.toBeUndefined();
  expect(lines).toHaveLength(1);
});

/**
 * Through the API and the real adapter: the page's answer is byte for byte what it is without
 * `--debug`, and only the terminal learns where the file is.
 */
it("leaves the page's answer unchanged and tells only the log where the file is", async () => {
  const plain = createApi({ workspace: fileSystemWorkspace(root), token: TOKEN, changes: { changeCount: () => 0 } });
  const lines: string[] = [];
  const debugging = createApi({
    workspace: loggingWorkspace(fileSystemWorkspace(root), (line) => lines.push(line), TOKEN),
    token: TOKEN,
    changes: { changeCount: () => 0 },
  });
  const bearer = { Authorization: `Bearer ${TOKEN}` };
  await plain.request("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json", ...bearer }, body: "{}" });
  // a directory where the Catalog belongs: refused, with no permission trick, on every runner
  await mkdir(join(root, "catalogs", "2027.json"));
  const route = "/api/catalog/2027/offerings?semester=fall";

  const without = await plain.request(route, { headers: bearer });
  const withDebug = await debugging.request(route, { headers: bearer });

  expect(withDebug.status).toBe(409);
  expect(withDebug.status).toBe(without.status);
  const body = await withDebug.text();
  expect(body).toBe(await without.text());
  expect(body).not.toContain(root);
  expect(lines).toEqual([
    `biu-cs-planner debug: read refused (unreadable) errno=none cause: Error: ${join(root, "catalogs", "2027.json")} is not a regular file (a directory)`,
  ]);
  expect(lines.join("\n")).not.toContain(TOKEN);
});
