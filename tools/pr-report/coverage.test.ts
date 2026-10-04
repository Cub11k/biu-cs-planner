import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCoverage, readTestRun } from "./coverage.ts";

/**
 * What a real test run left behind, read back.
 *
 * The count this produces is one of the two the report sets against each other, and it is read
 * from a file that may be absent, stale or half-written — a run that crashed, a `coverage/`
 * from another tree, a reporter that changed its shape. Every one of those has to come out as
 * "nothing checks the count" rather than as a number, because a wrong number here is worse than
 * no number: the report would print a disagreement against a file the source is right about, or
 * an agreement it never earned (#140).
 *
 * Nothing is executed to read it. The file is `JSON.parse`d and then each field is checked for
 * the shape it is used as (ADR-0007).
 */

/** A run's json written into a throwaway root, and read the way the report reads it. */
function runFrom(contents: string | undefined, root = "/repo"): ReturnType<typeof readTestRun> {
  const dir = mkdtempSync(join(tmpdir(), "pr-report-run-"));
  try {
    const file = join(dir, "test-results.json");
    if (contents !== undefined) writeFileSync(file, contents, "utf8");
    return readTestRun(file, root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The shape vitest's json reporter writes, reduced to the two fields that are read. */
const reporterJson = (files: Array<{ name: string; tests: number }>): string =>
  JSON.stringify({
    testResults: files.map((f) => ({
      name: f.name,
      assertionResults: Array.from({ length: f.tests }, (_, i) => ({
        status: "passed",
        title: `t${i}`,
      })),
    })),
  });


/**
 * A coverage summary — and optionally the detailed report beside it — written into a throwaway
 * root, then read the way the report reads them.
 *
 * `readCoverage` derives the second path from the first by name, so the summary has to be called
 * `coverage-summary.json` for this to exercise the real pairing rather than a path it was handed.
 */
function coverageFrom(
  summary: string | undefined,
  final?: string,
  root = "/repo",
): ReturnType<typeof readCoverage> {
  const dir = mkdtempSync(join(tmpdir(), "pr-report-coverage-"));
  try {
    const summaryPath = join(dir, "coverage-summary.json");
    if (summary !== undefined) writeFileSync(summaryPath, summary, "utf8");
    if (final !== undefined) writeFileSync(join(dir, "coverage-final.json"), final, "utf8");
    return readCoverage(summaryPath, root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The shape vitest's json-summary writes, reduced to what is read. */
const metric = (pct: number, total = 10, covered = 10): Record<string, number> => ({ pct, total, covered });

const summaryJson = (entries: Record<string, number>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(entries).map(([file, pct]) => [
        file,
        { statements: metric(pct), branches: metric(pct), functions: metric(pct), lines: metric(pct, 10, 7) },
      ]),
    ),
  );

describe("reading what a run measured", () => {
  it("reads every file's row, by the path the report knows it as", () => {
    const coverage = coverageFrom(
      summaryJson({ total: 80, "/repo/core/src/a.ts": 100, "/repo/web/src/b.ts": 50 }),
    );

    expect(coverage.available).toBe(true);
    // `total` is lifted out rather than left as a file called "total", which would otherwise
    // render as a module with a suspiciously round coverage.
    expect(coverage.total?.statements).toBe(80);
    expect([...coverage.byFile.keys()]).toEqual(["core/src/a.ts", "web/src/b.ts"]);
    expect(coverage.byFile.get("web/src/b.ts")).toEqual({
      statements: 50,
      branches: 50,
      functions: 50,
      lines: 50,
      // Counted, not a percentage: 10 lines of which 7 are covered.
      uncoveredLines: 3,
    });
  });

  it("is available without a total, rather than withholding the rows it did read", () => {
    const coverage = coverageFrom(summaryJson({ "/repo/core/src/a.ts": 100 }));

    expect(coverage.available).toBe(true);
    expect(coverage.total).toBeUndefined();
    expect(coverage.byFile.size).toBe(1);
  });

  it("says nothing is available when no run left a summary", () => {
    const coverage = coverageFrom(undefined);

    expect(coverage).toEqual({ available: false, byFile: new Map(), deadFunctions: [] });
  });

  it("says nothing is available for a summary it cannot parse", () => {
    // A run killed while writing leaves a truncated file. Throwing here would turn a
    // half-finished test run into no report at all, where the report's whole purpose is to say
    // what is known and what is not.
    const coverage = coverageFrom('{"total": {"statements": {"pct": 80}');

    expect(coverage.available).toBe(false);
    expect(coverage.byFile.size).toBe(0);
  });

  it("says nothing is available for json of the wrong shape", () => {
    for (const contents of ["null", "[]", '"a string"', "7"]) {
      expect(coverageFrom(contents).available).toBe(false);
    }
  });

  it("reads 0 for a metric that is missing or not a number, and skips an entry that is not a row", () => {
    const coverage = coverageFrom(
      JSON.stringify({
        "/repo/a.ts": { statements: { pct: 90 }, lines: "not a metric" },
        "/repo/b.ts": { statements: { pct: "90%" } },
        "/repo/c.ts": null,
        "/repo/d.ts": [],
      }),
    );

    expect(coverage.byFile.get("a.ts")).toEqual({
      statements: 90,
      branches: 0,
      functions: 0,
      lines: 0,
      uncoveredLines: 0,
    });
    // A percentage read as a string would render as `90%%` and sort as text; 0 is wrong in a way
    // a reader can see, which a silent string is not.
    expect(coverage.byFile.get("b.ts")?.statements).toBe(0);
    expect([...coverage.byFile.keys()]).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps a path outside the root, with the `../` that says so", () => {
    // It can only come from a `coverage/` belonging to another tree. Such a path matches no
    // module, so `collect` counts it in nothing and it cannot inflate a percentage or hide an
    // unmeasured module — and keeping it visible is how a reader notices the wrong tree at all.
    const coverage = coverageFrom(summaryJson({ "/elsewhere/src/a.ts": 100 }), undefined, "/repo");

    expect([...coverage.byFile.keys()]).toEqual(["../elsewhere/src/a.ts"]);
  });

  it("names the functions the run never entered, and not the ones it did", () => {
    const coverage = coverageFrom(
      summaryJson({ "/repo/a.ts": 50 }),
      JSON.stringify({
        "/repo/a.ts": {
          fnMap: {
            "0": { name: "ran", decl: { start: { line: 4 } } },
            "1": { name: "neverRan", decl: { start: { line: 11 } } },
          },
          f: { "0": 3, "1": 0 },
        },
      }),
    );

    expect(coverage.deadFunctions).toEqual([{ file: "a.ts", name: "neverRan", line: 11 }]);
  });

  it("names the dead functions even where the summary is absent, because one run wrote both", () => {
    const coverage = coverageFrom(
      undefined,
      JSON.stringify({
        "/repo/a.ts": { fnMap: { "0": { name: "neverRan", decl: { start: { line: 2 } } } }, f: { "0": 0 } },
      }),
    );

    expect(coverage.available).toBe(false);
    expect(coverage.deadFunctions).toEqual([{ file: "a.ts", name: "neverRan", line: 2 }]);
  });

  it("reads no dead functions from a detailed report it cannot parse, rather than throwing", () => {
    const coverage = coverageFrom(summaryJson({ "/repo/a.ts": 50 }), '{"/repo/a.ts": {"fnMap":');

    expect(coverage.available).toBe(true);
    expect(coverage.deadFunctions).toEqual([]);
  });

  it("survives a detailed report whose entries are the wrong shape", () => {
    const coverage = coverageFrom(
      summaryJson({ "/repo/a.ts": 50 }),
      JSON.stringify({
        "/repo/a.ts": null,
        "/repo/b.ts": { fnMap: "not a map", f: {} },
        "/repo/c.ts": { fnMap: { "0": { name: "x", decl: { start: { line: 1 } } } } },
        "/repo/d.ts": { fnMap: { "0": null, "1": { name: "", decl: null } }, f: { "0": 0, "1": 0 } },
      }),
    );

    // `c.ts` carries no `f`, so nothing there is claimed as never entered: a missing hit count is
    // not the claim "zero hits". `d.ts`'s unnamed entry is named rather than left blank.
    expect(coverage.deadFunctions).toEqual([{ file: "d.ts", name: "(anonymous)", line: 0 }]);
  });
});

describe("reading what a run collected", () => {
  it("counts the tests each file collected, by the path the report knows it as", () => {
    const run = runFrom(
      reporterJson([
        { name: "/repo/core/src/a.test.ts", tests: 3 },
        { name: "/repo/web/src/b.test.ts", tests: 1 },
      ]),
    );

    expect(run.available).toBe(true);
    expect(run.tests).toBe(4);
    // Repo-relative, because that is how every other reading in this report spells a path.
    expect([...run.byFile.entries()]).toEqual([
      ["core/src/a.test.ts", 3],
      ["web/src/b.test.ts", 1],
    ]);
  });

  it("adds a file that arrives twice rather than keeping only the last count", () => {
    // One file run by two projects. Assigning instead of adding would lose a whole project's
    // tests from that file and report a disagreement the source is not wrong about.
    const run = runFrom(
      reporterJson([
        { name: "/repo/web/src/a.test.ts", tests: 2 },
        { name: "/repo/web/src/a.test.ts", tests: 5 },
      ]),
    );

    expect(run.byFile.get("web/src/a.test.ts")).toBe(7);
    expect(run.tests).toBe(7);
  });

  it("totals exactly what it counted per file, so the two cannot disagree", () => {
    const run = runFrom(
      reporterJson([
        { name: "/repo/a.test.ts", tests: 6 },
        { name: "/repo/b.test.ts", tests: 4 },
      ]),
    );

    expect(run.tests).toBe([...run.byFile.values()].reduce((n, c) => n + c, 0));
  });

  it("says nothing is available when no run left a file", () => {
    const run = runFrom(undefined);

    expect(run).toEqual({ available: false, byFile: new Map(), tests: 0 });
  });

  it("says nothing is available for a file it cannot parse", () => {
    // A run killed part-way leaves a truncated file, and `JSON.parse` throws on it. Throwing
    // out of the report generator would turn a half-finished test run into no report at all.
    const run = runFrom('{"testResults": [{"name": "/repo/a.test.ts",');

    expect(run.available).toBe(false);
    expect(run.tests).toBe(0);
  });

  it("says nothing is available for json of the wrong shape", () => {
    for (const contents of ["null", "[]", '"a string"', "{}", '{"testResults": 7}']) {
      expect(runFrom(contents).available).toBe(false);
    }
  });

  it("skips an entry it cannot read and keeps the ones it can", () => {
    // A reporter that changes shape should cost the entries that changed, not the whole file.
    const run = runFrom(
      JSON.stringify({
        testResults: [
          null,
          { name: 7, assertionResults: [] },
          { name: "/repo/a.test.ts", assertionResults: "not an array" },
          {
            name: "/repo/b.test.ts",
            assertionResults: [{ status: "passed" }, { status: "skipped" }],
          },
        ],
      }),
    );

    expect([...run.byFile.entries()]).toEqual([["b.test.ts", 2]]);
  });

  it("counts a skipped test, because the source counts it too", () => {
    // `it.skipIf(cond)` skips on a machine that cannot make the condition true — seven tests in
    // this repo, and on a root CI runner they skip. The source reads them as tests either way,
    // so a reading that counted only passes would report a disagreement on every such file.
    const run = runFrom(
      JSON.stringify({
        testResults: [
          {
            name: "/repo/a.test.ts",
            assertionResults: [{ status: "passed" }, { status: "skipped" }, { status: "todo" }],
          },
        ],
      }),
    );

    expect(run.byFile.get("a.test.ts")).toBe(3);
  });
});
