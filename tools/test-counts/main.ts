import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runVitest } from "../test-run/vitest.ts";
import { diffCounts, inTemporaryWorktree, stable, type Counts } from "./counts.ts";

/**
 * `npm run test:counts [-- <commit>]`: per-file test counts of the working tree, or of a commit,
 * as stable JSON. `npm run test:counts -- --diff <a> <b>`: only the files whose counts differ, as
 * `{ "<file>": [<in a>, <in b>] }` (#371). A commit is measured in a temporary worktree, removed
 * afterwards; the working tree is measured where it stands, uncommitted changes included.
 */
const git = promisify(execFile);
const root = (await git("git", ["rev-parse", "--show-toplevel"])).stdout.trim();

async function countsIn(dir: string): Promise<Counts> {
  const { output, run } = await runVitest(dir, []);
  if (run === undefined) throw new Error(`the run in ${dir} wrote no report:\n${output}`);
  if (run.brokenFiles.length > 0) console.error(`did not load, counted as 0: ${run.brokenFiles.join(", ")}`);
  return run.perFile;
}

const countsAt = (commit: string | undefined): Promise<Counts> =>
  commit === undefined ? countsIn(root) : inTemporaryWorktree(root, commit, countsIn);

const args = process.argv.slice(2);
if (args[0] === "--diff" && args.length === 3) {
  const [, a, b] = args as [string, string, string];
  // one file to a line, still JSON
  const lines = Object.entries(diffCounts(await countsAt(a), await countsAt(b))).map(
    ([file, [before, after]]) => `  ${JSON.stringify(file)}: [${before}, ${after}]`,
  );
  console.log(lines.length === 0 ? "{}" : `{\n${lines.join(",\n")}\n}`);
} else if (args.length <= 1 && !args[0]?.startsWith("-")) {
  console.log(stable(await countsAt(args[0])));
} else {
  console.error("usage: npm run test:counts [-- <commit>]  |  npm run test:counts -- --diff <a> <b>");
  process.exit(2);
}
