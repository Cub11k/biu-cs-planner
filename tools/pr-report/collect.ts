import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readCalls, type CallEdge, type CallTargets, type ExportedNames } from "./calls.ts";
import { readCoverage } from "./coverage.ts";
import type { Report } from "./render.ts";
import { readModule, type ExportOrigin, type Module } from "./surface.ts";
import { readTestFile } from "./tests.ts";

/**
 * Reading the source into the module graph, the call graph, the test titles and the
 * coverage numbers. It lives apart from `main.ts` because more than one thing wants the
 * graphs: the report renders them, and the PR review (`tools/pr-review`) checks them for
 * cycles. Deriving them twice would let the two disagree.
 */
/**
 * The four workspaces: the product code, and the whole of what the module graph, the call
 * graph and the coverage table describe. Exported because the review states what it walked.
 */
export const SOURCE_DIRS = ["core/src", "app/src", "server/src", "web/src"];

/**
 * Directories whose **test titles** the report lists and whose **source** it describes no
 * other way: no module in either graph, no row in the coverage table.
 *
 * `tools/` holds the checks that guard the guardrails — `tools/ci/workflows.test.ts` fails the
 * build on an install without `--ignore-scripts`, on a workflow that declares no
 * `permissions:` and on a write scope outside its short list, and `tools/ci/clock-pattern.ts`
 * enforces one clock body across the repository (#89) — and not one of their titles reached the
 * report `CLAUDE.md` sends a reviewer to *before* the diff. Two agents found that independently
 * on 2026-09-24 while working on unrelated tickets (#123).
 *
 * **Titles, and deliberately not the rest.** A module graph of the report generator tells a
 * reviewer of the app nothing, which is the scoping `SOURCE_DIRS` exists for; and coverage stays
 * as `vitest.config.ts` has it, whose `include` names `{core,app,server,web}/src` and nothing
 * else, because #123 is explicit that the exclusion is deliberate and should stay. What replaces
 * the silence is not a measurement but a sentence: `render` names every directory in this list
 * wherever its absence would otherwise read as an absence of tests rather than of measurement.
 *
 * Every entry is a repo-relative directory, matched whole. `render` compares by path segment,
 * so `tools` never matches a `toolsmith/` that is not in the list.
 */
export const TEST_ONLY_DIRS = ["tools"];

