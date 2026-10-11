import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * One Vitest run, read back from its JSON report: the reading `npm run mutate`,
 * `npm run test:repeat` and `npm run test:counts` share (#364, #371).
 *
 * The report is read rather than the exit code alone, because a non-zero exit is also what a
 * misspelt test path gives ("No test files found"), and a mutation "caught" that way, or a
 * repeat "failing" that way, would be a claim nothing tested.
 */
export type Run = {
  /** Tests the run collected, every status included. */
  readonly total: number;
  /** The full name of every test that failed, in report order. */
  readonly failed: readonly string[];
  /** Tests collected per file, keyed by the file's path relative to the run's root. */
  readonly perFile: Readonly<Record<string, number>>;
  /** Files that failed without a failing test: an import that threw, a suite that crashed. */
  readonly brokenFiles: readonly string[];
};

type JsonReport = {
  numTotalTests: number;
  testResults: {
    name: string;
    status: string;
    assertionResults: { status: string; fullName: string }[];
  }[];
};

/** A Vitest JSON report as a `Run`. Pure. */
export function readReport(json: string, root: string): Run {
  const report = JSON.parse(json) as JsonReport;
  const perFile: Record<string, number> = {};
  const failed: string[] = [];
  const brokenFiles: string[] = [];
  for (const file of report.testResults) {
    const path = relative(root, file.name);
    perFile[path] = file.assertionResults.length;
    const failing = file.assertionResults.filter((test) => test.status === "failed");
    failed.push(...failing.map((test) => `${path} > ${test.fullName}`));
    if (file.status === "failed" && failing.length === 0) brokenFiles.push(path);
  }
  return { total: report.numTotalTests, failed, perFile, brokenFiles };
}

/** What a run printed, and what its report says, or `undefined` when it wrote no report. */
export type Ran = { readonly output: string; readonly run: Run | undefined };

/**
 * Runs `vitest run <args>` from `root` with the default reporter and a JSON one beside it.
 * `onChild` is handed the process, so a caller's interrupt handler can stop it.
 */
export async function runVitest(
  root: string,
  args: readonly string[],
  onChild: (child: ChildProcess | undefined) => void = () => {},
): Promise<Ran> {
  const dir = await mkdtemp(join(tmpdir(), "vitest-run-"));
  const reportPath = join(dir, "report.json");
  try {
    const child = spawn(
      join(root, "node_modules/.bin/vitest"),
      ["run", "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`, ...args],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    onChild(child);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    onChild(undefined);
    const output = Buffer.concat(chunks).toString("utf8");
    let json: string;
    try {
      json = await readFile(reportPath, "utf8");
    } catch {
      return { output, run: undefined };
    }
    return { output, run: readReport(json, root) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
