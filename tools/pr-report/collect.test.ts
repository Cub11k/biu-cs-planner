import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ONLY_DIRS, collect } from "./collect.ts";
import { render } from "./render.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * What `collect` reads, against the tree it reads it from.
 *
 * Every other test in this directory hands the renderer or the parser a fixture, which is the
 * right shape for a rule. This one is about scope — *which files are looked at at all* — and a
 * fixture cannot be wrong about that: a scope bug is a file on disk that nothing reached, and
 * only the real tree has the files. #123 was exactly that bug, and it survived a suite of
 * fixture tests for as long as the fixtures were the only thing anyone asked.
 */

/**
 * Every test file actually on disk under a directory, as the tree spells it.
 *
 * `SKIP` is repeated from `collect.ts` rather than left out, and that repetition is the point of
 * this comment. `walk` skips `node_modules`, `dist`, `__fixtures__` and `coverage`; a plain
 * recursive read does not, so a `__fixtures__` holding a `.test.ts` — and `core/src/shoham`
 * already has a `__fixtures__`, so the pattern exists here — would make this test fail with a
 * message that reads like a scope bug in `collect` when it is only a difference between two
 * walks. If `SKIP` gains a name, this list needs it too.
 */
const SKIP = ["node_modules", "dist", "__fixtures__", "coverage"];

const testFilesUnder = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => /\.test\.tsx?$/.test(entry))
    .filter((entry) => !entry.split("/").some((segment) => SKIP.includes(segment)))
    .map((entry) => `${dir}/${entry}`)
    .sort();

describe("what the report is derived from", () => {
  it("reads the titles of the tests that guard the guardrails", () => {
    // The two files #123 named. `workflows.test.ts` is what fails the build on an install
    // without `--ignore-scripts` or a workflow with no `permissions:` block, and it had no
    // title anywhere in the report a reviewer is told to read before the diff.
    const titles = new Map(collect(ROOT).tests.map((t) => [t.path, t.cases.length]));

    expect(titles.get("tools/ci/workflows.test.ts")).toBeGreaterThan(0);
    expect(titles.get("tools/ci/clock-pattern.test.ts")).toBeGreaterThan(0);
  });

  it("reads every test file under a titles-only directory, not a hand-kept list of them", () => {
    // Derived from the tree rather than listed here, so a test file added to `tools/` tomorrow
    // is covered the day it is written. This is the assertion that would have failed on `dev`
    // before #123, and it fails again the moment the walk stops reaching one of these files.
    const collected = collect(ROOT)
      .tests.map((t) => t.path)
      .filter((path) => path.startsWith("tools/"))
      .sort();

    const onDisk = testFilesUnder("tools");

    expect(onDisk.length).toBeGreaterThan(5);
    expect(collected).toEqual(onDisk);
  });

  it("keeps those directories out of both graphs and out of coverage", () => {
    // The other half of the decision, and the half a later change is likeliest to undo by
    // accident: titles were the whole of what #123 asked for. `tools/` in the module graph is
    // noise for a reviewer of the app, and `vitest.config.ts` excludes it from coverage on
    // purpose, which that ticket is explicit should stay.
    const derived = collect(ROOT);
    const inTools = (path: string): boolean => path.startsWith("tools/");

    expect(derived.modules.map((m) => m.path).filter(inTools)).toEqual([]);
    expect(derived.edges.filter((e) => inTools(e.from) || inTools(e.to))).toEqual([]);

    // The coverage halves are only worth anything once a coverage run exists on disk: without
    // `coverage/coverage-summary.json` the map is empty and `unmeasured` is `[]`, so both would
    // pass for the wrong reason under a bare `npm run test:node`. Guarded so that the assertion
    // is made where it means something — after `npm run report`, which is what CI runs — and
    // skipped, visibly, where it would not be.
    if (derived.coverage.available) {
      expect(derived.coverage.byFile.size).toBeGreaterThan(0);
      expect([...derived.coverage.byFile.keys()].filter(inTools)).toEqual([]);
      expect(derived.unmeasured.filter(inTools)).toEqual([]);
    }
  });

  it("tells the renderer which directories it read nothing but titles from", () => {
    // `render` cannot work this out from the paths it is handed — a path says where a file is,
    // never whether anything measured it — so the scope travels with the data. Without this the
    // report would hold `tools/` titles and still say nothing about what it left out.
    expect(collect(ROOT).testOnlyDirs).toEqual(TEST_ONLY_DIRS);
    expect(TEST_ONLY_DIRS).toContain("tools");
  });

  it("answers, from the report alone, whether a change under tools has tests", () => {
    // The acceptance criterion of #123 end to end, over the real tree: the question a reviewer
    // of a `tools/` diff arrives with, asked of the finished markdown.
    const markdown = render(collect(ROOT));

    expect(markdown).toContain("tools/ci/workflows.test.ts");
    expect(markdown).toContain("**titles only**, not graphed or measured");
    expect(markdown).toContain(
      "`tools/` is in neither graph, in no exported-type list and in no coverage row",
    );
  });
});
