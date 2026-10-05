import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackupRefusedError, StateFileChangedError, WorkspaceRefusedError, type Workspace } from "@biu-cs-planner/app";
import { createApi } from "./api.ts";
import { failureLine, loggingWorkspace, refusalLine } from "./debug.ts";
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

it("logs every error the port raises and rethrows it unchanged, the external-edit guard excepted", async () => {
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

  // a throw that is not a refusal: since #344 a read after a landed save swallows it, so it is logged (#357)
  next = crash;
  await expect(logged.read({ kind: "catalog", academicYear: 2027 })).rejects.toBe(crash);
  expect(lines[1]).toBe("biu-cs-planner debug: read failed (Error: not a refusal) errno=none");

  // the external-edit guard is the page's to say, and has nothing for this log
  const changed = new StateFileChangedError("me", { basedOn: undefined, found: undefined });
  next = changed;
  await expect(logged.read({ kind: "catalog", academicYear: 2027 })).rejects.toBe(changed);
  next = undefined;
  await expect(logged.read({ kind: "catalog", academicYear: 2027 })).resolves.toBeUndefined();
  expect(lines).toHaveLength(2);
});

it("writes a failure's message, errno and cause, and never the launch token", () => {
  const failure = Object.assign(new Error(`EIO: i/o error, read (token ${TOKEN})`), {
    code: "EIO",
    cause: new Error(`below: ${TOKEN}`),
  });

  const line = failureLine("list", failure, TOKEN);

  expect(line).toBe(
    "biu-cs-planner debug: list failed (Error: EIO: i/o error, read (token [launch token])) errno=EIO cause: Error: below: [launch token]",
  );
  expect(failureLine("list", "a string thrown", TOKEN)).toBe(
    "biu-cs-planner debug: list failed (a string thrown) errno=none",
  );
});

/**
 * #357 through the API: a Plan edit lands, then `requirements/` fails with an error that is not a
 * refusal. The answer is the landed edit either way (#344); with `--debug` the terminal learns why
 * the Plan came back unchecked, the token scrubbed, and without it nothing is written anywhere.
 */
it("logs a failure after a landed save under --debug, and nothing without it", async () => {
  const real = fileSystemWorkspace(root);
  let failing = false;
  const flaky: Workspace = new Proxy(real, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (property !== "list" || typeof method !== "function") return method;
      return async (...args: unknown[]): Promise<unknown> => {
        if (failing) throw Object.assign(new Error(`EIO: i/o error, scandir (${TOKEN})`), { code: "EIO" });
        return (method as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const bearer = { Authorization: `Bearer ${TOKEN}` };
  const lines: string[] = [];
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const debug of [false, true]) {
      const api = createApi({
        workspace: debug ? loggingWorkspace(flaky, (line) => lines.push(line), TOKEN) : flaky,
        token: TOKEN,
        changes: { changeCount: () => 0 },
      });
      const send = (method: string, path: string, body: unknown) =>
        api.request(path, { method, headers: { "Content-Type": "application/json", ...bearer }, body: JSON.stringify(body) });
      failing = false;
      await send("POST", "/api/workspace", {});
      const plan = (await (await api.request("/api/plan", { headers: bearer })).json()) as { version?: string };
      const chosen = await send("PUT", "/api/programs", { programs: [{ requirementsFile: "cs-2027" }], basedOn: plan.version });
      const { version } = (await chosen.json()) as { version: string };

      failing = true;
      const answer = await send("POST", "/api/plan/attempts", {
        courseNumber: "89-110",
        academicYear: 2027,
        semester: "fall",
        status: "planned",
        basedOn: version,
      });

      expect(answer.status).toBe(200);
      await expect(answer.json()).resolves.toMatchObject({ programWarnings: [{ kind: "requirements-unlisted" }] });
      if (!debug) expect(lines).toEqual([]);
    }

    expect(lines).toEqual(["biu-cs-planner debug: list failed (Error: EIO: i/o error, scandir ([launch token])) errno=EIO"]);
    // the log is the only place it went: nothing reached the terminal by any other road
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
  }
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

/**
 * The decorator is a pass-through: the adapter is handed the very arguments the caller passed and
 * the caller gets the adapter's answer back unchanged. One trap serves every method, so a write is
 * as good a witness as any — and it is a Catalog write rather than a save because a save is
 * `editStateFile`'s alone, which `tools/ci/state-file-writer.ts` holds every test to. That scanner
 * cannot see inside a Proxy trap, so this test is what keeps `loggingWorkspace` from being a
 * writer of its own.
 */
it("hands every call to the adapter untouched and its answer back unchanged", async () => {
  const real = fileSystemWorkspace(root);
  await real.create();
  const received: unknown[][] = [];
  const answer = Promise.resolve();
  const recording: Workspace = {
    ...real,
    write: (...args) => {
      received.push(args);
      return answer;
    },
  };
  const logged = loggingWorkspace(recording, () => {}, TOKEN);
  const ref = { kind: "catalog", academicYear: 2027 } as const;
  const data = { schemaVersion: 1 };

  const returned = logged.write(ref, data);

  expect(received).toEqual([[ref, data]]);
  expect(received[0]![0]).toBe(ref);
  expect(received[0]![1]).toBe(data);
  await expect(returned).resolves.toBeUndefined();
});

it("leaves a synchronous method synchronous, and still logs its refusal", () => {
  const refusal = new WorkspaceRefusedError(
    { reason: "unreadable", subject: { kind: "workspace" } },
    "refused",
  );
  const lines: string[] = [];
  const port = {
    answer: () => 42,
    refuse: (): never => {
      throw refusal;
    },
  };
  const logged = loggingWorkspace(port as unknown as Workspace, (line) => lines.push(line), TOKEN) as unknown as typeof port;

  expect(logged.answer()).toBe(42);
  expect(() => logged.refuse()).toThrow(refusal);
  expect(lines).toEqual(["biu-cs-planner debug: refuse refused (unreadable) errno=none"]);
});
