import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

/** Per-file coverage, straight from vitest's json-summary. No numbers are invented. */
export type FileCoverage = {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
  uncoveredLines: number;
};

export type Coverage = {
  available: boolean;
  total?: FileCoverage;
  byFile: Map<string, FileCoverage>;
  /** Functions the test run never entered. Named, not counted. */
  deadFunctions: Array<{ file: string; name: string; line: number }>;
};

const pct = (m: { pct: number } | undefined): number => (m ? m.pct : 0);

const shape = (entry: Record<string, { pct: number; total: number; covered: number }>): FileCoverage => ({
  statements: pct(entry["statements"]),
  branches: pct(entry["branches"]),
  functions: pct(entry["functions"]),
  lines: pct(entry["lines"]),
  uncoveredLines: (entry["lines"]?.total ?? 0) - (entry["lines"]?.covered ?? 0),
});

/**
 * v8's detailed report carries a map of every function it instrumented and how many
 * times each was entered. A count of zero is the only honest definition of "untested":
 * a function reached through a seam is exercised, whichever test called it.
 */
function deadFunctionsFrom(finalPath: string, root: string): Coverage["deadFunctions"] {
  if (!existsSync(finalPath)) return [];
  const raw = JSON.parse(readFileSync(finalPath, "utf8")) as Record<
    string,
    { fnMap: Record<string, { name: string; decl: { start: { line: number } } }>; f: Record<string, number> }
  >;
  const dead: Coverage["deadFunctions"] = [];
  for (const [file, entry] of Object.entries(raw)) {
    for (const [key, fn] of Object.entries(entry.fnMap ?? {})) {
      if ((entry.f ?? {})[key] === 0) {
        dead.push({ file: relative(root, file), name: fn.name, line: fn.decl.start.line });
      }
    }
  }
  return dead;
}

export function readCoverage(summaryPath: string, root: string): Coverage {
  const dead = deadFunctionsFrom(summaryPath.replace("coverage-summary.json", "coverage-final.json"), root);
  if (!existsSync(summaryPath)) return { available: false, byFile: new Map(), deadFunctions: dead };

  const raw = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, never>;
  const byFile = new Map<string, FileCoverage>();
  let total: FileCoverage | undefined;

  for (const [key, entry] of Object.entries(raw)) {
    if (key === "total") {
      total = shape(entry);
      continue;
    }
    byFile.set(relative(root, key), shape(entry));
  }

  return total
    ? { available: true, total, byFile, deadFunctions: dead }
    : { available: true, byFile, deadFunctions: dead };
}
