import { resolve } from "node:path";
import { SOURCE_DIRS, collect } from "../pr-report/collect.ts";
import { callCycles, moduleCycles } from "./cycles.ts";
import { explain, forbiddenEdges } from "./layering.ts";
import { fetchDiff, fetchPullRequest, fetchStandardsDocs, upsertComment } from "./github.ts";
import {
  GRAPHS_MARKER,
  REVIEW_MARKER,
  renderGraphs,
  renderReview,
  type Judgement,
} from "./render.ts";
import { reviewSpec, reviewStandards, reviewer, type PassOutcome } from "./review.ts";

/**
 * Posts the graph check on a pull request, and the two-axis review when one was asked
 * for. Run by `.github/workflows/pr-review.yml`.
 *
 * `REVIEW_MODE=graphs` is every code pull request: mechanical only, no key, no cost.
 * `REVIEW_MODE=full` is a maintainer pressing "Run workflow": the judgement passes too,
 * if and only if the `ANTHROPIC_API_KEY` secret is actually set.
 */
const ROOT = resolve(import.meta.dirname, "../..");

/** Past this the passes read a prefix of the diff and the comment says so. */
const DIFF_LIMIT = 300_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const repo = required("GITHUB_REPOSITORY");
const token = required("GITHUB_TOKEN");
const number = Number(required("PR_NUMBER"));
const full = required("REVIEW_MODE") === "full";
const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";

const pr = await fetchPullRequest(repo, number, token);

// The workflow refuses a fork too, but `workflow_dispatch` takes a number typed by hand,
// so the refusal has to live where the number is resolved rather than only in the trigger.
if (pr.isFork) {
  console.error(`${repo}#${number} comes from a fork, which this workflow does not review`);
  process.exit(1);
}

// The graphs are derived from the checkout: no key, no network, no cost. A cycle in them,
// or an import pointing the wrong way through the layers, is a finding whether or not
// anybody ever asks for a judgement.
const derived = collect(ROOT);
const graphs = {
  moduleCycles: moduleCycles(derived.modules),
  callCycles: callCycles(derived.edges),
  forbidden: forbiddenEdges(derived.modules),
  scope: SOURCE_DIRS,
};

let standards: PassOutcome | undefined;
let spec: PassOutcome | undefined;
let judgement: Judgement = { kind: "not-requested" };
let truncated = false;

if (full && !apiKey) {
  // Gated on the secret itself, not on a flag somebody could set without it. Absent, the
  // passes do not run, the graph comment says so, and the job stays green.
  judgement = {
    kind: "unavailable",
    reason:
      "the `ANTHROPIC_API_KEY` repository secret is not set, so a maintainer has to add it " +
      "under Settings → Secrets and variables → Actions first.",
  };
} else if (full) {
  try {
    // The standards come from the base commit, not from the checkout: on a pull_request
    // event the checkout is the merge commit, so a change that relaxed a guardrail would
    // otherwise be judged against its own edited copy of the rules.
    const [wholeDiff, standardsDocs] = await Promise.all([
      fetchDiff(repo, number, token),
      fetchStandardsDocs(repo, pr.baseSha, token),
    ]);

    truncated = wholeDiff.length > DIFF_LIMIT;
    const input = {
      pr,
      diff: truncated ? wholeDiff.slice(0, DIFF_LIMIT) : wholeDiff,
      standardsDocs,
    };

    // Two passes, run together. Keeping them apart is the point: one asks whether a
    // project rule is broken, the other whether the ticket was answered.
    const client = reviewer(apiKey);
    [standards, spec] = await Promise.all([
      reviewStandards(client, input),
      reviewSpec(client, input),
    ]);
  } catch (error) {
    const reason = `the review could not read what it needed: ${message(error)}`;
    standards = { status: "failed", reason };
    spec = { status: "failed", reason };
  }

  if (standards.status === "reviewed" || spec.status === "reviewed") {
    judgement = { kind: "reviewed" };
  } else {
    judgement = { kind: "unavailable", reason: `${standards.reason}.` };
  }
}

await upsertComment(
  repo,
  number,
  token,
  GRAPHS_MARKER,
  renderGraphs({ headSha: pr.headSha, graphs, judgement }),
);

// The one thing in this workflow that is not advice. A forbidden edge is the layering rule
// broken, so the job goes red — after the comment is posted, because a red job with no
// explanation on the pull request is worse than no check at all.
if (graphs.forbidden.length) {
  for (const edge of graphs.forbidden) console.error(explain(edge));
  process.exitCode = 1;
}

if (judgement.kind === "reviewed" && standards && spec) {
  await upsertComment(
    repo,
    number,
    token,
    REVIEW_MARKER,
    renderReview({
      headSha: pr.headSha,
      standards,
      spec,
      ...(truncated ? { diffTruncatedAt: DIFF_LIMIT } : {}),
    }),
  );
  console.log(`reviewed ${pr.headSha} on ${repo}#${number}`);
} else if (full && apiKey) {
  // The review comment is left exactly as the outdate step left it: the previous review,
  // folded, under a banner. Overwriting it with "did not finish" would delete a real
  // review and replace it with nothing, which is what the banner exists to prevent.
  console.error(`neither pass reviewed ${pr.headSha} on ${repo}#${number}`);
  process.exitCode = 1;
} else if (full) {
  // Asked for, but the secret is missing. That is a state for a maintainer to fix, not a
  // failure: the graph comment says so and the job stays green.
  console.log("no ANTHROPIC_API_KEY, so the judgement passes did not run");
} else {
  console.log(`checked the graphs of ${pr.headSha} on ${repo}#${number}`);
}
