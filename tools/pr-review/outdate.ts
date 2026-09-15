import { findComment, updateComment } from "./github.ts";
import { MARKER, markOutdated } from "./outdated.ts";

/**
 * Marks the review already on a pull request as outdated, and folds it away.
 *
 * This runs *before* the review does, which is the whole point: doing it afterwards only
 * narrows the window in which a stale review looks authoritative, instead of closing it.
 * If the run that follows fails or is cancelled, the banner stays — a comment that admits
 * it is outdated beats one that silently describes deleted code.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const repo = required("GITHUB_REPOSITORY");
const token = required("GITHUB_TOKEN");
const number = Number(required("PR_NUMBER"));
const headSha = required("HEAD_SHA");

const existing = await findComment(repo, number, token, MARKER);

if (!existing) {
  console.log("no review on this pull request yet, so nothing to mark outdated");
} else {
  await updateComment(repo, existing.id, token, markOutdated(existing.body, headSha));
  console.log(`marked the review on ${repo}#${number} outdated against ${headSha}`);
}
