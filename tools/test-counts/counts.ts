import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Per-file test counts (#371), so a merge that lands short of its predicted count is diagnosed by
 * one command: lost tests, or a branch measured from a different base.
 *
 * The counts are what a run collects, read from Vitest's JSON report. The PR report's static
 * count (`tools/pr-report/tests.ts`) was the first choice, but on `dev` at 22ea4aa it read 2569
 * tests where the run collected 2604 — `app/src/workspace.contract.ts` is one suite two files
 * run — and `vitest list` read 2403. Only the run agrees with the run.
 */

export type Counts = Readonly<Record<string, number>>;

/** The counts as JSON with its keys sorted, so two measurements diff line for line. */
export const stable = (counts: Counts): string =>
  JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), null, 2);

/** Each file whose count differs, as `[in a, in b]`; a file one side lacks counts 0 there. */
export function diffCounts(a: Counts, b: Counts): Record<string, [number, number]> {
  const files = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => x.localeCompare(y));
  const changed: Record<string, [number, number]> = {};
  for (const file of files) {
    const before = a[file] ?? 0;
    const after = b[file] ?? 0;
    if (before !== after) changed[file] = [before, after];
  }
  return changed;
}

const git = promisify(execFile);

/**
 * Runs `measure` in a detached worktree of `commit`, with this checkout's `node_modules` linked
 * in, and removes the worktree afterwards whether `measure` returned or threw.
 */
export async function inTemporaryWorktree<T>(
  root: string,
  commit: string,
  measure: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = join(await mkdtemp(join(tmpdir(), "test-counts-")), "tree");
  try {
    await git("git", ["worktree", "add", "--detach", "--quiet", dir, commit], { cwd: root });
    for (const modules of ["node_modules", ...(await workspaceModules(root))]) {
      await symlink(join(root, modules), join(dir, modules));
    }
    return await measure(dir);
  } finally {
    // this worktree's record only, and only if `add` got as far as making one
    await git("git", ["worktree", "remove", "--force", dir], { cwd: root }).catch(() => {});
    await rm(join(dir, ".."), { recursive: true, force: true });
  }
}

/** The workspaces' own `node_modules` folders this checkout has, as `server/node_modules`. */
async function workspaceModules(root: string): Promise<string[]> {
  const found: string[] = [];
  const { workspaces = [] } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  for (const workspace of workspaces) {
    const path = join(workspace, "node_modules");
    try {
      await stat(join(root, path));
      found.push(path);
    } catch {
      // this workspace has none: its packages are all hoisted
    }
  }
  return found;
}
