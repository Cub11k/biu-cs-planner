import { execFile, type ChildProcess } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runVitest } from "../test-run/vitest.ts";
import { mutate, readSpec, table, unexpectedSurvivors, type Verdict } from "./mutate.ts";

/**
 * `npm run mutate -- <spec.json>` (#364). The spec is
 * `{ "mutations": [{ "name", "file", "from", "to", "tests": [...], "expected"?: "survives" }] }`.
 *
 * Refuses a tree with uncommitted changes to tracked files, because every mutated file is put
 * back as it was read, which on a clean tree is `HEAD` (`orchestration.md`, "Commit before you
 * mutate"). An interrupt stops the test run and restores the file before exiting. Exits 1 when a
 * mutation survived unannounced.
 */
const git = promisify(execFile);

const specPath = process.argv[2];
if (specPath === undefined) {
  console.error("usage: npm run mutate -- <spec.json>");
  process.exit(2);
}

const root = (await git("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
const dirty = (await git("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root })).stdout;
if (dirty !== "") {
  console.error(`refusing: the tree has uncommitted changes; commit first, so nothing a mutation touches is unsaved\n${dirty}`);
  process.exit(2);
}

const mutations = readSpec(await readFile(specPath, "utf8"));

const headOf = async (file: string): Promise<string> =>
  (await git("git", ["show", `HEAD:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;

/** The file on disk mutated now, and its text before the mutation. */
let mutated: { file: string; original: string } | undefined;
let child: ChildProcess | undefined;
let stopping = false;

const interrupted = async (): Promise<never> => {
  stopping = true; // the loop may still be running: nothing more is written after this
  child?.kill("SIGTERM");
  if (mutated !== undefined) await writeFile(join(root, mutated.file), mutated.original);
  console.error(mutated === undefined ? "interrupted" : `interrupted; restored ${mutated.file}`);
  process.exit(130);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void interrupted());

const outcomes = await mutate(mutations, {
  read: async (file) => {
    await headOf(file); // a file HEAD does not have is not committed work: refuse it up front
    if ((await lstat(join(root, file))).isSymbolicLink()) throw new Error(`refusing a symbolic link: ${file}`);
    return readFile(join(root, file), "utf8");
  },
  write: async (file, text) => {
    if (stopping) throw new Error("interrupted");
    mutated = { file, original: await readFile(join(root, file), "utf8") };
    await writeFile(join(root, file), text);
  },
  restore: async (file, original) => {
    await writeFile(join(root, file), original);
    mutated = undefined;
  },
  runTests: async (tests): Promise<Verdict> => {
    const { output, run } = await runVitest(root, tests, (running) => (child = running));
    // Vitest reads each name as a filter, so `a.test.ts` also runs `data.test.ts`: only the files
    // the spec names may catch the mutation.
    const named = (path: string) => tests.includes(path);
    if (run === undefined || !Object.keys(run.perFile).some(named)) {
      throw new Error(`the tests did not run, so this mutation proves nothing: ${tests.join(" ")}\n${output}`);
    }
    const failing = run.failed.find((name) => tests.some((test) => name.startsWith(`${test} > `)));
    if (failing !== undefined) return { caught: true, failing };
    const broken = run.brokenFiles.find(named);
    if (broken !== undefined) return { caught: true, failing: `${broken} (did not load)` };
    return { caught: false };
  },
});

console.log(table(outcomes));
const survivors = unexpectedSurvivors(outcomes);
if (survivors.length > 0) {
  console.error(`\n${survivors.length} mutation(s) survived that the spec did not expect to`);
  process.exit(1);
}
