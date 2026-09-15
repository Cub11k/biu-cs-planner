import { resolve } from "node:path";
import { SOURCE_DIRS, collect } from "../pr-report/collect.ts";
import { callCycles, moduleCycles } from "./cycles.ts";
import { fetchDiff, fetchPullRequest, fetchStandardsDocs, upsertComment } from "./github.ts";
import { MARKER } from "./outdated.ts";
import { renderReview } from "./render.ts";
import { reviewSpec, reviewStandards, reviewer, type PassOutcome } from "./review.ts";

/**
 * Posts the two-axis review on a pull request: what the code *should* be, next to the
 * `pr-report.yml` comment saying what it *is*.
 *
 * Run by `.github/workflows/pr-review.yml`. Everything it needs comes from the
 * environment, so running it locally is a matter of exporting the same six variables.
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
const headSha = required("HEAD_SHA");
const baseSha = required("BASE_SHA");
const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";

// The graphs first: they are derived from the checkout, need no key and no network, and
// a cycle in them is a finding whether or not the judgement passes ever run.
const derived = collect(ROOT);
const graphs = {
  moduleCycles: moduleCycles(derived.modules),
  callCycles: callCycles(derived.edges),
  scope: SOURCE_DIRS,
};

let standards: PassOutcome;
let spec: PassOutcome;
let truncated = false;

if (!apiKey) {
  const reason =
    "the `ANTHROPIC_API_KEY` repository secret is not set. A maintainer has to add it " +
    "under Settings → Secrets and variables → Actions before the judgement passes can run.";
  standards = { status: "skipped", reason };
  spec = { status: "skipped", reason };
} else {
  try {
    // The standards come from the base commit, not from the checkout: on a pull_request
    // event the checkout is the merge commit, so a change that relaxed a guardrail would
    // otherwise be judged against its own edited copy of the rules.
    const [pr, wholeDiff, standardsDocs] = await Promise.all([
      fetchPullRequest(repo, number, token),
      fetchDiff(repo, number, token),
      fetchStandardsDocs(repo, baseSha, token),
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
    // Both passes fail together here, which the check below turns into "leave the
    // previous review folded where it is" rather than a comment that reviewed nothing.
    const reason = `the review could not read what it needed: ${message(error)}`;
    standards = { status: "failed", reason };
    spec = { status: "failed", reason };
  }
}

// If neither pass got anywhere, the comment is left exactly as the outdate step left it:
// the previous review, folded, under a banner saying which commit it described and which
// one is now under review. Overwriting that with "Did not finish" would delete a real
// review and replace it with nothing, which is the outcome the banner exists to prevent.
// A missing API key is not this case — that is a steady state, not a failure, and saying
// so on every pull request is how the maintainer finds out.
if (standards.status === "failed" && spec.status === "failed") {
  console.error(`neither pass reviewed ${headSha}: ${standards.reason}`);
  console.error("leaving the outdated banner standing rather than overwriting it");
  process.exitCode = 1;
} else {
  const body = renderReview({
    headSha,
    graphs,
    standards,
    spec,
    ...(truncated ? { diffTruncatedAt: DIFF_LIMIT } : {}),
  });

  await upsertComment(repo, number, token, MARKER, body);
  console.log(`reviewed ${headSha} on ${repo}#${number}`);
}
