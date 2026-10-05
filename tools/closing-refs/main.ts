import { findComment, updateComment, upsertComment } from "../pr-review/github.ts";
import { MARKER, run, type Child, type Port } from "./closing-refs.ts";
import { API, headers, ok, readClosingReferences, type Read } from "./read.ts";

/**
 * The closing-references check on one pull request, against the real GitHub API. Run by
 * `.github/workflows/closing-refs.yml`; the logic is `closing-refs.ts`, and this file is
 * only its port.
 *
 * `DRY_RUN=1` reads everything and prints the comment it would post instead of writing it,
 * which is how it is tried against a real pull request from a laptop:
 *
 *   GITHUB_REPOSITORY=Cub11k/biu-cs-planner GITHUB_TOKEN=$(gh auth token) PR_NUMBER=<n> \
 *     DRY_RUN=1 node tools/closing-refs/main.ts
 *
 * The comment helpers are `tools/pr-review/github.ts`'s, so both checks find, post and edit
 * their sticky comments the same way, each by its own marker.
 */
function port(repo: string, number: number, token: string, dryRun: boolean): Port {
  let read: Promise<Read> | undefined;
  const readOnce = (): Promise<Read> => (read ??= readClosingReferences(repo, number, token));

  return {
    repository: repo,

    async closingReferences() {
      const { references, cutAt } = await readOnce();
      return cutAt === undefined ? { numbers: references } : { numbers: references, cutAt };
    },

    async body() {
      return (await readOnce()).body;
    },

    // A parent holds at most 100 sub-issues, so one page is all of them.
    async subIssues(issue) {
      const response = await ok(
        await fetch(`${API}/repos/${repo}/issues/${issue}/sub_issues?per_page=100`, {
          headers: headers(token),
        }),
        `reading the sub-issues of #${issue}`,
      );
      const children = (await response.json()) as {
        number: number;
        state: string;
        repository_url: string;
      }[];
      // A sub-issue may live in another repository; matched by number alone it could pass
      // for, or hide, one of this repository's issues, so only this repository's count.
      const here = `${API}/repos/${repo}`.toLowerCase();
      return children
        .filter((child) => child.repository_url.toLowerCase() === here)
        .map((child): Child => ({ number: child.number, open: child.state === "open" }));
    },

    findComment: () => findComment(repo, number, token, MARKER),

    async postComment(body) {
      if (dryRun) return console.log(`would post:\n\n${body}\n`);
      await upsertComment(repo, number, token, MARKER, body);
    },

    async editComment(id, body) {
      if (dryRun) return console.log(`would edit comment ${id}:\n\n${body}\n`);
      await updateComment(repo, id, token, body);
    },
  };
}

// Never a red job: a missing variable is a warning like any other failure (see `run`).
const repo = process.env["GITHUB_REPOSITORY"];
const token = process.env["GITHUB_TOKEN"];
const number = Number(process.env["PR_NUMBER"]);

if (!repo || !token || !Number.isInteger(number) || number <= 0) {
  console.log(
    "::warning::closing-references check skipped: GITHUB_REPOSITORY, GITHUB_TOKEN and " +
      "PR_NUMBER must all be set",
  );
} else {
  await run(port(repo, number, token, process.env["DRY_RUN"] === "1"), (line) =>
    console.log(line),
  );
}
