import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * Per-file coverage, straight from vitest's json-summary. No numbers are invented.
 *
 * This module reads what a real test run wrote down, and coverage is not the only thing a run
 * writes: `readTestRun` below reads the run's own count of the tests it collected, from the
 * same directory and the same run. They belong together because they are the same evidence —
 * one file states what the run executed, the other how many tests it had to execute it with.
 */
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

/**
 * What a real test run collected, per test file — vitest's json reporter, read the way the
 * coverage summary is.
 *
 * **It answers for one run, not for the suite.** `npm run report` builds the report after
 * `npm run coverage`, which is `vitest run --project node --coverage`: the browser project is
 * not in it. So the number here is smaller than what `npm test` runs, by exactly the browser
 * project, and a reader who took it for the whole suite would be misled in the other
 * direction from the defect it was added to catch (#140). The map is per file for that reason:
 * `render` compares file by file and names the files this run did not touch, so the scope is
 * visible rather than asserted.
 *
 * `available` is false where no run left the file, and the report then says the source's count
 * is unchecked rather than implying a run agreed with it.
 *
 * The file is data to interpret, never to execute: `JSON.parse`, then each field checked for
 * the shape it is used as, and anything else is skipped rather than assumed (ADR-0007).
 */
export type TestRun = {
  available: boolean;
  /** Tests the run collected, by repo-relative test file path. */
  byFile: Map<string, number>;
  /** Tests it collected in total — summed from `byFile`, so the two cannot disagree. */
  tests: number;
};

export function readTestRun(resultsPath: string, root: string): TestRun {
  const byFile = new Map<string, number>();
  if (!existsSync(resultsPath)) return { available: false, byFile, tests: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resultsPath, "utf8"));
  } catch {
    return { available: false, byFile, tests: 0 };
  }
  if (typeof parsed !== "object" || parsed === null) return { available: false, byFile, tests: 0 };
  const { testResults } = parsed as { testResults?: unknown };
  if (!Array.isArray(testResults)) return { available: false, byFile, tests: 0 };

  for (const entry of testResults) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, assertionResults } = entry as { name?: unknown; assertionResults?: unknown };
    if (typeof name !== "string" || !Array.isArray(assertionResults)) continue;
    // A file run by two projects arrives as two entries, so they add rather than replace.
    byFile.set(relative(root, name), (byFile.get(relative(root, name)) ?? 0) + assertionResults.length);
  }

  let tests = 0;
  for (const count of byFile.values()) tests += count;
  return { available: true, byFile, tests };
}
