import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * Per-file coverage, straight from vitest's json-summary. No numbers are invented.
 *
 * This module reads what a real test run wrote down, and coverage is not the only thing a run
 * writes: `readTestRun` below reads the run's own count of the tests it collected, from the
 * same directory and the same run. They belong together because they are the same evidence —
 * one file states what the run executed, the other how many tests it had to execute it with.
 *
 * **They are reached differently on purpose, and that was ruled rather than inherited (#176).**
 * `readCoverage` is called inside `collect()`; `readTestRun` is called by `tools/pr-report/main.ts`,
 * so `Report.run` is optional where `Report.coverage` is not. Moving it into `collect()` is three
 * lines and was not done: `collect()` is shared with `tools/pr-review`, which reads the source for
 * its graphs and runs no tests at all. An optional field says "this caller did not ask", which is
 * what is true of the review; a required one would hand it `{ available: false, tests: 0 }`, a
 * present-but-empty value that has to be read before it can be disbelieved. The symmetry argument
 * is real — `collect()` already pays for a `readCoverage` the review never looks at — but that is
 * an existing cost to leave alone, not a reason to add a second one and weaken a type to match it.
 *
 * Both readers read a file that may be absent, truncated or from another tree, and neither throws
 * for it. A run killed part-way must cost the report its numbers, not the whole report.
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

/**
 * `JSON.parse` of a file that may not be there and may not be whole, as data and never as code
 * (ADR-0007). `undefined` is "nothing readable here", and each caller turns that into its own
 * "not available" answer rather than into a zero.
 */
function parseFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A number, or 0 — `NaN` and `Infinity` included, since both would render as a percentage. */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const pct = (entry: Record<string, unknown>, key: string): number => {
  const metric = entry[key];
  return isRecord(metric) ? num(metric["pct"]) : 0;
};

/**
 * One file's row. Every field is checked for the shape it is read as, so a reporter that changes
 * costs the fields that changed and not the report: a missing metric reads as 0, which the table
 * shows as 0% rather than as a blank a reviewer would read as "fine".
 */
const shape = (entry: Record<string, unknown>): FileCoverage => {
  const lines = entry["lines"];
  const total = isRecord(lines) ? num(lines["total"]) : 0;
  const covered = isRecord(lines) ? num(lines["covered"]) : 0;
  return {
    statements: pct(entry, "statements"),
    branches: pct(entry, "branches"),
    functions: pct(entry, "functions"),
    lines: pct(entry, "lines"),
    uncoveredLines: total - covered,
  };
};

/**
 * v8's detailed report carries a map of every function it instrumented and how many
 * times each was entered. A count of zero is the only honest definition of "untested":
 * a function reached through a seam is exercised, whichever test called it.
 */
function deadFunctionsFrom(finalPath: string, root: string): Coverage["deadFunctions"] {
  const raw = parseFile(finalPath);
  if (!isRecord(raw)) return [];

  const dead: Coverage["deadFunctions"] = [];
  for (const [file, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const fnMap = entry["fnMap"];
    if (!isRecord(fnMap)) continue;
    const hits = isRecord(entry["f"]) ? entry["f"] : {};

    for (const [key, fn] of Object.entries(fnMap)) {
      // Exactly zero, not falsy: a function entered no times is the claim, and `undefined` from
      // a shape that does not carry `f` is not that claim.
      if (hits[key] !== 0 || !isRecord(fn)) continue;

      const decl = fn["decl"];
      const start = isRecord(decl) ? decl["start"] : undefined;
      dead.push({
        file: relative(root, file),
        // An arrow assigned to nothing has no name in `fnMap`, and "" in a list of names a
        // reviewer is meant to look up reads as a rendering fault rather than as a fact.
        name: typeof fn["name"] === "string" && fn["name"] !== "" ? fn["name"] : "(anonymous)",
        line: isRecord(start) ? num(start["line"]) : 0,
      });
    }
  }
  return dead;
}

export function readCoverage(summaryPath: string, root: string): Coverage {
  // The two files are one run's output, so the dead-function list is read even where the summary
  // is not: a reader who has one of them should not lose the other.
  const dead = deadFunctionsFrom(summaryPath.replace("coverage-summary.json", "coverage-final.json"), root);

  const raw = parseFile(summaryPath);
  if (!isRecord(raw)) return { available: false, byFile: new Map(), deadFunctions: dead };

  const byFile = new Map<string, FileCoverage>();
  let total: FileCoverage | undefined;

  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    if (key === "total") {
      total = shape(entry);
      continue;
    }
    // A key outside `root` keeps its `../` prefix rather than being dropped or rebased. It can
    // only come from a `coverage/` left by another tree, and such a path matches no module, so
    // `collect` counts it in nothing: it cannot inflate a percentage or hide an unmeasured
    // module. Kept visible, because silently discarding rows is how a summary from the wrong
    // tree comes to look like a summary from this one.
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
 * **It answers for one run.** `npm run report` builds the report after `npm run coverage`, and
 * that script names no project, so the run it describes is the whole suite — both projects, the
 * same run that wrote the coverage summary beside it. It was not always: until #163 the script
 * ran `--project node` and this count was smaller than what `npm test` runs by exactly the
 * browser project, which is the direction of error the cross-check was added to catch (#140).
 * The map stays per file regardless: `render` compares file by file and names the files the run
 * did not touch, so the scope is visible rather than asserted, and that is what would make a
 * future narrowing of the run obvious instead of silent.
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
    // Added rather than assigned, so a path arriving twice cannot silently keep only the
    // last count. Defensive: the runs this is read from give each file one entry, and no
    // invocation in this repo produces two. The alternative is the failure this whole ticket
    // is about — a total nothing agrees with — for the cost of one `??`.
    const path = relative(root, name);
    byFile.set(path, (byFile.get(path) ?? 0) + assertionResults.length);
  }

  let tests = 0;
  for (const count of byFile.values()) tests += count;
  return { available: true, byFile, tests };
}