const SKIP = new Set(["node_modules", "dist", "__fixtures__", "coverage"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The module a bare import of one of this repo's own packages reaches: `@biu-cs-planner/core`
 * to `core/src/index.ts`, read from `core/package.json`'s `exports` — the `"."` subpath, or the
 * whole field where it is written as the bare string that means the same thing.
 *
 * Read rather than assumed. Every workspace here happens to answer `./src/index.ts` today,
 * and hard-coding that would be a second statement of a fact the manifest already makes —
 * the kind that stops being true without anything failing. **`web` has no `exports` at all**,
 * because nothing imports `web`, and the honest consequence is that a call into
 * `@biu-cs-planner/web` cannot be placed in a module and is drawn unresolved.
 *
 * `JSON.parse` and nothing else: a manifest is data to interpret, never to execute, and each
 * field is checked for the shape it is used as. A workspace whose `exports` is missing, a
 * conditional object, or anything but a string simply has no entry, and a call across that
 * boundary is unresolved rather than guessed at.
 *
 * `tools/pr-report` resolving a package specifier to a module is deliberately narrower than
 * it sounds, and narrower than what #83 turned down for the *module* graph: there an arrow
 * could stop at the workspace's box, which is what the source says and all it says. A call
 * edge has no box to end at — a node is `module#function` — and stopping at the boundary
 * would cut every path through the code in two at each workspace edge, which is the one thing
 * a call graph is for. So this graph resolves the entry, exactly, from the manifest, and the
 * module graph still does not.
 */
function packageEntries(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const dir of SOURCE_DIRS) {
    const workspace = dir.split("/")[0];
    if (!workspace) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(root, workspace, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest !== "object" || manifest === null) continue;
    const { name, exports } = manifest as { name?: unknown; exports?: unknown };
    if (typeof name !== "string") continue;
    const main =
      typeof exports === "string"
        ? exports
        : typeof exports === "object" && exports !== null
          ? (exports as Record<string, unknown>)["."]
          : undefined;
    if (typeof main !== "string") continue;
    entries.set(name, join(workspace, main));
  }
  return entries;
}

/**
 * What every module exports, and for a re-exported name where it comes from — the module or
 * package, and the name it is known by there.
 *
 * Keyed by module path, then by name. **The nesting is the fix**: the previous version of
 * this was one flat `Map<name, module>` for the whole repository, so a name exported twice
 * had one entry and the module read last owned it. Here two modules exporting `groupKey`
 * hold one entry each, and no reading order can make one of them answer for the other.
 *
 * Only what can be called is kept. A `type` or an `interface` is not a callee, and neither is
 * a name a re-export clause spells with the `type` keyword (#92), so this filter is now exact
 * rather than a tolerance for a `kind` that was always `const`. It was safe even then: an edge
 * starts from a value import binding, and `verbatimModuleSyntax` makes a keywordless type
 * re-export an error, so no compiling program could value-import one and call it.
 */
function exportedNames(modules: readonly Module[]): Map<string, ExportedNames> {
  const byModule = new Map<string, ExportedNames>();
  for (const m of modules) {
    const names = new Map<string, ExportOrigin | null>();
    for (const e of m.exports) {
      if (e.kind === "function" || e.kind === "const") names.set(e.name, e.from ?? null);
    }
    byModule.set(m.path, names);
  }
  return byModule;
}

/**
 * Everything the report and the review are derived from. Coverage is optional: without a
 * coverage run `coverage.available` is false and the rest still holds, which is why the
 * review can run the graph checks without paying for a test run.
 */
export function collect(root: string): Report {
  const isTest = (f: string): boolean => /\.test\.tsx?$/.test(f);

  const files = SOURCE_DIRS.flatMap((d) => walk(join(root, d)));
  const sourceFiles = files.filter((f) => !isTest(f));

  // Test files from both lists, in one sorted list rather than two fields. The graphs and the
  // coverage are about `SOURCE_DIRS`; the titles are about everything that has any, and every
  // reader of `tests` wants all of them. Splitting them would mean every such reader
  // remembering to read the second field, which is the shape of the bug in #77 — one field
  // going unread in one place — and `render` is told which directories are titles-only
  // through `Report.testOnlyDirs` instead. `forbiddenEdges` is unaffected either way: it
  // looks a path's first segment up in `LAYERS` and a `tools/` test matches no layer, so it
  // was already skipping what it is handed here.
  const testFiles = [
    ...files.filter(isTest),
    ...TEST_ONLY_DIRS.flatMap((d) => walk(join(root, d))).filter(isTest),
  ];

  const modules = sourceFiles
    .map((f) => readModule(f, root))
    .sort((a, b) => a.path.localeCompare(b.path));
  const tests = testFiles
    .map((f) => readTestFile(f, root))
    .sort((a, b) => a.path.localeCompare(b.path));

  // What a call is resolved against, keyed by module and by package rather than by name.
  const targets: CallTargets = {
    modules: exportedNames(modules),
    entries: packageEntries(root),
    workspaces: new Set(modules.map((m) => m.workspace)),
  };

  const edges: CallEdge[] = sourceFiles.flatMap((f) => readCalls(f, root, targets));

  const coverage = readCoverage(join(root, "coverage/coverage-summary.json"), root);

  // Measured or not is worth saying out loud: a module absent from the coverage run is
  // not passing, it is unexamined.
  const unmeasured = coverage.available
    ? modules.filter((m) => !coverage.byFile.has(m.path)).map((m) => m.path)
    : [];

  return { modules, tests, coverage, edges, unmeasured, testOnlyDirs: TEST_ONLY_DIRS };
}
