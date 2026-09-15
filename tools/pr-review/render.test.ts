import { describe, expect, it } from "vitest";
import { MARKER, markOutdated, reviewedCommit } from "./outdated.ts";
import { CAP, bySeverity, renderReview, safe, type ReviewComment } from "./render.ts";
import type { Finding, PassOutcome } from "./review.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: "core/src/plan.ts",
  line: 42,
  severity: "medium",
  defect: "The credit total counts an exempt Attempt.",
  scenario: "A Plan with one exempt Attempt reports 3 credits more than it has.",
  ...over,
});

const clean: PassOutcome = {
  status: "reviewed",
  verdict: "Nothing to report.",
  unmet: [],
  findings: [],
};

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  headSha: "abcdef1234567890",
  graphs: { moduleCycles: [], callCycles: [] },
  standards: clean,
  spec: clean,
  ...over,
});

describe("safe", () => {
  it("neutralises a fold the model could otherwise close early", () => {
    expect(safe("done </details> and more")).not.toContain("</details>");
  });

  it("neutralises a comment marker, so the next run still finds its own comment", () => {
    expect(safe("looks like <!-- pr-review -->")).not.toContain("<!--");
  });

  it("flattens newlines, so a finding stays one list item", () => {
    expect(safe("one\ntwo")).toBe("one two");
  });

  it("leaves ordinary markdown and type parameters alone", () => {
    expect(safe("`Array<Attempt>` is fine")).toBe("`Array<Attempt>` is fine");
  });
});

describe("bySeverity", () => {
  it("puts what produces a wrong result above what might one day", () => {
    const order = bySeverity([
      finding({ severity: "low", file: "a.ts" }),
      finding({ severity: "high", file: "b.ts" }),
      finding({ severity: "medium", file: "c.ts" }),
    ]).map((f) => f.file);
    expect(order).toEqual(["b.ts", "c.ts", "a.ts"]);
  });
});

describe("renderReview", () => {
  it("carries the marker and the head commit it reviewed", () => {
    const body = renderReview(comment());
    expect(body.startsWith(MARKER)).toBe(true);
    expect(reviewedCommit(body)).toBe("abcdef1234567890");
    expect(body).toContain("`abcdef1`");
  });

  it("says it advises rather than gates", () => {
    expect(renderReview(comment())).toContain("nothing below blocks a merge");
  });

  it("says a clean review is clean instead of padding it", () => {
    const body = renderReview(comment());
    expect(body).toContain("**Module graph:** acyclic.");
    expect(body).toContain("Nothing to report.");
    expect(body).not.toContain("Goes wrong when");
  });

  it("reports a module cycle as a path through it", () => {
    const body = renderReview(
      comment({
        graphs: {
          moduleCycles: [["core/src/a.ts", "app/src/b.ts", "core/src/a.ts"]],
          callCycles: [],
        },
      }),
    );
    expect(body).toContain("`core/src/a.ts → app/src/b.ts → core/src/a.ts`");
    expect(body).toContain("a finding every time");
  });

  it("keeps call-graph cycles in their own paragraph and names the modules they span", () => {
    const body = renderReview(
      comment({
        graphs: {
          moduleCycles: [],
          callCycles: [
            {
              path: ["core/src/a.ts#f", "core/src/b.ts#g", "core/src/a.ts#f"],
              modules: ["core/src/a.ts", "core/src/b.ts"],
            },
          ],
        },
      }),
    );
    expect(body).toContain("**Call graph: 1 cycle.**");
    expect(body).toContain("across `core/src/a.ts`, `core/src/b.ts`");
    expect(body).toContain("recursion is legitimate");
  });

  it("keeps Standards and Spec as separate sections", () => {
    const body = renderReview(comment());
    expect(body).toContain("### Standards — the guardrails");
    expect(body).toContain("### Spec — what the ticket asked for");
    expect(body.indexOf("### Standards")).toBeLessThan(body.indexOf("### Spec"));
  });

  it("gives every finding a file, a line, a defect and a failure scenario", () => {
    const body = renderReview(
      comment({ standards: { ...clean, findings: [finding({ severity: "high" })] } }),
    );
    expect(body).toContain(
      "1. **high** · `core/src/plan.ts:42` — The credit total counts an exempt Attempt.",
    );
    expect(body).toContain(
      "   *Goes wrong when:* A Plan with one exempt Attempt reports 3 credits more than it has.",
    );
  });

  it("names the criteria the ticket asked for and the diff does not meet", () => {
    const body = renderReview(
      comment({ spec: { ...clean, unmet: ["Exam spacing is adjustable in settings"] } }),
    );
    expect(body).toContain("**Acceptance criteria the diff does not meet:**");
    expect(body).toContain("- Exam spacing is adjustable in settings");
  });

  it("caps a long list and says so, rather than printing a wall", () => {
    const many = Array.from({ length: CAP + 5 }, (_, i) =>
      finding({ file: `core/src/f${i}.ts`, severity: i === CAP + 4 ? "high" : "low" }),
    );
    const body = renderReview(comment({ standards: { ...clean, findings: many } }));

    expect(body).toContain(`Capped at the ${CAP} most severe of ${CAP + 5}.`);
    // The one high finding survives the cap; the lows past it do not.
    expect(body).toContain(`core/src/f${CAP + 4}.ts`);
    expect(body).not.toContain(`core/src/f${CAP + 3}.ts`);
  });

  it("says why a pass did not run instead of pretending it was clean", () => {
    const body = renderReview(
      comment({
        standards: { status: "skipped", reason: "no ANTHROPIC_API_KEY is set" },
        spec: { status: "failed", reason: "the model declined to review" },
      }),
    );
    expect(body).toContain("Not run: no ANTHROPIC_API_KEY is set");
    expect(body).toContain("Did not finish: the model declined to review");
  });

  it("admits when the diff was too long to send whole", () => {
    expect(renderReview(comment({ diffTruncatedAt: 300000 }))).toContain(
      "longer than 300,000 characters",
    );
  });

  it("survives being folded away on the next push", () => {
    const body = renderReview(
      comment({ standards: { ...clean, findings: [finding()] } }),
    );
    const folded = markOutdated(body, "fedcba9876543210");

    expect(folded).toContain("<code>abcdef1</code>");
    expect(folded).toContain("<code>fedcba9</code>");
    expect(folded).toContain("### Standards — the guardrails");
    expect(folded.split("<details>").length - 1).toBe(1);
  });
});
