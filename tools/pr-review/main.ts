import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { collect } from "../pr-report/collect.ts";
import { callCycles, moduleCycles } from "./cycles.ts";
import { fetchDiff, fetchPullRequest, upsertComment } from "./github.ts";
import { MARKER } from "./outdated.ts";
import { renderReview } from "./render.ts";
import { reviewSpec, reviewStandards, reviewer, type PassOutcome } from "./review.ts";

/**
 * Posts the two-axis review on a pull request: what the code *should* be, next to the
 * `pr-report.yml` comment saying what it *is*.
 *
 * Run by `.github/workflows/pr-review.yml`. Everything it needs comes from the
 * environment, so running it locally is a matter of exporting the same five variables.
 */
const ROOT = resolve(import.meta.dirname, "../..");

/** Past this the passes read a prefix of the diff and the comment says so. */
const DIFF_LIMIT = 300_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** CLAUDE.md, the glossary, and every ADR — what the Standards pass judges against. */
function standardsDocs(): string {
  const adrDir = join(ROOT, "docs/adr");
  const adrs = readdirSync(adrDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join("docs/adr", f));

  return ["CLAUDE.md", "CONTEXT.md", ...adrs]
    .map((path) => `## ${path}\n\n${readFileSync(join(ROOT, path), "utf8")}`)
    .join("\n\n---\n\n");
}

const repo = required("GITHUB_REPOSITORY");
const token = required("GITHUB_TOKEN");
const number = Number(required("PR_NUMBER"));
const headSha = required("HEAD_SHA");
const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";

// The graphs first: they are derived from the checkout, need no key and no network, and
// a cycle in them is a finding whether or not the judgement passes ever run.
const derived = collect(ROOT);
const graphs = {
  moduleCycles: moduleCycles(derived.modules),
  callCycles: callCycles(derived.edges),
};

const [pr, wholeDiff] = await Promise.all([
  fetchPullRequest(repo, number, token),
  fetchDiff(repo, number, token),
]);

const truncated = wholeDiff.length > DIFF_LIMIT;
const input = {
  pr,
  diff: truncated ? wholeDiff.slice(0, DIFF_LIMIT) : wholeDiff,
  standardsDocs: standardsDocs(),
};

let standards: PassOutcome;
let spec: PassOutcome;

if (apiKey) {
  // Two passes, run together. Keeping them apart is the point: one asks whether a
  // project rule is broken, the other whether the ticket was answered.
  const client = reviewer(apiKey);
  [standards, spec] = await Promise.all([
    reviewStandards(client, input),
    reviewSpec(client, input),
  ]);
} else {
  const reason =
    "the `ANTHROPIC_API_KEY` repository secret is not set. A maintainer has to add it " +
    "under Settings → Secrets and variables → Actions before the judgement passes can run.";
  standards = { status: "skipped", reason };
  spec = { status: "skipped", reason };
}

const body = renderReview({
  headSha,
  graphs,
  standards,
  spec,
  ...(truncated ? { diffTruncatedAt: DIFF_LIMIT } : {}),
});

await upsertComment(repo, number, token, MARKER, body);
console.log(`reviewed ${headSha} on ${repo}#${number}`);
