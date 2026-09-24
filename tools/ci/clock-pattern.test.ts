import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClockPattern } from "./clock-pattern.ts";
import { CLOCK_BODY, bodyCount, clockPatterns, codeOnly, regexLiterals } from "./clock-pattern.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Where a regex literal can live. `.html` is in the list for `prototypes/`, whose page carries
 * its script inline; documentation is prose and is not scanned.
 */
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
];

/**
 * Not source this repository writes: dependencies and build output by name, and every
 * dot-directory, which is where the toolchain, the caches and the session transcripts live
 * (`.gitignore` lists them; `.github` holds no code).
 *
 * The walk reads the disk rather than `git ls-files`, so an untracked file is judged too --
 * which is the point, a new file carrying a clock should fail before it is committed, not
 * after. It also means a scratch file of your own can fail the suite locally; that is the
 * same check CI would run on it a minute later.
 */
const SKIPPED_DIRECTORIES = ["node_modules", "dist", "coverage"];

const skipped = (name: string): boolean =>
  name.startsWith(".") || SKIPPED_DIRECTORIES.includes(name);

/**
 * This check's own two files, left out of its own walk.
 *
 * They are the only files that write the shared body down as *data* -- one to state it, one
 * to test the stating -- so they would be read as respellings of a pattern they are in fact
 * quoting. Both are named from `import.meta.url` and not by path: this is a check declining
 * to be its own subject, not an exception for a file that carries a clock.
 *
 * The cost is real and worth stating: a clock pattern added to either of these two files
 * later would go unguarded. Neither has a reason to read a clock, and the shared body they
 * do hold is `CLOCK_BODY` -- a string that is searched for, never matched with.
 */
const OWN_FILES = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./clock-pattern.ts", import.meta.url)),
];

const sourceFiles = (directory: string = ROOT): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return skipped(entry.name) ? [] : sourceFiles(path);
    }
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) return [];

    return OWN_FILES.includes(path) ? [] : [path];
  });

/** A path as a reader of a failure would want to see it. */
const named = (path: string): string => relative(ROOT, path);

const read = (path: string): string => readFileSync(path, "utf8");

const everyClockPattern = (): ClockPattern[] =>
  sourceFiles().flatMap((path) => clockPatterns(named(path), read(path)));

describe("the clock patterns in this repository", () => {
  it("has source to read, so a passing suite is not an empty walk", () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  // How many copies of the body there are is ADR-0012's business, not this test's, so no
  // number is pinned here. What is pinned is that they are found in more than one file and in
  // more than one top-level folder, because that is what makes a comparison mean anything: a
  // scan that found one copy, or none, would agree with itself, and a walk that quietly
  // stopped descending into `web` would still find four copies in `core` and say nothing.
  // `core` and `web` each holding one is ADR-0002 -- `web` never imports `core`.
  it("finds the shared body in more than one file, and in more than one folder", () => {
    const carrying = everyClockPattern()
      .filter((pattern) => pattern.bodies > 0)
      .map((pattern) => pattern.file);

    expect(new Set(carrying).size).toBeGreaterThan(1);
    expect(new Set(carrying.map((file) => file.split("/")[0])).size).toBeGreaterThan(1);
  });

  // The invariant, and the whole point of the file. Not "these five patterns are
  // identical" -- `CLOCK_RANGE` is deliberately none of anchored, single or unflagged --
  // but "every clock any of them reads, it reads through the one shared body".
  it("are each built from the one shared body", () => {
    const divergent = everyClockPattern()
      .filter((pattern) => pattern.strays.length > 0)
      .map(
        (pattern) =>
          `${pattern.file}:${pattern.line}: ${pattern.text} reads a clock at ` +
          `${pattern.strays.join(", ")} without ${CLOCK_BODY}`,
      );

    // If a finding here is not a clock at all -- a `host:port` or a `file:line:column` parse
    // reads as one, and deliberately so, because a check that stays quiet when it is unsure
    // guards nothing -- then the seam rule in `clock-pattern.ts` needs widening on purpose,
    // with the new case pinned below beside the others. Not an exception for the file.

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
        inText: bodyCount(codeOnly(text)),
        inPatterns: clockPatterns(file, text).reduce(
          (total, pattern) => total + pattern.bodies,
          0,
        ),
      }))
      .filter(({ inText, inPatterns }) => inText !== inPatterns)
      .map(
        ({ file, inText, inPatterns }) =>
          `${file}: the body appears ${inText} times in the code but ${inPatterns} times in ` +
          `the regex literals the scan found, so the scan is walking past one — unless the ` +
          `extra one is written in a string, or in a comment sharing a line with code, ` +
          `either of which belongs on a prose line of its own`,
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

  // A reader made lenient about whitespace is the drift #48 and #54 are about, and it hides
  // behind the `\s` the seam would otherwise trip over.
  it("catches a clock that has grown lenient about whitespace", () => {
    const [found] = clockPatterns(
      "week.ts",
      String.raw`const C = /^([01]\d|2[0-3])\s*:\s*[0-5]\d$/;`,
    );

    expect(found?.bodies).toBe(0);
    expect(found?.strays).toHaveLength(1);
  });

  // Behaviourally identical to the body, spelled differently, which is what ADR-0012 is
  // about. Respelling the colon would otherwise be the one tidy that turns the guard off.
  it("catches the body's colon spelled some other way", () => {
    for (const colon of [String.raw`[:]`, String.raw`\:`, String.raw`\u003a`, String.raw`\x3A`]) {
      const line = String.raw`const C = /^([01]\d|2[0-3])` + colon + String.raw`[0-5]\d$/;`;
      const [found] = clockPatterns("schema.ts", line);

      expect(found?.bodies, line).toBe(0);
      expect(found?.strays, line).toHaveLength(1);
    }
  });

  // Chosen, not accidental. A regex that parses `file:line:column` or `host:port` reads as a
  // clock here and fails the repository-wide test: a digit matcher against a colon is as far
  // as a text scan can see, and a check that stayed quiet whenever it was unsure would have
  // let #54 through. The repository holds no such regex today; when one arrives, the seam rule
  // gets widened on purpose and the new shape pinned here, rather than the file excused.
  it("reads a file:line:column parse as a clock, and says so out loud", () => {
    const [found] = clockPatterns("trace.ts", String.raw`const AT = /at (.+):(\d+):(\d+)$/;`);

    expect(found?.strays).toHaveLength(1);
  });

  // Every one of these is a regex this repository really holds -- in `app/src/workspace.ts`,
  // `tools/ci/workflows.ts` twice, `tools/pr-review/outdated.ts`, `tools/pr-report/render.test.ts`
  // and `prototypes/timetable.prototype.checks.js` -- and none of them reads a clock. A check
  // that failed on them would be turned off within a week.
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

describe("codeOnly", () => {
  // The repository documents its patterns in prose constantly, including in this file, so the
  // count the cross-check makes has to be a count of what the code holds.
  it("drops prose lines and leaves code lines exactly as they are", () => {
    const source = [
      "/**",
      ` * A clock is ${CLOCK_BODY}, quoted here and matched nowhere.`,
      " */",
      `const CLOCK_TIME = /^${CLOCK_BODY}$/;`,
      `// and once more: ${CLOCK_BODY}`,
    ].join("\n");

    expect(bodyCount(source)).toBe(3);
    expect(bodyCount(codeOnly(source))).toBe(1);
    expect(codeOnly(source)).toBe(`const CLOCK_TIME = /^${CLOCK_BODY}$/;`);
  });
});
