import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readCalls, type CallEdge } from "./calls.ts";
import { readCoverage } from "./coverage.ts";
import type { Report } from "./render.ts";
import { readModule } from "./surface.ts";
import { readTestFile } from "./tests.ts";

/**
 * Reading the source into the module graph, the call graph, the test titles and the
 * coverage numbers. It lives apart from `main.ts` because more than one thing wants the
 * graphs: the report renders them, and the PR review (`tools/pr-review`) checks them for
 * cycles. Deriving them twice would let the two disagree.
 */
/** The four workspaces. Exported because the review states what it walked. */
export const SOURCE_DIRS = ["core/src", "app/src", "server/src", "web/src"];
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
 * Everything the report and the review are derived from. Coverage is optional: without a
 * coverage run `coverage.available` is false and the rest still holds, which is why the
 * review can run the graph checks without paying for a test run.
 */
export function collect(root: string): Report {
  const files = SOURCE_DIRS.flatMap((d) => walk(join(root, d)));
  const sourceFiles = files.filter((f) => !/\.test\.tsx?$/.test(f));
  const testFiles = files.filter((f) => /\.test\.tsx?$/.test(f));

  const modules = sourceFiles
    .map((f) => readModule(f, root))
    .sort((a, b) => a.path.localeCompare(b.path));
  const tests = testFiles
    .map((f) => readTestFile(f, root))
    .sort((a, b) => a.path.localeCompare(b.path));

  // name -> the module that exports it, for the call graph
  const known = new Map<string, string>();
  for (const m of modules) {
    for (const e of m.exports) {
      if (e.kind === "function" || e.kind === "const") known.set(e.name, m.path);
    }
  }

  const edges: CallEdge[] = sourceFiles.flatMap((f) => readCalls(f, root, known));

  const coverage = readCoverage(join(root, "coverage/coverage-summary.json"), root);

  // Measured or not is worth saying out loud: a module absent from the coverage run is
  // not passing, it is unexamined.
  const unmeasured = coverage.available
    ? modules.filter((m) => !coverage.byFile.has(m.path)).map((m) => m.path)
    : [];

  return { modules, tests, coverage, edges, unmeasured };
}
