import { expect, it } from "vitest";
import { fitComment, GITHUB_COMMENT_LIMIT } from "./fit.ts";

/**
 * The report has to reach the pull request as one comment, under GitHub's limit, and whatever is
 * cut to get it there has to say so (#318). The fixtures are shaped the way `render.ts` writes:
 * an open summary, folds of reference material, and an open closing section.
 */

const WHERE = "in [the `pr-report` artifact](https://example.invalid/artifacts/1)";
const bytes = (text: string): number => new TextEncoder().encode(text).length;

const fold = (summary: string, lines: number, line = "- a test title that reads like behaviour"): string =>
  ["<details>", `<summary>${summary}</summary>`, "", ...Array.from({ length: lines }, () => line), "</details>", ""].join("\n");

const report = (...folds: string[]): string =>
  [
    "## What this change is, without reading it",
    "",
    "| Tests | 1975 in 99 files |",
    "",
    ...folds,
    "### Where to look, if you look anywhere",
    "",
    "- `main` at `server/src/bin.ts:21`",
  ].join("\n");

it("hands a report under the limit back exactly as it was", () => {
  const small = report(fold("<strong>Tests</strong> — 3 tests", 3));

  expect(fitComment(small, GITHUB_COMMENT_LIMIT, WHERE)).toBe(small);
});

it("cuts a report over the limit to under it, saying what was left out and where it is", () => {
  // Hebrew titles, as this repo's tests have: two bytes a letter, so a cut measured in
  // characters would come out over a limit GitHub may be counting more strictly.
  const big = report(
    fold("<strong>How the modules depend on each other</strong> — 84 modules", 50),
    fold("<strong>What the tests claim the code does</strong> — 1975 tests", 4000, "- מציג את הקורס בשבוע"),
  );
  expect(big.length).toBeGreaterThan(GITHUB_COMMENT_LIMIT);

  const fitted = fitComment(big, GITHUB_COMMENT_LIMIT, WHERE);

  expect(bytes(fitted)).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
  expect(fitted).toMatch(/^> \*\*This comment is cut to fit GitHub's limit/);
  expect(fitted).toContain(`The full report is ${WHERE}.`);
  // named at the top and where it stood, size and all, so its absence is not read as no tests
  expect(fitted).toContain("> - <strong>What the tests claim the code does</strong> — 1975 tests\n");
  expect(fitted).toMatch(
    /^> <strong>What the tests claim the code does<\/strong> — 1975 tests — \*\*left out of this comment\*\* \([\d,]+ bytes\); the section is in full in \[the `pr-report` artifact\]/m,
  );
  expect(fitted).not.toContain("מציג את הקורס בשבוע");
});

it("leaves out the largest fold while no single fold is enough, and only as many as it has to", () => {
  const big = report(
    fold("<strong>Small</strong>", 20),
    fold("<strong>Largest</strong>", 1500),
    fold("<strong>Middle</strong>", 1000),
  );
  // the largest alone is not enough to leave out, the largest and the middle are
  const limit = bytes(big) - bytes(fold("<strong>Largest</strong>", 1500)) - 1000;

  const fitted = fitComment(big, limit, WHERE);

  expect(bytes(fitted)).toBeLessThanOrEqual(limit);
  expect(fitted).toContain("> - <strong>Largest</strong>\n> - <strong>Middle</strong>\n");
  expect(fitted).toContain("<summary><strong>Small</strong></summary>");
  // the open sections either side of the folds are what a reader reads first, and stay
  expect(fitted).toContain("## What this change is, without reading it");
  expect(fitted).toContain("- `main` at `server/src/bin.ts:21`");
});

it("cuts the tail by lines when leaving out every fold is still not enough, and says so", () => {
  const unfolded = [
    "## What this change is, without reading it",
    "```mermaid",
    ...Array.from({ length: 3000 }, (_, n) => `  m${n} --> m${n + 1}`),
    "```",
    "### Where to look, if you look anywhere",
  ].join("\n");

  const fitted = fitComment(unfolded, 10_000, WHERE);

  expect(bytes(fitted)).toBeLessThanOrEqual(10_000);
  expect(fitted).toMatch(/Every folded section is left out, and the last \d+ lines of the rest too\./);
  expect(fitted).toMatch(/\n```\n\n> … and the last \d+ lines of the report, left out here\.$/);
  // the fence the cut would have left open is closed, so the notice is not swallowed by it
  expect(fitted.split("\n").filter((line) => line.startsWith("```")).length % 2).toBe(0);
});

it("counts bytes, so a Hebrew report under the limit in characters but over it in bytes is cut", () => {
  const hebrew = report(fold("<strong>What the tests claim the code does</strong>", 2500, "- מציג את הקורס בשבוע"));
  expect(hebrew.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
  expect(bytes(hebrew)).toBeGreaterThan(GITHUB_COMMENT_LIMIT);

  const fitted = fitComment(hebrew, GITHUB_COMMENT_LIMIT, WHERE);

  expect(fitted).not.toBe(hebrew);
  expect(bytes(fitted)).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
});

it("leaves out a small fold that is enough rather than a larger one", () => {
  const big = report(
    fold("<strong>Small</strong>", 100),
    fold("<strong>Largest</strong>", 1500),
    fold("<strong>Middle</strong>", 1000),
  );
  // leaving out the largest and then the small one fits; the middle need not go
  const limit = bytes(big) - bytes(fold("<strong>Largest</strong>", 1500)) - 2000;

  const fitted = fitComment(big, limit, WHERE);

  expect(bytes(fitted)).toBeLessThanOrEqual(limit);
  expect(fitted).toContain("> - <strong>Small</strong>\n> - <strong>Largest</strong>\n");
  expect(fitted).toContain("<summary><strong>Middle</strong></summary>");
});
