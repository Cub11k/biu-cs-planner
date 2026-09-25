import { writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collect } from "./collect.ts";
import { readTestRun } from "./coverage.ts";
import { render } from "./render.ts";

/**
 * Builds the report a reviewer reads instead of the diff. Run it with:
 *
 *   npm run report            # writes pr-report.md
 *   npm run report -- --stdout
 *
 * It needs a coverage run first (`npx vitest run --coverage`) or the coverage
 * section says so rather than guessing. The reading of the source lives in
 * `collect.ts`, because the PR review checks the same graphs for cycles.
 */
const ROOT = resolve(import.meta.dirname, "../..");

/**
 * The two sources the report opens by claiming, joined here and nowhere else.
 *
 * `collect` reads the source, and it is shared with `tools/pr-review`, which wants the graphs
 * and runs no tests at all. The count a real run collected is wanted by this page alone, so it
 * is read here rather than added to what `collect` returns: the review would carry a field it
 * has no run to fill. `npm run coverage` leaves the file behind; a report built without one
 * still renders, and says that nothing checks its count (#140).
 */
const markdown = render({
  ...collect(ROOT),
  run: readTestRun(join(ROOT, "coverage/test-results.json"), ROOT),
});

if (process.argv.includes("--stdout")) {
  console.log(markdown);
} else {
  const out = join(ROOT, "pr-report.md");
  writeFileSync(out, markdown + "\n");
  console.log(`wrote ${out} (${markdown.split("\n").length} lines)`);
}

// In Actions, the same report becomes the job summary for free.
if (process.env["GITHUB_STEP_SUMMARY"]) {
  appendFileSync(process.env["GITHUB_STEP_SUMMARY"], markdown + "\n");
}
