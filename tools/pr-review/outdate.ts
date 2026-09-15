import { fetchPullRequest, findComment, updateComment } from "./github.ts";
import { MARKER, markOutdated } from "./outdated.ts";

/**
 * Marks the two-axis review already on a pull request as outdated, and folds it away.
 *
 * This runs *before* anything else, which is the whole point: doing it afterwards only
 * narrows the window in which a stale review looks authoritative, instead of closing it.
 * If what follows fails or is cancelled, the banner stays — a comment that admits it is
 * outdated beats one that silently describes deleted code.
 *
 * It matters more now that the review is asked for by hand than it did when every push
 * produced a new one: nothing else will ever replace a review from three pushes ago, so
 * folding it away on each push is the only thing keeping it honest. The graph comment is
 * left alone — it is rewritten on every push and so is never stale.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const repo = required("GITHUB_REPOSITORY");
const token = required("GITHUB_TOKEN");
const number = Number(required("PR_NUMBER"));

const existing = await findComment(repo, number, token, MARKER);

if (!existing) {
  console.log("no review on this pull request yet, so nothing to mark outdated");
} else {
  const { headSha } = await fetchPullRequest(repo, number, token);
  await updateComment(repo, existing.id, token, markOutdated(existing.body, headSha));
  console.log(`marked the review on ${repo}#${number} outdated against ${headSha}`);
}
