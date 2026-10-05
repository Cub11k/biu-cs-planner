/**
 * Fitting the report into one pull request comment (#318).
 *
 * GitHub refuses a comment body over 65,536 characters, and the report describes the whole tree
 * rather than the diff, so it outgrew that long ago: on 2026-10-05 it was some 300,000 bytes, and
 * PR #317's post was refused outright (`Body is too long`), leaving no report on the pull request
 * at all. The full report still goes to the job summary and to a workflow artifact; this decides
 * what of it the comment can carry.
 *
 * **Whatever is cut is cut visibly.** A report that silently drops part of the test list reads as
 * an absence of tests, which is worse than no report. So a cut is made a whole fold at a time,
 * largest first, and each fold left out stays in the comment as its own one-line summary — which
 * already carries its size — saying it was left out and where it is. The comment opens by naming
 * every section it left out. Only if every fold is gone and the rest is still too long is the tail
 * cut by lines, and that cut says how many lines it took.
 *
 * Size is measured in **UTF-8 bytes**, not characters. GitHub words its limit in characters and
 * does not say how it counts them; a byte is never fewer than one character by any count, so a
 * comment under the limit in bytes is under it however GitHub counts, at the cost of cutting a
 * Hebrew-heavy report a little sooner than strictly needed.
 */

/** GitHub's limit on one comment body. */
export const GITHUB_COMMENT_LIMIT = 65_536;

const encoder = new TextEncoder();
const size = (text: string): number => encoder.encode(text).length;

/** One top-level `<details>` fold: the lines it spans, inclusive, and its summary's inside. */
type Fold = { start: number; end: number; summary: string };

/**
 * The top-level folds, as `render.ts` writes them: `<details>` and `</details>` alone on their
 * lines, with `<summary>…</summary>` on the line after the opener. Nested folds count toward
 * their outer one and are never cut on their own; a fold the report never closes is not a fold.
 */
function foldsOf(lines: readonly string[]): Fold[] {
  const folds: Fold[] = [];
  let depth = 0;
  let start = -1;
  lines.forEach((line, index) => {
    if (line === "<details>") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (line === "</details>" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        const summary = /^<summary>(.*)<\/summary>$/.exec(lines[start + 1] ?? "")?.[1];
        folds.push({ start, end: index, summary: summary ?? "A folded section" });
      }
    }
  });
  return folds;
}

const bytes = (n: number): string => `${n.toLocaleString("en-US")} bytes`;

/**
 * The comment to post: `report` itself when it fits in `limit`, and otherwise the report with
 * whole folds left out, largest first, until it does — each one named where it stood and in a
 * notice at the top, both pointing at `fullReport`, a markdown phrase saying where the whole
 * report is ("in [the `pr-report` artifact](…)").
 */
export function fitComment(report: string, limit: number, fullReport: string): string {
  if (size(report) <= limit) return report;

  const lines = report.split("\n");
  const folds = foldsOf(lines);
  const bodySize = (fold: Fold): number => size(lines.slice(fold.start, fold.end + 1).join("\n"));
  const largestFirst = [...folds].sort((a, b) => bodySize(b) - bodySize(a));

  const omitted = new Set<Fold>();
  const build = (): { text: string; kept: string[] } => {
    const kept: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const fold = folds.find((candidate) => candidate.start === index);
      if (fold !== undefined && omitted.has(fold)) {
        kept.push(
          `> ${fold.summary} — **left out of this comment** (${bytes(bodySize(fold))}); ` +
            `the section is in full ${fullReport}.`,
        );
        index = fold.end;
      } else {
        kept.push(lines[index] ?? "");
      }
    }
    return { text: kept.join("\n"), kept };
  };
  const notice = (tail: string): string => {
    const named = folds.filter((fold) => omitted.has(fold)).map((fold) => fold.summary);
    return [
      `> **This comment is cut to fit GitHub's limit of ${GITHUB_COMMENT_LIMIT.toLocaleString("en-US")} ` +
        `characters on one comment.** The full report is ${fullReport}.`,
      ...(named.length ? [">", "> Left out here:", ...named.map((summary) => `> - ${summary}`)] : []),
      ...(tail ? [">", `> ${tail}`] : []),
      "",
      "",
    ].join("\n");
  };

  for (const fold of largestFirst) {
    omitted.add(fold);
    const text = notice("") + build().text;
    if (size(text) <= limit) return text;
  }

  // Every fold is out and it is still too long: cut the tail by whole lines, closing a code
  // fence the cut would leave open so the rest of the comment is not swallowed by it.
  const { kept } = build();
  for (let keep = kept.length - 1; keep >= 0; keep -= 1) {
    const head = kept.slice(0, keep);
    const fences = head.filter((line) => line.trimStart().startsWith("```")).length;
    const left = kept.length - keep;
    const ending = `${fences % 2 === 1 ? "```\n" : ""}\n> … and the last ${left} ${left === 1 ? "line" : "lines"} of the report, left out here.`;
    const text =
      notice(`Every folded section is left out, and the last ${left} ${left === 1 ? "line" : "lines"} of the rest too.`) +
      head.join("\n") +
      "\n" +
      ending;
    if (size(text) <= limit) return text;
  }
  return notice("Nothing of the report fits in this comment.");
}
