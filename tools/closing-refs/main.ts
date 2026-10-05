import { findComment, updateComment, upsertComment } from "../pr-review/github.ts";
import { MARKER, run, type Child, type Port } from "./closing-refs.ts";

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
const API = "https://api.github.com";

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "biu-cs-planner-closing-refs",
});

async function ok(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`${what} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

/** 100 is GitHub's page ceiling, and more closing references than that is not a pull request. */
const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 100) { nodes { number } }
    }
  }
}`;

function port(repo: string, number: number, token: string, dryRun: boolean): Port {
  const [owner, name] = repo.split("/");
  return {
    async closingReferences() {
      const response = await ok(
        await fetch(`${API}/graphql`, {
          method: "POST",
          headers: { ...headers(token), "content-type": "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { owner, name, number } }),
        }),
        "reading the closing references",
      );
      const payload = (await response.json()) as {
        errors?: { message: string }[];
        data?: {
          repository?: {
            pullRequest?: { closingIssuesReferences?: { nodes?: { number: number }[] } };
          };
        };
      };
      if (payload.errors?.length) {
        throw new Error(`reading the closing references failed: ${payload.errors[0]!.message}`);
      }
      const pr = payload.data?.repository?.pullRequest;
      if (!pr) throw new Error(`pull request ${repo}#${number} was not found`);
      return (pr.closingIssuesReferences?.nodes ?? []).map((node) => node.number);
    },

    // A parent holds at most 100 sub-issues, so one page is all of them.
    async subIssues(issue) {
      const response = await ok(
        await fetch(`${API}/repos/${repo}/issues/${issue}/sub_issues?per_page=100`, {
          headers: headers(token),
        }),
        `reading the sub-issues of #${issue}`,
      );
      const children = (await response.json()) as { number: number; state: string }[];
      return children.map((child): Child => ({ number: child.number, open: child.state === "open" }));
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
