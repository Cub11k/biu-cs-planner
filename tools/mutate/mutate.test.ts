import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyLiteral, mutate, readSpec, table, unexpectedSurvivors, type Mutation, type Ports } from "./mutate.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAIN = join(ROOT, "tools/mutate/main.ts");
const run = promisify(execFile);

const mutation = (over: Partial<Mutation> = {}): Mutation => ({
  name: "flip",
  file: "a.ts",
  from: "true",
  to: "false",
  tests: ["a.test.ts"],
  ...over,
});

/** Ports over an in-memory tree whose `HEAD` is `head`, recording every call. */
function memory(head: Record<string, string>, verdicts: Ports["runTests"]) {
  const files = { ...head };
  const calls: string[] = [];
  const ports: Ports = {
    read: async (file) => files[file] ?? "",
    write: async (file, text) => {
      calls.push(`write ${file}`);
      files[file] = text;
    },
    restore: async (file, original) => {
      calls.push(`restore ${file}`);
      files[file] = original;
    },
    runTests: async (tests) => {
      calls.push(`run ${tests.join(",")} on ${JSON.stringify(files)}`);
      return verdicts(tests);
    },
  };
  return { files, calls, ports };
}

describe("applyLiteral", () => {
  it("replaces the one occurrence, as a literal string", () => {
    expect(applyLiteral("a.*b", ".*", "+")).toBe("a+b");
  });

  it("refuses a `from` the file does not hold", () => {
    expect(() => applyLiteral("abc", "x", "y")).toThrow("not found");
  });

  it("refuses a `from` the file holds twice, since it does not say which", () => {
    expect(() => applyLiteral("x x", "x", "y")).toThrow("more than once");
  });
});

describe("readSpec", () => {
  it("reads a spec's mutations", () => {
    expect(readSpec(JSON.stringify({ mutations: [mutation()] }))).toEqual([mutation()]);
  });

  it("refuses a mutation that names no test", () => {
    expect(() => readSpec(JSON.stringify({ mutations: [mutation({ tests: [] })] }))).toThrow();
  });
});

describe("mutate", () => {
  it("runs each mutation's tests on the mutated file and restores it, caught or not", async () => {
    const { files, calls, ports } = memory({ "a.ts": "x = true" }, async (tests) =>
      tests[0] === "catches.test.ts" ? { caught: true, failing: "it notices" } : { caught: false },
    );
    const outcomes = await mutate(
      [mutation({ tests: ["catches.test.ts"] }), mutation({ name: "missed", tests: ["misses.test.ts"] })],
      ports,
    );
    expect(calls).toEqual([
      "write a.ts",
      'run catches.test.ts on {"a.ts":"x = false"}',
      "restore a.ts",
      "write a.ts",
      'run misses.test.ts on {"a.ts":"x = false"}',
      "restore a.ts",
    ]);
    expect(files["a.ts"]).toBe("x = true");
    expect(outcomes.map((outcome) => outcome.caught)).toEqual([true, false]);
  });

  it("restores the file when the test run throws", async () => {
    const { files, ports } = memory({ "a.ts": "x = true" }, async () => {
      throw new Error("interrupted");
    });
    await expect(mutate([mutation()], ports)).rejects.toThrow("interrupted");
    expect(files["a.ts"]).toBe("x = true");
  });
});

describe("unexpectedSurvivors and table", () => {
  const outcomes = [
    { mutation: mutation({ name: "caught" }), caught: true, failing: "a.test.ts > it notices" },
    { mutation: mutation({ name: "announced", expected: "survives" }), caught: false },
    { mutation: mutation({ name: "missed" }), caught: false },
  ];

  it("fails only on a survivor the spec did not announce", () => {
    expect(unexpectedSurvivors(outcomes).map((outcome) => outcome.mutation.name)).toEqual(["missed"]);
  });

  it("prints each mutation's result and failing test", () => {
    expect(table(outcomes).split("\n")).toEqual([
      "mutation   result               failing test",
      "caught     caught               a.test.ts > it notices",
      "announced  survived (expected)",
      "missed     SURVIVED",
    ]);
  });
});

/**
 * The command itself, in a throwaway repository holding one module and one test of it, with this
 * repository's `node_modules` linked in so its Vitest runs there.
 */
describe("npm run mutate", () => {
  let repo: string;

  const git = (...args: string[]) => run("git", args, { cwd: repo });

  async function repository(test: string): Promise<void> {
    repo = await mkdtemp(join(tmpdir(), "mutate-test-"));
    await symlink(join(ROOT, "node_modules"), join(repo, "node_modules"));
    await writeFile(join(repo, ".gitignore"), "node_modules\n");
    await writeFile(join(repo, "a.ts"), "export const answer = 42;\n");
    await writeFile(join(repo, "a.test.ts"), test);
    await writeFile(join(repo, "package.json"), '{ "type": "module" }\n');
    await git("init", "-q");
    await git("add", ".");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  }

  const spec = async (mutations: Mutation[]): Promise<string> => {
    const path = join(repo, "spec.json");
    await writeFile(path, JSON.stringify({ mutations }));
    return path;
  };

  const command = (specPath: string) =>
    run("node", [MAIN, specPath], { cwd: repo }).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const ANSWER_TEST = 'import { expect, it } from "vitest";\nimport { answer } from "./a.ts";\nit("answers", () => expect(answer).toBe(42));\n';

  it("exits non-zero on a surviving mutation, and leaves every file as HEAD has it", async () => {
    await repository(ANSWER_TEST);
    const result = await command(
      await spec([
        mutation({ name: "caught", from: "42", to: "41", file: "a.ts", tests: ["a.test.ts"] }),
        mutation({ name: "survives", from: "answer", to: "answer /* */", file: "a.ts", tests: ["a.test.ts"] }),
      ]),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/caught\s+caught\s+a\.test\.ts > answers/);
    expect(result.stdout).toMatch(/survives\s+SURVIVED/);
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("export const answer = 42;\n");
  }, 60_000);

  it("counts no failure from a file the spec did not name, though Vitest ran it too", async () => {
    await repository(ANSWER_TEST);
    // `a.test.ts` is a filter Vitest also matches against `data.test.ts`
    await writeFile(join(repo, "data.test.ts"), 'import { expect, it } from "vitest";\nit("fails", () => expect(1).toBe(2));\n');
    await git("add", ".");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "unrelated failure");
    const result = await command(await spec([mutation({ name: "survives", from: "answer", to: "answer /* */" })]));
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/survives\s+SURVIVED/);
  }, 60_000);

  it("refuses a tree with uncommitted changes", async () => {
    await repository(ANSWER_TEST);
    await writeFile(join(repo, "a.ts"), "export const answer = 43;\n");
    const result = await command(await spec([mutation({ from: "43", to: "41" })]));
    expect(result.code).toBe(2);
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("export const answer = 43;\n");
  }, 60_000);

  it("restores the mutated file when interrupted mid-run", async () => {
    // A test that does not finish until it is told to, so the interrupt lands mid-run.
    await repository(
      'import { it } from "vitest";\nit("waits", () => new Promise(() => {}), 60_000);\n',
    );
    const child = spawn("node", [MAIN, await spec([mutation({ from: "42", to: "41" })])], { cwd: repo });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    // The mutated file on disk is the visible state change this waits on.
    while ((await readFile(join(repo, "a.ts"), "utf8")).includes("42")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("export const answer = 42;\n");
  }, 60_000);
});
