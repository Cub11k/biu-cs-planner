import type { CallCycle, Cycle } from "./cycles.ts";
import { explain, summarise, type ForbiddenEdge } from "./layering.ts";
import { MARKER, commitMarker } from "./outdated.ts";
import type { Finding, PassOutcome } from "./review.ts";

/**
 * Two comments, because they have two different lifecycles.
 *
 * The graph check is mechanical, costs nothing and reruns on every push, so it is always
 * current and never needs a banner. The two-axis review costs money, is asked for by
 * hand, and goes stale the moment anyone pushes — so it lives in its own comment that the
 * next push folds away under a banner. Keeping them apart means the automatic run can
 * never overwrite a review somebody paid for, and a reader can never mistake a graph pass
 * for a judgement.
 */

/** The review's own comment. Unchanged from when this was one comment. */
export { MARKER as REVIEW_MARKER };

/** The graph check's comment. Distinct enough that neither marker matches the other. */
export const GRAPHS_MARKER = "<!-- pr-review-graphs -->";

/** Enough to act on. Past this a large diff produces a wall instead of a review. */
export const CAP = 8;

export type Graphs = {
  moduleCycles: Cycle[];
  callCycles: CallCycle[];
  /** Imports pointing the way the layering rule does not allow. */
  forbidden: ForbiddenEdge[];
  /** The directories the graphs were derived from, so "acyclic" says what it covered. */
  scope: readonly string[];
};

/** What, if anything, has judged the commit the graph comment describes. */
export type Judgement =
  | { kind: "not-requested" }
  | { kind: "unavailable"; reason: string }
  | { kind: "reviewed" };

export type GraphsComment = { headSha: string; graphs: Graphs; judgement: Judgement };

export type ReviewComment = {
  headSha: string;
  standards: PassOutcome;
  spec: PassOutcome;
  /** Set when the diff was too large to send whole, so the comment can admit it. */
  diffTruncatedAt?: number;
};

/**
 * Model-written text goes into a comment that later gets folded into a `<details>`
 * block, so a stray `</details>` or comment marker in it would break the fold or the
 * marker the next run looks for. Neutralising those two is enough; everything else is
 * markdown a reviewer might legitimately want.
 */
export function safe(text: string): string {
  return text
    .replace(/\r?\n+/g, " ")
    .replace(/<(\/?)(details|summary)\b/gi, "&lt;$1$2")
    .replace(/<!--/g, "&lt;!--")
    .trim();
}

const short = (sha: string): string => sha.slice(0, 7);

const RANK = { high: 0, medium: 1, low: 2 } as const;

/** Most severe first, so what the cap drops is always the least worth reading. */
export const bySeverity = (list: readonly Finding[]): Finding[] =>
  [...list].sort((a, b) => RANK[a.severity] - RANK[b.severity]);

function findings(list: Finding[], out: string[]): void {
  const ranked = bySeverity(list);
  const shown = ranked.slice(0, CAP);
  shown.forEach((f, i) => {
    out.push(
      `${i + 1}. **${f.severity}** · \`${safe(f.file)}:${f.line}\` — ${safe(f.defect)}`,
    );
    out.push(`   *Goes wrong when:* ${safe(f.scenario)}`);
  });
  if (list.length > shown.length) {
    out.push("");
    out.push(
      `Capped at the ${CAP} most severe of ${list.length}. Fix these and rerun to see the rest.`,
    );
  }
}

function pass(name: string, subtitle: string, outcome: PassOutcome, out: string[]): void {
  out.push(`### ${name} — ${subtitle}`);
  out.push("");

  if (outcome.status === "skipped") {
    out.push(`Not run: ${outcome.reason}`);
    out.push("");
    return;
  }
  if (outcome.status === "failed") {
    out.push(`Did not finish: ${safe(outcome.reason)}`);
    out.push("");
    return;
  }

  out.push(safe(outcome.verdict));
  out.push("");

  if (outcome.unmet.length) {
    out.push("**Acceptance criteria the diff does not meet:**");
    out.push("");
    for (const criterion of outcome.unmet) out.push(`- ${safe(criterion)}`);
    out.push("");
  }

  if (outcome.findings.length) {
    findings(outcome.findings, out);
    out.push("");
  }
}

/**
 * The automatic comment: the mechanical check, plus a plain statement of what has and has
 * not judged this commit. A reader must never take "no cycles" for "reviewed and clean".
 */
