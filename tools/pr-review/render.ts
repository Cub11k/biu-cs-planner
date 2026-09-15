import type { CallCycle, Cycle } from "./cycles.ts";
import { MARKER, commitMarker } from "./outdated.ts";
import type { Finding, PassOutcome } from "./review.ts";

/**
 * The comment itself. One per pull request, stamped with the commit it reviewed, so
 * "is this current?" is answered by looking rather than by guessing.
 */

/** Enough to act on. Past this a large diff produces a wall instead of a review. */
export const CAP = 8;

export type Graphs = {
  moduleCycles: Cycle[];
  callCycles: CallCycle[];
  /** The directories the graphs were derived from, so "acyclic" says what it covered. */
  scope: readonly string[];
};

export type ReviewComment = {
  headSha: string;
  graphs: Graphs;
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

function graphs({ moduleCycles, callCycles, scope }: Graphs, out: string[]): void {
  out.push("### The dependency graphs");
  out.push("");
  out.push(
    "Mechanical, not a judgement: the module and call graphs `tools/pr-report` derives " +
      "from the source, checked for cycles. Nothing here is re-parsed, so this and the " +
      `PR report describe the same graphs. Derived from ${scope.map((d) => `\`${d}\``).join(", ")} ` +
      "and nowhere else — a cycle outside those is not covered by either graph below.",
  );
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
    "> Two things this check does not do. It records only calls that leave the module they " +
      "are written in, so recursion that stays inside one file never shows up. And acyclic is " +
      "not the same as correctly layered: a one-way `web → core` import breaks a guardrail " +
      "without closing a loop, so it passes here and belongs to the Standards pass below.",
  );
  out.push("");
}

export function renderReview(input: ReviewComment): string {
  const out: string[] = [MARKER, commitMarker(input.headSha), ""];

  out.push(`## Two-axis review of \`${short(input.headSha)}\``);
  out.push("");
  out.push(
    "Advice, not a gate. This is never a required check and nothing below blocks a merge — " +
      "if it is wrong, say so and merge.",
  );
  out.push("");

  graphs(input.graphs, out);
  pass("Standards", "the guardrails in `CLAUDE.md` and `docs/adr/`", input.standards, out);
  pass("Spec", "what the ticket asked for", input.spec, out);

  if (input.diffTruncatedAt !== undefined) {
    out.push(
      `> The diff was longer than ${input.diffTruncatedAt.toLocaleString("en-US")} characters ` +
        "and both passes read only the first that much of it. The graph checks above still cover " +
        "the whole tree.",
    );
    out.push("");
  }

  return out.join("\n").trimEnd();
}
