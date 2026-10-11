import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runVitest } from "../test-run/vitest.ts";
import { parseArgs, repeat, screenshotsIn, type Attempt } from "./repeat.ts";

/**
 * `npm run test:repeat -- <test file> [--times N] [--load]` (#364). Runs the file N times (20
 * unless told), with `--load` keeping one CPU-burning process per core busy for the whole
 * search, and prints exact pass and fail counts. The first failing run's reporter output, and
 * the failure screenshots that output names, are copied to a folder it prints.
 */
let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const root = process.cwd();
const burners: ChildProcess[] = [];
let child: ChildProcess | undefined;
// Every way out stops the burners and the run in flight; a SIGKILL is the one this cannot catch.
process.on("exit", () => [...burners, child].forEach((running) => running?.kill("SIGKILL")));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(130));

if (options.load) {
  for (let core = 0; core < availableParallelism(); core += 1) {
    burners.push(spawn(process.execPath, ["-e", "for (;;) {}"], { stdio: "ignore" }));
  }
}

const tally = await repeat(
  options.times,
  async (index) => {
    const { output, run } = await runVitest(root, [options.file], (running) => (child = running));
    if (run === undefined || run.total === 0) {
      console.error(`run ${index} collected no tests from ${options.file}, so it proves nothing:\n${output}`);
      process.exit(2);
    }
    const passed = run.failed.length === 0 && run.brokenFiles.length === 0;
    process.stdout.write(passed ? "." : "F");
    return { passed, output, failed: [...run.failed, ...run.brokenFiles] } satisfies Attempt;
  },
  async (attempt, index) => {
    const kept = await mkdtemp(join(tmpdir(), "test-repeat-"));
    await writeFile(join(kept, "output.txt"), attempt.output);
    for (const file of screenshotsIn(attempt.output)) {
      // a screenshot that is not there is said, not allowed to end the search and lose its tally
      await cp(join(root, file), join(kept, basename(file))).catch(() => console.error(`\nno screenshot at ${file}`));
    }
    console.error(`\nrun ${index} failed; its output is kept in ${kept}`);
  },
);

console.log(`\n${options.file}: ${tally.passed} passed, ${tally.failed} failed, of ${options.times} runs${options.load ? " under load" : ""}`);
for (const [name, count] of Object.entries(tally.failures)) console.log(`  failed ${count}x: ${name}`);
process.exit(tally.failed > 0 ? 1 : 0);
