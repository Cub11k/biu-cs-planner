import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTestRun } from "./coverage.ts";

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
