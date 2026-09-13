import { readdirSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readCalls, type CallEdge } from "./calls.ts";
import { readCoverage } from "./coverage.ts";
import { render } from "./render.ts";
import { readModule } from "./surface.ts";
import { readTestFile } from "./tests.ts";

/**
 * Builds the report a reviewer reads instead of the diff. Run it with:
 *
 *   npm run report            # writes pr-report.md
 *   npm run report -- --stdout
 *
 * It needs a coverage run first (`npx vitest run --coverage`) or the coverage
 * section says so rather than guessing.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_DIRS = ["core/src", "app/src", "server/src", "web/src"];
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

const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));
const sourceFiles = files.filter((f) => !/\.test\.tsx?$/.test(f));
const testFiles = files.filter((f) => /\.test\.tsx?$/.test(f));

const modules = sourceFiles.map((f) => readModule(f, ROOT)).sort((a, b) => a.path.localeCompare(b.path));
const tests = testFiles.map((f) => readTestFile(f, ROOT)).sort((a, b) => a.path.localeCompare(b.path));

// name -> the module that exports it, for the call graph
const known = new Map<string, string>();
for (const m of modules) {
  for (const e of m.exports) {
    if (e.kind === "function" || e.kind === "const") known.set(e.name, m.path);
  }
}

const edges: CallEdge[] = sourceFiles.flatMap((f) => readCalls(f, ROOT, known));

const coverage = readCoverage(join(ROOT, "coverage/coverage-summary.json"), ROOT);

// Measured or not is worth saying out loud: a module absent from the coverage run is
// not passing, it is unexamined.
const unmeasured = coverage.available
  ? modules.filter((m) => !coverage.byFile.has(m.path)).map((m) => m.path)
  : [];

const markdown = render({ modules, tests, coverage, edges, unmeasured });

if (process.argv.includes("--stdout")) {
  console.log(markdown);
} else {
  const out = join(ROOT, "pr-report.md");
  writeFileSync(out, markdown + "\n");
  console.log(`wrote ${out} (${markdown.split("\n").length} lines)`);
}

// In Actions, the same report becomes the job summary for free.
if (process.env["GITHUB_STEP_SUMMARY"]) {
  appendFileSync(process.env["GITHUB_STEP_SUMMARY"], markdown + "\n");
}
