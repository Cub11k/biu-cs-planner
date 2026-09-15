import { describe, expect, it } from "vitest";
import { MARKER, commitMarker, markOutdated, reviewedCommit } from "./outdated.ts";

const review = (sha: string, body: string): string =>
  [MARKER, commitMarker(sha), "", body].join("\n");

describe("reviewedCommit", () => {
  it("reads the commit a review stamped itself with", () => {
    expect(reviewedCommit(review("abc1234def", "## Review"))).toBe("abc1234def");
  });

  it("returns nothing for a comment that never said", () => {
    expect(reviewedCommit(`${MARKER}\n\n## Review`)).toBeUndefined();
  });
});

describe("markOutdated", () => {
  const body = ["## Two-axis review", "", "### Standards", "", "Nothing to report."].join(
    "\n",
  );

  it("names both the commit it reviewed and the one now under review", () => {
    const out = markOutdated(review("aaaaaaaaaa", body), "bbbbbbbbbb");
    expect(out).toContain("<code>aaaaaaa</code>");
    expect(out).toContain("<code>bbbbbbb</code>");
  });

  it("puts the banner in the summary, so the fold reads while closed", () => {
    const summary = markOutdated(review("aaaaaaaaaa", body), "bbbbbbbbbb")
      .split("\n")
      .find((line) => line.startsWith("<summary>"));
    expect(summary).toContain("Outdated");
    expect(summary).toContain("aaaaaaa");
    expect(summary).toContain("bbbbbbb");
  });

  it("leaves a blank line after the summary, or the markdown inside renders literally", () => {
    const lines = markOutdated(review("aaaaaaaaaa", body), "bbbbbbbbbb").split("\n");
    const summary = lines.findIndex((line) => line.startsWith("<summary>"));
    expect(lines[summary + 1]).toBe("");
  });

  it("deletes nothing — the whole review is still inside the fold", () => {
    const out = markOutdated(review("aaaaaaaaaa", body), "bbbbbbbbbb");
    expect(out).toContain(body);
  });

  it("keeps the marker, so the comment is still the one a rerun edits", () => {
    expect(markOutdated(review("aaaaaaaaaa", body), "bbbbbbbbbb").startsWith(MARKER)).toBe(
      true,
    );
  });

  it("keeps stamping the commit the fold describes, not the new one", () => {
    const out = markOutdated(review("aaaaaaaaaa", body), "bbbbbbbbbb");
    expect(reviewedCommit(out)).toBe("aaaaaaaaaa");
  });

  it("re-stamps an already folded review instead of nesting a second fold", () => {
    // A cancelled run leaves the banner standing; the next push must update it.
    const once = markOutdated(review("aaaaaaaaaa", body), "bbbbbbbbbb");
    const twice = markOutdated(once, "cccccccccc");

    expect(twice.split("<details>").length - 1).toBe(1);
    expect(twice).toContain("<code>ccccccc</code>");
    expect(twice).not.toContain("bbbbbbb");
    expect(twice).toContain(body);
  });

  it("still folds a comment that carries no commit marker", () => {
    const out = markOutdated(`${MARKER}\n\n${body}`, "bbbbbbbbbb");
    expect(out).toContain("an earlier commit");
    expect(out).toContain(body);
  });
});
