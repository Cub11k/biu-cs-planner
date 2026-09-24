/**
 * Turning a review that has been overtaken by a push into one that admits it.
 *
 * The reader's complaint is not that the old review exists, it is having to work out
 * which of two reviews describes the code in front of them. So the banner goes on before
 * the new review is written, the whole body folds into one line, and nothing is deleted:
 * the old text is still there for anyone comparing runs.
 */
export const MARKER = "<!-- pr-review -->";

const COMMIT_MARKER = /^<!-- pr-review:commit=([0-9a-f]{7,40}) -->$/m;

/** The head commit a review comment says it reviewed, or undefined if it never said. */
export function reviewedCommit(body: string): string | undefined {
  return COMMIT_MARKER.exec(body)?.[1];
}

export const commitMarker = (sha: string): string => `<!-- pr-review:commit=${sha} -->`;

const short = (sha: string): string => sha.slice(0, 7);

/**
 * The body without its markers, and without the `<details>` wrapper if a previous push
 * already folded it. Unwrapping matters: a run cancelled by the next push leaves the
 * banner in place, and the push after that must re-stamp it rather than nest a second
 * fold around the first.
 */
function unwrap(body: string): string {
  const withoutMarkers = body
    .split("\n")
    .filter((line) => !line.startsWith("<!-- pr-review"))
    .join("\n")
    .trim();

  if (!withoutMarkers.startsWith("<details>")) return withoutMarkers;

  const opened = withoutMarkers.indexOf("</summary>");
  const closed = withoutMarkers.lastIndexOf("</details>");
  if (opened === -1 || closed === -1 || closed < opened) return withoutMarkers;

  return withoutMarkers.slice(opened + "</summary>".length, closed).trim();
}

/**
 * Rewrites a review comment as an outdated one: a banner naming the commit it described
 * and the commit now under review, with the review itself collapsed behind it.
 *
 * The blank line after `</summary>` is load-bearing. Rendered through GitHub's own
 * markdown endpoint, a body without it comes back with its headings as literal `###`
 * text; with it, they come back as headings.
 */
export function markOutdated(body: string, nowUnderReview: string): string {
  const reviewed = reviewedCommit(body);
  const described = reviewed ? `<code>${short(reviewed)}</code>` : "an earlier commit";

  return [
    MARKER,
    ...(reviewed ? [commitMarker(reviewed)] : []),
    "",
    "<details>",
    `<summary>⚠️ Outdated — this reviewed ${described}; <code>${short(nowUnderReview)}</code> is now under review.</summary>`,
    "",
    unwrap(body),
    "",
    "</details>",
  ].join("\n");
}
