import { describe, expect, it } from "vitest";
import { MARKER, markOutdated, reviewedCommit } from "./outdated.ts";
import {
  CAP,
  GRAPHS_MARKER,
  bySeverity,
  renderGraphs,
  renderReview,
  safe,
  type GraphsComment,
  type ReviewComment,
} from "./render.ts";
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

const graphsComment = (over: Partial<GraphsComment> = {}): GraphsComment => ({
  headSha: "abcdef1234567890",
  graphs: { moduleCycles: [], callCycles: [], forbidden: [], scope: ["core/src", "app/src"] },
  judgement: { kind: "not-requested" },
  ...over,
});

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  headSha: "abcdef1234567890",
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

describe("the two comments are told apart by their markers", () => {
  it("does not let the graph comment answer to the review's marker", () => {
    expect(renderGraphs(graphsComment()).startsWith(MARKER)).toBe(false);
    expect(renderGraphs(graphsComment()).startsWith(GRAPHS_MARKER)).toBe(true);
  });

  it("does not let the review answer to the graph comment's marker", () => {
    expect(renderReview(comment()).startsWith(GRAPHS_MARKER)).toBe(false);
    expect(renderReview(comment()).startsWith(MARKER)).toBe(true);
  });
});

describe("renderGraphs", () => {
  it("says plainly that nothing judged the change when no review was asked for", () => {
    const body = renderGraphs(graphsComment());
    expect(body).toContain("**Nothing has judged this change.**");
    expect(body).toContain("not the same as reviewed and clean");
    expect(body).toContain("Run workflow");
  });

  it("says why when a review was asked for and could not run", () => {
    const body = renderGraphs(
      graphsComment({
        judgement: {
          kind: "unavailable",
          reason: "the `ANTHROPIC_API_KEY` repository secret is not set.",
        },
      }),
    );
    expect(body).toContain("**Nothing has judged this change.**");
    expect(body).toContain("`ANTHROPIC_API_KEY` repository secret is not set");
  });

  it("points at the other comment once a review exists", () => {
    const body = renderGraphs(graphsComment({ judgement: { kind: "reviewed" } }));
    expect(body).toContain("in its own comment");
    expect(body).not.toContain("Nothing has judged this change");
  });

  it("names the commit it checked and what it walked", () => {
    const body = renderGraphs(graphsComment());
    expect(body).toContain("## Graph check of `abcdef1`");
    expect(body).toContain("Derived from `core/src`, `app/src`");
  });

  it("reports a module cycle as a path through it", () => {
    const body = renderGraphs(
      graphsComment({
        graphs: {
          moduleCycles: [["core/src/a.ts", "app/src/b.ts", "core/src/a.ts"]],
          callCycles: [],
          forbidden: [],
          scope: ["core/src", "app/src"],
        },
      }),
    );
    expect(body).toContain("`core/src/a.ts → app/src/b.ts → core/src/a.ts`");
    expect(body).toContain("a finding every time");
  });

  it("keeps call-graph cycles in their own paragraph and names the modules they span", () => {
    const body = renderGraphs(
      graphsComment({
        graphs: {
          moduleCycles: [],
          callCycles: [
            {
              path: ["core/src/a.ts#f", "core/src/b.ts#g", "core/src/a.ts#f"],
              modules: ["core/src/a.ts", "core/src/b.ts"],
            },
          ],
          forbidden: [],
          scope: ["core/src"],
        },
      }),
    );
    expect(body).toContain("**Call graph: 1 cycle.**");
    expect(body).toContain("across `core/src/a.ts`, `core/src/b.ts`");
    expect(body).toContain("recursion is legitimate");
  });

  it("names the file, the imported module and the rule behind a forbidden edge", () => {
    const body = renderGraphs(
      graphsComment({
        graphs: {
          moduleCycles: [],
          callCycles: [],
          forbidden: [
            {
              from: "web/src/timetable/week.ts",
              fromWorkspace: "web",
              imported: "core/src/catalog/schema.ts",
              toWorkspace: "core",
              rule: "`web` knows only the HTTP API contract",
            },
          ],
          scope: ["core/src", "web/src"],
        },
      }),
    );
    expect(body).toContain("**Layering: 1 import points the wrong way.**");
    expect(body).toContain(
      "`web/src/timetable/week.ts` imports `core/src/catalog/schema.ts`; `web` may not " +
        "import `core` — `web` knows only the HTTP API contract.",
    );
    // A reader has to be told the red job is this and not a cycle.
    expect(body).toContain("this job is red because of it");
  });

  it("says a clean graph is clean instead of padding it", () => {
    const body = renderGraphs(graphsComment());
    expect(body).toContain("**Module graph:** acyclic.");
    expect(body).toContain("**Call graph:** no cycles between functions.");
    expect(body).toContain(
      "**Layering:** every import points the way the rule says it should — `core` imports " +
        "none of the others, `app` imports `core`, `server` imports `core` and `app`, " +
        "`web` imports `server`.",
    );
  });
});

describe("renderReview", () => {
  it("carries the marker and the head commit it reviewed", () => {
    const body = renderReview(comment());
    expect(reviewedCommit(body)).toBe("abcdef1234567890");
    expect(body).toContain("## Two-axis review of `abcdef1`");
  });

  it("says it advises rather than gates, and that it will not stay current", () => {
    const body = renderReview(comment());
    expect(body).toContain("nothing below blocks a merge");
    expect(body).toContain("the next push folds this away");
  });

  it("holds no graph section, which lives in the comment that reruns on every push", () => {
    expect(renderReview(comment())).not.toContain("Module graph");
  });

  it("says a clean review is clean instead of padding it", () => {
    const body = renderReview(comment());
    expect(body).toContain("Nothing to report.");
    expect(body).not.toContain("Goes wrong when");
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
    const body = renderReview(comment({ standards: { ...clean, findings: [finding()] } }));
    const folded = markOutdated(body, "fedcba9876543210");

    expect(folded).toContain("<code>abcdef1</code>");
    expect(folded).toContain("<code>fedcba9</code>");
    expect(folded).toContain("### Standards — the guardrails");
    expect(folded.split("<details>").length - 1).toBe(1);
  });
});
