import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "./collect.ts";
import { readTestFile, totalTests, type TestFile } from "./tests.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * How many tests a test file runs, read from its source.
 *
 * Every case below is written as source text and parsed, the way `surface.test.ts` reads an
 * import, rather than described by an object: the subject is what a call *looks like*, and a
 * fixture that states the answer cannot be wrong about the shape that produced it. It is also
 * the only way to hold this to the ticket's criterion — a test for a parameterised count has to
 * use a file whose titles are not all plain literals, or the two counts it is distinguishing
 * are the same number.
 */
function testFile(files: Record<string, readonly string[]>, subject: string): TestFile {
  const root = mkdtempSync(join(tmpdir(), "pr-report-tests-"));
  try {
    for (const [relPath, lines] of Object.entries(files)) {
      const file = join(root, relPath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, lines.join("\n"), "utf8");
    }
    return readTestFile(join(root, subject), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The one file case, which is most of them. */
const fromSource = (lines: readonly string[]): TestFile =>
  testFile({ "core/src/a.test.ts": lines }, "core/src/a.test.ts");

/** Tests the file runs, and entries it holds — the two numbers #140 is about. */
const counts = (file: TestFile): { tests: number; entries: number; atLeast: number } => ({
  ...totalTests([file]),
  entries: file.cases.length,
});

describe("how many tests a file runs", () => {
  it("counts an ordinary test once", () => {
    const file = fromSource(['it("works", () => {});', 'test("also works", () => {});']);

    expect(counts(file)).toEqual({ tests: 2, entries: 2, atLeast: 0 });
  });

  it("counts a row of a literal table as a test, because that is what the run does", () => {
    // The criterion in one assertion, and the case the whole ticket turns on: one entry, four
    // tests. Counted as an entry it is 1, which is the number the report used to print, and
    // dropped for want of a literal title it is 0, which is what it actually printed.
    const file = fromSource([
      "it.each([",
      '  ["a", 1],',
      '  ["b", 2],',
      '  ["c", 3],',
      '  ["d", 4],',
      '])("handles %s", () => {});',
    ]);

    expect(counts(file)).toEqual({ tests: 4, entries: 1, atLeast: 0 });
    expect(file.cases[0]?.title).toBe("handles %s");
  });

  it("reads a table through `as const`, which is how the typed ones are written", () => {
    const file = fromSource([
      "it.each([",
      '  { scheme: "light" },',
      '  { scheme: "dark" },',
      '] as const)("shows the focus ring on $scheme", () => {});',
    ]);

    expect(counts(file)).toEqual({ tests: 2, entries: 1, atLeast: 0 });
  });

  it("reads a table kept in a `const`, which is how the long ones are kept readable", () => {
    // `app/src/workspace.test.ts` keeps 16 accepted names and 26 refused ones this way, and
    // inlining them at the call site would make the test unreadable to make it countable.
    const file = fromSource([
      "const ACCEPTED = [",
      '  ["a name", "alice"],',
      '  ["a name in Hebrew", "אליס"],',
      '  ["a space inside", "alice and bob"],',
      "];",
      "",
      'it.each(ACCEPTED)("accepts %s", () => {});',
    ]);

    expect(counts(file)).toEqual({ tests: 3, entries: 1, atLeast: 0 });
  });

  it("follows one relative import to the table, which is how `LANGUAGES` reaches `web`", () => {
    // `describe.each(LANGUAGES)` in two `web` browser tests names a table exported from
    // `web/src/i18n/strings.ts`. Fourteen of this repo's tests are behind that one hop.
    const file = testFile(
      {
        "web/src/i18n/strings.ts": ['export const LANGUAGES = ["en", "he"] as const;'],
        "web/src/a.test.ts": [
          'import { LANGUAGES } from "./i18n/strings.ts";',
          "",
          'describe.each(LANGUAGES)("the week in %s", () => {',
          '  it("puts the gutter on the reading side", () => {});',
          '  it("runs the days away from it", () => {});',
          "});",
        ],
      },
      "web/src/a.test.ts",
    );

    expect(counts(file)).toEqual({ tests: 4, entries: 2, atLeast: 0 });
    expect(file.cases[0]?.suite).toEqual(["the week in %s"]);
  });

  it("multiplies a suite's tests by its table, and every table around it", () => {
    const file = fromSource([
      'describe.each([1, 2, 3])("in %s", () => {',
      '  it("does one thing", () => {});',
      "  it.each([",
      '    ["x"],',
      '    ["y"],',
      '  ])("does %s", () => {});',
      "});",
    ]);

    // Three rows outside: three of the plain test, and three times two of the inner table.
    expect(counts(file)).toEqual({ tests: 9, entries: 2, atLeast: 0 });
  });

  it("counts a test whose modifier is called, not only one whose modifier is a property", () => {
    // `it.skipIf(cond)("…")` — the callee is a **call**, so a reading that asked only whether
    // it was a property access saw no `it` at all and dropped the title whole. Seven tests in
    // this repo are written that way, and `skipIf` is the guard against a test passing
    // vacuously on a machine that cannot make the condition true: exactly the tests a reviewer
    // sent to this report before the diff needs to be able to find. Found by #129's agent.
    const file = fromSource([
      'it.skipIf(!unreadable)("survives a file it may not read", () => {});',
      'it.runIf(inodes)("keeps the same file", () => {});',
      'it.only.each([["a"], ["b"]])("still counts %s", () => {});',
    ]);

    expect(counts(file)).toEqual({ tests: 4, entries: 3, atLeast: 0 });
    expect(file.cases.map((c) => c.title)).toContain("survives a file it may not read");
  });

  it("does not mistake the table for the title of a second test", () => {
    // `it.each(TABLE)("t")` holds two call expressions on `it`, and only the outer one is an
    // entry. Counting the inner one too would have made the total too big instead of too
    // small, which is the same defect wearing the other hat.
    const file = fromSource(['it.each([["a"], ["b"]])("handles %s", () => {});']);

    expect(file.cases).toHaveLength(1);
  });
});

describe("a table the source does not fix", () => {
  it("says so rather than counting the suite as one test", () => {
    const file = fromSource(["it.each(atRuntime())(\"handles %s\", () => {});"]);

    expect(counts(file)).toEqual({ tests: 1, entries: 1, atLeast: 1 });
    expect(file.cases[0]?.atLeast).toBe(true);
  });

  it("counts a spread as unread, because the elements are not the rows", () => {
    const file = fromSource([
      "const MORE = [[1], [2]];",
      'it.each([...MORE, [3]])("handles %s", () => {});',
    ]);

    expect(counts(file).atLeast).toBe(1);
  });

  it("reads a table a `const` in this file does fix, and not one imported from a package", () => {
    const file = fromSource([
      'import { CASES } from "some-package";',
      'it.each(CASES)("handles %s", () => {});',
    ]);

    expect(counts(file).atLeast).toBe(1);
  });

  it("marks every test inside a suite whose table went unread", () => {
    const file = fromSource([
      'describe.each(atRuntime())("in %s", () => {',
      '  it("does one thing", () => {});',
      "});",
    ]);

    expect(file.cases[0]?.atLeast).toBe(true);
  });

  it("stops at one hop, rather than following a chain as far as it happens to get", () => {
    // A table two imports away comes out unread, and the report prints a floor. The limit is
    // the point: a count that depends on how far a walk got is a count nobody can place.
    const file = testFile(
      {
        "core/src/far.ts": ['export const TABLE = [["a"], ["b"]];'],
        "core/src/near.ts": ['export { TABLE } from "./far.ts";'],
        "core/src/a.test.ts": [
          'import { TABLE } from "./near.ts";',
          'it.each(TABLE)("handles %s", () => {});',
        ],
      },
      "core/src/a.test.ts",
    );

    expect(counts(file)).toEqual({ tests: 1, entries: 1, atLeast: 1 });
  });
});

describe("the totals the report prints", () => {
  it("sums what the entries run, not how many entries there are", () => {
    const files: TestFile[] = [
      { path: "a.test.ts", cases: [{ title: "one", suite: [], tests: 4, atLeast: false }], targets: [] },
      { path: "b.test.ts", cases: [{ title: "two", suite: [], tests: 1, atLeast: true }], targets: [] },
    ];

    expect(totalTests(files)).toEqual({ tests: 5, atLeast: 1 });
  });

  it("finds more tests in this repository than it finds entries", () => {
    // Against the real tree, and deliberately without a number in it. Nine of this repo's test
    // files parameterise a suite, so the two sums differ; they were equal for as long as the
    // report counted entries, and they are equal again the moment it goes back to.
    const tests = collect(ROOT).tests;
    const entries = tests.reduce((n, file) => n + file.cases.length, 0);

    expect(totalTests(tests).tests).toBeGreaterThan(entries);
  });
});
