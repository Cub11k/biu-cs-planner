import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/**
 * What `exportedNames` keeps, and the one case this repository does not contain.
 *
 * `collect.ts` keeps a call target by "not a type" rather than by a list of the value kinds,
 * and the reason is a re-exported **class**: `resolveReExports` answers `class` for one where
 * `readModule` answered `const`, so a list written out before that change and not updated by it
 * would have dropped `WorkspaceRefusedError` and `StateFileUnwritableError` out of the barrels
 * that carry them, and every chain through those names would have stopped there.
 *
 * **Nothing here calls a class through a barrel**, which is why reverting the widening broke
 * no test and why #196 reported it as an honest gap rather than claiming coverage: both filters
 * give the same edges over the real tree, and a reviewer confirmed it independently. The gap is
 * the dangerous kind — the call graph would simply have fewer edges, and a missing edge reads
 * as code that calls nothing.
 *
 * So the case is a fixture repository rather than a call invented in `core`, `app`, `server` or
 * `web` to serve a test (#204). `collect` takes a root, so the fixture is a whole little
 * repository read exactly as this one is, and `exportedNames` stays private.
 */
describe("a class re-exported through a barrel", () => {
  /** One fixture repository, written out and read back the way `collect` reads this one. */
  const reportOf = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "collect-"));
    try {
      for (const [rel, text] of Object.entries(files)) {
        const file = join(root, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text, "utf8");
      }
      return collect(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const lines = (...text: string[]): string => text.join("\n");

  /**
   * `core` declaring a class, its barrel carrying it, and a module calling the name it got
   * from the barrel.
   *
   * The call is written `Refused()` because that is the only spelling `readCalls` reads as a
   * call — a class is reached with `new`, which this graph does not follow, and whether it
   * should is a different question about the graph (#204 leaves it alone). What matters here is
   * that the name has to survive `exportedNames` for the chain through the barrel to reach the
   * declaration at all.
   */
  const throughTheBarrel = {
    "core/src/refused.ts": "export class Refused {}",
    "core/src/index.ts": 'export { Refused } from "./refused.ts";',
    "core/src/uses.ts": lines(
      'import { Refused } from "./index.ts";',
      "export function refuse() {",
      "  return Refused();",
      "}",
    ),
  };

  it("stays a call target, so the edge reaches the module that declares it", () => {
    // The assertion that fails if `exportedNames` goes back to a list of value kinds: the
    // barrel's `Refused` reads `class` after the second pass, a list that forgot `class` drops
    // it, `declaringModule` then finds no such name in `core/src/index.ts`, and the chain ends
    // one module short of the declaration.
    expect(reportOf(throughTheBarrel).edges.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "core/src/uses.ts#refuse -> core/src/refused.ts#Refused",
    ]);
  });

  it("is the kind the second pass says it is, which is what makes a list of kinds a trap", () => {
    // Why the filter is written as a question and not as a list. `readModule` answers `const`
    // for every re-export; after `resolveReExports` this one answers `class`, so the set of
    // kinds a call target can have changed under the filter without the filter being touched.
    const barrel = reportOf(throughTheBarrel).modules.find((m) => m.path === "core/src/index.ts");

    expect(barrel?.exports).toEqual([
      {
        name: "Refused",
        kind: "class",
        signature: "class",
        from: { specifier: "core/src/refused.ts", name: "Refused" },
        declaredIn: { path: "core/src/refused.ts", name: "Refused" },
      },
    ]);
  });

  it("is dropped, with the edge, when the name is a type and only then", () => {
    // The other side of the same question, so this pair says what the filter is for rather
    // than only that it is wide. `export type { Refused }` re-exports the type side of the
    // class and nothing a value import could reach, so the name is no call target and the
    // call reaches no module. Unresolved rather than absent, which is `calls.ts`'s own rule: an
    // arrow missing from the graph reads as "nothing is here", and that is a claim.
    const typeKeyword = {
      ...throughTheBarrel,
      "core/src/index.ts": 'export type { Refused } from "./refused.ts";',
    };

    expect(reportOf(typeKeyword).edges.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "core/src/uses.ts#refuse -> (unresolved)#Refused",
    ]);
  });
});
