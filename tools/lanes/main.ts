import { execFileSync } from "node:child_process";
import { lanes, render, type Issue } from "./lanes.ts";

/**
 * `npm run lanes -- <path>...`: the open issues whose body or comments name each path (#385).
 * The tracker is read through `gh`, as `docs/agents/issue-tracker.md` does, in one GraphQL query
 * because `gh issue list` does not show which parent an issue is a sub-issue of. `{owner}` and
 * `{repo}` are filled by `gh` from the clone it runs in.
 *
 * shortcut: the first 100 comments of an issue are read; page them if a thread ever grows past it.
 */
const QUERY = `
query($owner: String!, $repo: String!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 50, after: $endCursor) {
      nodes { number title body parent { number state } comments(first: 100) { nodes { body } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

type Node = {
  number: number;
  title: string;
  body: string;
  parent: { number: number; state: string } | null;
  comments: { nodes: { body: string }[] };
};

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: npm run lanes -- <path>...");
  process.exit(2);
}

const output = execFileSync(
  "gh",
  [
    "api", "graphql", "--paginate",
    "-F", "owner={owner}", "-F", "repo={repo}",
    "-f", `query=${QUERY}`,
    "--jq", ".data.repository.issues.nodes[]",
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const issues: Issue[] = output
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Node)
  .map((node) => ({
    number: node.number,
    title: node.title,
    body: node.body,
    comments: node.comments.nodes.map((comment) => comment.body),
    ...(node.parent?.state === "OPEN" ? { parent: node.parent.number } : {}),
  }));

console.log(render(paths.map((path) => ({ path, groups: lanes(path, issues) }))));
