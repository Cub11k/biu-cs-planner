import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fitComment, GITHUB_COMMENT_LIMIT } from "./fit.ts";

/**
 * Turns `pr-report.md` into the comment body `pr-report.yml` posts (#318), on stdout:
 *
 *   node tools/pr-report/comment.ts <marker> <where the full report is> > comment.md
 *
 * The marker is the workflow's, passed in rather than repeated here, because the same step
 * searches for it to find the comment to edit and the two must not drift. The second argument
 * is the markdown phrase the comment points at for the whole report — the workflow passes a link
 * to the artifact it uploaded. The marker and the blank line after it count toward the limit.
 */
const ROOT = resolve(import.meta.dirname, "../..");

const [marker, fullReport] = process.argv.slice(2);
if (marker === undefined || fullReport === undefined) {
  console.error("usage: node tools/pr-report/comment.ts <marker> <where the full report is>");
  process.exit(2);
}

const prefix = `${marker}\n\n`;
const report = readFileSync(join(ROOT, "pr-report.md"), "utf8");
const budget = GITHUB_COMMENT_LIMIT - new TextEncoder().encode(prefix).length;
const body = fitComment(report, budget, fullReport);

process.stdout.write(prefix + body);
// What was done goes to stderr, so the log says it and the body stays only the body.
console.error(
  body === report
    ? "the comment carries the whole report"
    : `the comment carries a cut report: ${new TextEncoder().encode(body).length} of ` +
        `${new TextEncoder().encode(report).length} bytes`,
);