export function renderGraphs({ headSha, graphs, judgement }: GraphsComment): string {
  const { moduleCycles, callCycles, forbidden, scope } = graphs;
  const out: string[] = [GRAPHS_MARKER, ""];

  out.push(`## Graph check of \`${short(headSha)}\``);
  out.push("");

  if (judgement.kind === "not-requested") {
    out.push(
      "**Nothing has judged this change.** This is the mechanical check only, so no " +
        "findings below is not the same as reviewed and clean. A maintainer can ask for the " +
        "two-axis review from the Actions tab — *PR review* → *Run workflow* — with this " +
        `pull request's number.`,
    );
  } else if (judgement.kind === "unavailable") {
    out.push(
      `**Nothing has judged this change.** The two-axis review was asked for but did not run: ${judgement.reason} ` +
        "Until then this is the mechanical check only, and no findings below is not the same " +
        "as reviewed and clean.",
    );
  } else {
    out.push("The two-axis review of this commit is in its own comment on this pull request.");
  }
  out.push("");

  out.push(
    "Mechanical, not a judgement: the module and call graphs `tools/pr-report` derives " +
      "from the source, checked for cycles and against the layering rule. Nothing " +
      "here is re-parsed, so this and the PR report describe the same graphs. Derived from " +
      `${scope.map((d) => `\`${d}\``).join(", ")} and nowhere else — an edge outside those is ` +
      "not covered by anything below.",
  );
  out.push("");

  if (!forbidden.length) {
    // The rule is spelled out from the table, not beside it: a sentence written by hand
    // here would go on reassuring readers after someone edited the table.
    out.push(
      `**Layering:** every import is one the rule allows — ${summarise()}.`,
    );
  } else {
    out.push(
      `**Layering: ${forbidden.length} import${forbidden.length === 1 ? "" : "s"} the rule ` +
        "does not allow.** The allowed edges are declared in `tools/pr-review/layering.ts` — " +
        "which way each may point, which of them may carry nothing but types, and in which " +
        "spelling — an import the emit keeps is not the same as one it erases. Anything " +
        "else is a broken guardrail rather than a style preference, and this job is red " +
        "because of it.",
    );
    out.push("");
    for (const edge of forbidden) out.push(`- ${explain(edge)}`);
  }
  out.push("");

  if (!moduleCycles.length) {
    out.push("**Module graph:** acyclic.");
  } else {
    out.push(
      `**Module graph: ${moduleCycles.length} cycle${moduleCycles.length === 1 ? "" : "s"}.** ` +
        "A cycle here is a finding every time: the layering runs `core → app → server` with " +
        "`web` reaching only the API, so a back edge is a broken guardrail rather than a style " +
        "preference.",
    );
    out.push("");
    for (const cycle of moduleCycles) out.push(`- \`${cycle.join(" → ")}\``);
  }
  out.push("");

  if (!callCycles.length) {
    out.push("**Call graph:** no cycles between functions.");
  } else {
    out.push(
      `**Call graph: ${callCycles.length} cycle${callCycles.length === 1 ? "" : "s"}.** ` +
        "Not automatically defects — recursion is legitimate — so these are yours to judge. " +
        "Each one crosses a module boundary, which is the kind that usually is not.",
    );
    out.push("");
    for (const cycle of callCycles) {
      out.push(`- across \`${cycle.modules.join("\`, \`")}\``);
      out.push(`  \`${cycle.path.join(" → ")}\``);
    }
  }
  out.push("");
  out.push(
    "> Three things this check does not do. It records only calls that leave the module they " +
      "are written in, so recursion that stays inside one file never shows up. It reads only " +
      "the static `import` and `export … from` at the top of a file, so a dynamic " +
      "`await import(…)` is in neither graph. And the layering check judges the direction " +
      "between workspaces only: an import that leaves them, a layer broken inside one " +
      "workspace, and the package names a *test* file imports — the graphs keep only a " +
      "test's relative imports — are nobody's finding here and belong to the Standards pass.",
  );

  return out.join("\n").trimEnd();
}

/** The asked-for comment: the two judgement passes, and nothing mechanical. */
export function renderReview(input: ReviewComment): string {
  const out: string[] = [MARKER, commitMarker(input.headSha), ""];

  out.push(`## Two-axis review of \`${short(input.headSha)}\``);
  out.push("");
  out.push(
    "Asked for by hand, and true only of the commit named above — the next push folds this " +
      "away under an outdated banner rather than letting it look current. Advice, not a gate: " +
      "this is never a required check and nothing below blocks a merge, so if it is wrong, say " +
      "so and merge. The mechanical graph check is in its own comment and reruns on every push.",
  );
  out.push("");

  pass("Standards", "the guardrails in `CLAUDE.md` and `docs/adr/`", input.standards, out);
  pass("Spec", "what the ticket asked for", input.spec, out);

  if (input.diffTruncatedAt !== undefined) {
    out.push(
      `> The diff was longer than ${input.diffTruncatedAt.toLocaleString("en-US")} characters ` +
        "and both passes read only the first that much of it. The graph check in the other " +
        "comment still covers the whole tree.",
    );
    out.push("");
  }

  return out.join("\n").trimEnd();
}
