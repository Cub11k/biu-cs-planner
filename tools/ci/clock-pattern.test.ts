import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOCK_BODY, bodyCount, clockPatterns, regexLiterals } from "./clock-pattern.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Where source lives, by extension. Documentation is prose and is not scanned. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Not source this repository writes: dependencies, build output, coverage, git's own. */
const SKIPPED_DIRECTORIES = ["node_modules", "dist", "coverage", ".git"];

/**
 * This check's own two files, left out of its own walk.
 *
 * They are the only files that write the shared body down as *data* -- one to state it, one
 * to test the stating -- so they would be read as respellings of a pattern they are in fact
 * quoting. Both are named from `import.meta.url` and not by path: this is a check declining
 * to be its own subject, not an exception for a file that carries a clock.
 */
const OWN_FILES = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./clock-pattern.ts", import.meta.url)),
];

const sourceFiles = (directory: string = ROOT): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.includes(entry.name) ? [] : sourceFiles(path);
    }
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) return [];

    return OWN_FILES.includes(path) ? [] : [path];
  });

/** A path as a reader of a failure would want to see it. */
const named = (path: string): string => relative(ROOT, path);

const read = (path: string): string => readFileSync(path, "utf8");

const everyClockPattern = (): ReturnType<typeof clockPatterns> =>
  sourceFiles().flatMap((path) => clockPatterns(named(path), read(path)));

