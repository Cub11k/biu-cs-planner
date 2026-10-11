import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffCounts, inTemporaryWorktree, stable } from "./counts.ts";

const run = promisify(execFile);

describe("diffCounts", () => {
  it("lists exactly the files whose counts changed, a missing file counting 0", () => {
    expect(
      diffCounts(
        { "a.test.ts": 3, "same.test.ts": 5, "gone.test.ts": 2 },
        { "a.test.ts": 4, "same.test.ts": 5, "new.test.ts": 1 },
      ),
    ).toEqual({ "a.test.ts": [3, 4], "gone.test.ts": [2, 0], "new.test.ts": [0, 1] });
  });

  it("says nothing when no count moved", () => {
    expect(diffCounts({ "a.test.ts": 1 }, { "a.test.ts": 1 })).toEqual({});
  });
});

describe("stable", () => {
  it("prints the files sorted, whatever order they were measured in", () => {
    expect(stable({ "b.test.ts": 1, "a.test.ts": 2 })).toBe('{\n  "a.test.ts": 2,\n  "b.test.ts": 1\n}');
  });
});

describe("inTemporaryWorktree", () => {
  let repo: string;
  const git = async (...args: string[]) => (await run("git", args, { cwd: repo })).stdout;
  const worktrees = async () => (await git("worktree", "list", "--porcelain")).match(/^worktree /gm)?.length;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "test-counts-test-"));
    await writeFile(join(repo, "package.json"), '{ "workspaces": [] }\n');
    await git("init", "-q");
    await git("add", ".");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("measures the commit's tree and removes the worktree afterwards", async () => {
    let seen = "";
    await inTemporaryWorktree(repo, "HEAD", async (dir) => {
      seen = dir;
      await stat(join(dir, "package.json"));
    });
    expect(await worktrees()).toBe(1);
    await expect(stat(join(seen, ".."))).rejects.toThrow(); // the temporary folder around it too
  });

  it("removes the worktree when the measurement throws", async () => {
    let seen = "";
    await expect(
      inTemporaryWorktree(repo, "HEAD", async (dir) => {
        seen = dir;
        throw new Error("the run crashed");
      }),
    ).rejects.toThrow("the run crashed");
    expect(await worktrees()).toBe(1);
    await expect(stat(join(seen, ".."))).rejects.toThrow(); // the temporary folder around it too
  });

  it("leaves nothing behind when the commit does not exist", async () => {
    await expect(inTemporaryWorktree(repo, "no-such-commit", async () => {})).rejects.toThrow();
    expect(await worktrees()).toBe(1);
  });
});
