/**
 * The GitHub side of the review: what the pull request is, what the diff says, which
 * issues it closes, and the one sticky comment the review lives in.
 *
 * `pr-report.yml` does the same find-or-create-and-edit dance in shell; this does it here
 * because the acceptance criteria of the issue a pull request closes are only reachable
 * through GraphQL, and threading that through `jq` would be more code than the fetches.
 */
const API = "https://api.github.com";

export type LinkedIssue = { number: number; title: string; body: string };

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  /** The commit under review. */
  headSha: string;
  /** The base branch tip — where the standards are read from, not the merge commit. */
  baseSha: string;
  /** True when the change comes from a fork, which never gets near the key. */
  isFork: boolean;
  /** The issues this pull request closes, whose acceptance criteria the Spec pass reads. */
  closes: LinkedIssue[];
};

async function ok(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`${what} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

const headers = (token: string, accept: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept,
  "x-github-api-version": "2022-11-28",
  "user-agent": "biu-cs-planner-pr-review",
});

const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      body
      headRefOid
      baseRefOid
      isCrossRepository
      closingIssuesReferences(first: 5) {
        nodes { number title body }
      }
    }
  }
}`;

export async function fetchPullRequest(
  repo: string,
  number: number,
  token: string,
): Promise<PullRequest> {
  const [owner, name] = repo.split("/");
  const response = await ok(
    await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { ...headers(token, "application/json"), "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { owner, name, number } }),
    }),
    "reading the pull request",
  );

  const payload = (await response.json()) as {
    errors?: { message: string }[];
    data?: { repository?: { pullRequest?: Record<string, unknown> } };
  };
  if (payload.errors?.length) {
    throw new Error(`reading the pull request failed: ${payload.errors[0]!.message}`);
  }
  const pr = payload.data?.repository?.pullRequest;
  if (!pr) throw new Error(`pull request ${repo}#${number} was not found`);

  const closing = pr["closingIssuesReferences"] as { nodes?: LinkedIssue[] } | undefined;
  return {
    number,
    title: String(pr["title"] ?? ""),
    body: String(pr["body"] ?? ""),
    headSha: String(pr["headRefOid"] ?? ""),
    baseSha: String(pr["baseRefOid"] ?? ""),
    isFork: pr["isCrossRepository"] === true,
    closes: (closing?.nodes ?? []).map((issue) => ({
      number: issue.number,
      title: issue.title ?? "",
      body: issue.body ?? "",
    })),
  };
}

/** The unified diff of the whole pull request, as GitHub renders it. */
export async function fetchDiff(
  repo: string,
  number: number,
  token: string,
): Promise<string> {
  const response = await ok(
    await fetch(`${API}/repos/${repo}/pulls/${number}`, {
      headers: headers(token, "application/vnd.github.diff"),
    }),
    "reading the diff",
  );
  return await response.text();
}

/**
 * One file as it stands at a given commit.
 *
 * The Standards pass reads its rules at the *base* commit, not out of the checkout: on a
 * `pull_request` event the checkout is the merge commit, so a change that deleted a
 * guardrail and then broke it would be judged against its own edited copy of the rules
 * and come back clean.
 */
async function fetchFile(
  repo: string,
  path: string,
  ref: string,
  token: string,
): Promise<string> {
  const response = await ok(
    await fetch(`${API}/repos/${repo}/contents/${path}?ref=${ref}`, {
      headers: headers(token, "application/vnd.github.raw"),
    }),
    `reading ${path}`,
  );
  return await response.text();
}

type Entry = { name: string; type: string };

/** CLAUDE.md, the glossary and every ADR, as they stood before this change. */
export async function fetchStandardsDocs(
  repo: string,
  ref: string,
  token: string,
): Promise<string> {
  const listing = await ok(
    await fetch(`${API}/repos/${repo}/contents/docs/adr?ref=${ref}`, {
      headers: headers(token, "application/vnd.github+json"),
    }),
    "listing docs/adr",
  );
  const adrs = ((await listing.json()) as Entry[])
    .filter((e) => e.type === "file" && e.name.endsWith(".md"))
    .map((e) => `docs/adr/${e.name}`)
    .sort();

  const paths = ["CLAUDE.md", "CONTEXT.md", ...adrs];
  const texts = await Promise.all(paths.map((p) => fetchFile(repo, p, ref, token)));
  return paths.map((path, i) => `## ${path}\n\n${texts[i]}`).join("\n\n---\n\n");
}

type Comment = { id: number; body: string };

/** The review's own comment, found by its marker so `pr-report.yml`'s is left alone. */
export async function findComment(
  repo: string,
  number: number,
  token: string,
  marker: string,
): Promise<Comment | undefined> {
  for (let page = 1; page <= 10; page++) {
    const response = await ok(
      await fetch(
        `${API}/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
        { headers: headers(token, "application/vnd.github+json") },
      ),
      "listing the comments",
    );
    const comments = (await response.json()) as Comment[];
    const mine = comments.find((c) => c.body.startsWith(marker));
    if (mine) return { id: mine.id, body: mine.body };
    if (comments.length < 100) return undefined;
  }
  return undefined;
}

export async function updateComment(
  repo: string,
  id: number,
  token: string,
  body: string,
): Promise<void> {
  await ok(
    await fetch(`${API}/repos/${repo}/issues/comments/${id}`, {
      method: "PATCH",
      headers: { ...headers(token, "application/vnd.github+json"), "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }),
    "editing the comment",
  );
}

/** One comment per pull request, edited in place, so reruns never accumulate. */
export async function upsertComment(
  repo: string,
  number: number,
  token: string,
  marker: string,
  body: string,
): Promise<void> {
  const existing = await findComment(repo, number, token, marker);
  if (existing) {
    await updateComment(repo, existing.id, token, body);
    return;
  }
  await ok(
    await fetch(`${API}/repos/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers: { ...headers(token, "application/vnd.github+json"), "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }),
    "posting the comment",
  );
}