describe("the clock patterns in this repository", () => {
  it("has source to read, so a passing suite is not an empty walk", () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  // How many copies of the body there are is ADR-0012's business, not this test's, so no
  // number is pinned here. That there is more than one is what makes a comparison mean
  // anything at all: a scan that found a single copy, or none, would agree with itself.
  it("finds the shared body in more than one file, which is what it compares", () => {
    const carrying = new Set(
      everyClockPattern()
        .filter((pattern) => pattern.bodies > 0)
        .map((pattern) => pattern.file),
    );

    expect(carrying.size).toBeGreaterThan(1);
  });

  // The invariant, and the whole point of the file. Not "these five patterns are
  // identical" -- `CLOCK_RANGE` is deliberately none of anchored, single or unflagged --
  // but "every clock any of them reads, it reads through the one shared body".
  it("builds every one of them from the one shared body", () => {
    const divergent = everyClockPattern()
      .filter((pattern) => pattern.strays.length > 0)
      .map(
        (pattern) =>
          `${pattern.file}:${pattern.line}: ${pattern.text} reads a clock at ` +
          `${pattern.strays.join(", ")} without ${CLOCK_BODY}`,
      );

    expect(divergent).toEqual([]);
  });

  // The scan is a text scan and not a parser (see `REGEX_LITERAL`), so the thing to fear is
  // that it silently stops finding what it is meant to be judging. A plain search of the
  // same files for the same body is the independent count: every occurrence the source
  // holds has to be one the scan looked at.
  it("looked at every occurrence of the body the source holds", () => {
    const missed = sourceFiles()
      .map((path) => ({ file: named(path), text: read(path) }))
      .map(({ file, text }) => ({
        file,
        inText: bodyCount(text),
        inPatterns: clockPatterns(file, text).reduce(
          (total, pattern) => total + pattern.bodies,
          0,
        ),
      }))
      .filter(({ inText, inPatterns }) => inText !== inPatterns)
      .map(
        ({ file, inText, inPatterns }) =>
          `${file}: the body appears ${inText} time(s) in the text but ${inPatterns} ` +
          `time(s) in the regex literals the scan found`,
      );

    expect(missed).toEqual([]);
  });
});

describe("clockPatterns", () => {
  it("reads the anchored spelling the schemas and core carry", () => {
    const found = clockPatterns(
      "f.ts",
      String.raw`const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;`,
    );

    expect(found).toEqual([
      {
        file: "f.ts",
        line: 1,
        text: String.raw`/^([01]\d|2[0-3]):[0-5]\d$/`,
        bodies: 1,
        strays: [],
      },
    ]);
  });

  it("accepts the Shoham range, which holds the body twice and anchors neither", () => {
    const [found] = clockPatterns(
      "dialect.ts",
      String.raw`const CLOCK_RANGE = /([01]\d|2[0-3]):[0-5]\d\s*-\s*([01]\d|2[0-3]):[0-5]\d/g;`,
    );

    expect(found?.bodies).toBe(2);
    expect(found?.strays).toEqual([]);
  });

  it("catches the unpadded reading #54 removed", () => {
    const [found] = clockPatterns("clock.ts", String.raw`const C = /^(\d{1,2}):([0-5]\d)$/;`);

    expect(found?.bodies).toBe(0);
    expect(found?.strays).toHaveLength(1);
  });

  it("catches a body widened by a single character", () => {
    const [found] = clockPatterns(
      "schema.ts",
      String.raw`const C = /^([01]\d|2[0-4]):[0-5]\d$/;`,
    );

    expect(found?.strays).toHaveLength(1);
  });

  it("catches a sixth file reading a clock its own way, listed nowhere", () => {
    const [found] = clockPatterns(
      "web/src/timetable/entry.ts",
      String.raw`const TYPED = /^\d\d:\d\d$/;`,
    );

    expect(found?.strays).toHaveLength(1);
  });

  it("catches a second opinion smuggled in beside the body", () => {
    const [found] = clockPatterns(
      "f.ts",
      String.raw`const C = /^([01]\d|2[0-3]):[0-5]\d|(\d\d):(\d\d)$/;`,
    );

    expect(found?.bodies).toBe(1);
    expect(found?.strays).toHaveLength(1);
  });

  // Every one of these is a regex this repository really holds, and none of them reads a
  // clock. A check that failed on them would be turned off within a week.
  it("leaves the repository's other colons alone", () => {
    for (const line of [
      String.raw`const INVALID = /[/\\:*?"<>|]|\p{C}/u;`,
      String.raw`const PERMISSIONS = /^permissions:/;`,
      String.raw`const WRITE = /^\s+([a-z-]+):\s*write\s*$/;`,
      String.raw`const MARKER = /^<!-- pr-review:commit=([0-9a-f]{7,40}) -->$/m;`,
      String.raw`const EDGE = /^ {2}\w+ (?:-\.->|-->) (\S+)$/;`,
      String.raw`const HEX = /(?:background|color|border[^:]*):[^;]*#[0-9a-fA-F]{3,6}/g;`,
    ]) {
      expect(clockPatterns("f.ts", line)).toEqual([]);
    }
  });

  // A clock *string* is data a test asserts on, not a second opinion about what a clock is.
  it("does not mistake a clock string in a test's regex for a pattern", () => {
    expect(clockPatterns("render.test.ts", String.raw`expect(t).toMatch(/09:00 - 10:30/);`)).toEqual(
      [],
    );
  });

  // The literal scan mis-reads this line's division as a regex literal, which is allowed to
  // happen: what matters is that no clock is found in it. It is copied from
  // `web/src/timetable/geometry.browser.test.tsx`, where the colon really is a ternary's.
  it("finds no clock in arithmetic its own scan mis-reads as a literal", () => {
    const srgb = "const c = part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;";

    expect(clockPatterns("geometry.browser.test.tsx", srgb)).toEqual([]);
  });
});

describe("regexLiterals", () => {
  it("finds the literals in a file, with the line each starts on", () => {
    const found = regexLiterals(
      ["const A = /^a$/;", "", String.raw`const B = /b\/c/gi;`].join("\n"),
    );

    expect(found).toEqual([
      { line: 1, text: "/^a$/" },
      { line: 3, text: String.raw`/b\/c/gi` },
    ]);
  });

  it("finds one passed as an argument, and keeps the flags", () => {
    expect(regexLiterals(`text.replace(/x/g, "")`)).toEqual([{ line: 1, text: "/x/g" }]);
  });

  it("does not take a character class's slash for the end of one", () => {
    expect(regexLiterals(String.raw`const A = /[/:]$/;`)).toEqual([
      { line: 1, text: String.raw`/[/:]$/` },
    ]);
  });

  it("does not read a comment's opening slashes as an empty literal", () => {
    expect(regexLiterals("const a = 1; // a note")).toEqual([]);
    expect(regexLiterals("/* a note */")).toEqual([]);
  });
});

describe("bodyCount", () => {
  it("counts the body wherever it sits, and finds none in a respelling", () => {
    expect(bodyCount(CLOCK_BODY)).toBe(1);
    expect(bodyCount(`/^${CLOCK_BODY}-${CLOCK_BODY}$/`)).toBe(2);
    expect(bodyCount(String.raw`/^(\d{1,2}):([0-5]\d)$/`)).toBe(0);
  });
});
