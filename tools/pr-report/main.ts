import { writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collect } from "./collect.ts";
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

const markdown = render(collect(ROOT));

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
