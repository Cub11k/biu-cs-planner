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
  /**
   * Set only when GitHub had more closing references than `MAX_PAGES` pages and `closes` stops
   * short: how many it holds. Absent means `closes` is all of them.
   */
  closesCutAt?: number;
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

/**
 * Every closing reference, a page at a time.
 *
 * It used to ask for `first: 5` and stop, and a composed parent with three children plus one
 * more issue is already five (`docs/agents/issue-tracker.md`, "How big a ticket is"); a sixth
 * was dropped without a word, and the Spec pass judged the pull request against part of what it
 * closes (#306). So it pages until GitHub says there is no next page.
 *
 * `MAX_PAGES` is the one cap left, held against a cursor that never ends rather than against any
 * real pull request — 100 per page is GitHub's ceiling, so the cap is a thousand references. It
 * is not silent: reaching it sets `closesCutAt`, which the Spec pass is told (`closingSection`
 * in `./review.ts`) and the review comment prints (`renderReview`). It does not throw, because
 * this read happens before the graph check posts its comment, and a throw here would take that
 * comment down with it over a field only the Spec pass reads.
 */
export const PAGE = 100;
export const MAX_PAGES = 10;

/** One page of a GraphQL connection, as GitHub serves it. */
export type Page<T> = {
  nodes?: T[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
};

/**
 * Every node of a connection, from the page already in hand and `next` for each page after it,
 * until GitHub says there is no next page or `MAX_PAGES` pages have been read. `cutAt` is set
 * only when the cap stopped it, to the number of nodes read, so a caller can say so rather than
 * pass a part off as the whole. Shared by the review's read here and by the closing-references
 * check's (`tools/closing-refs/read.ts`), so the two cannot page differently (#320).
 */
export async function readAllPages<T>(
  first: Page<T> | undefined,
  next: (after: string) => Promise<Page<T> | undefined>,
): Promise<{ nodes: T[]; cutAt?: number }> {
  const nodes: T[] = [];
  let page = first;
  for (let read = 1; ; read++) {
    nodes.push(...(page?.nodes ?? []));
    const after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : undefined;
    if (!after) return { nodes };
    if (read === MAX_PAGES) return { nodes, cutAt: nodes.length };
    page = await next(after);
  }
}

const QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      body
      headRefOid
      baseRefOid
      isCrossRepository
      closingIssuesReferences(first: ${PAGE}, after: $after) {
        nodes { number title body }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

async function readPage(
  repo: string,
  number: number,
  token: string,
  after: string | null,
): Promise<Record<string, unknown>> {
  const [owner, name] = repo.split("/");
  const response = await ok(
    await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { ...headers(token, "application/json"), "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { owner, name, number, after } }),
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
  return pr;
}

export async function fetchPullRequest(
  repo: string,
  number: number,
  token: string,
): Promise<PullRequest> {
  const pr = await readPage(repo, number, token, null);
  const closingPage = (from: Record<string, unknown>) =>
    from["closingIssuesReferences"] as Page<LinkedIssue> | undefined;
  const { nodes: closes, cutAt } = await readAllPages(closingPage(pr), async (after) =>
    closingPage(await readPage(repo, number, token, after)),
  );

  return {
    number,
    title: String(pr["title"] ?? ""),
    body: String(pr["body"] ?? ""),
    headSha: String(pr["headRefOid"] ?? ""),
    baseSha: String(pr["baseRefOid"] ?? ""),
    isFork: pr["isCrossRepository"] === true,
    closes: closes.map((issue) => ({
      number: issue.number,
      title: issue.title ?? "",
      body: issue.body ?? "",
    })),
    ...(cutAt !== undefined ? { closesCutAt: cutAt } : {}),
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

  const paths = ["CLAUDE.md", "GLOSSARY.md", ...adrs];
  const texts = await Promise.all(paths.map((p) => fetchFile(repo, p, ref, token)));
  return paths.map((path, i) => `## ${path}\n\n${texts[i]}`).join("\n\n---\n\n");
}

type Comment = { id: number; body: string };

/**
 * Who the workflows post as: every workflow here writes its comment with the job's own
 * `GITHUB_TOKEN`, and GitHub attributes that to this login.
 */
export const POSTER = "github-actions[bot]";

/**
 * A sticky comment, found by its marker **and its author**, so `pr-report.yml`'s is left alone
 * and so is anybody else's.
 *
 * The author is half of the match because a marker is only text. A person who quotes a bot's
 * comment, or pastes its marker, writes a comment that starts with it; matched on the marker
 * alone that comment was the one found, the edit was refused with a 403 that became a warning,
 * and the bot's own comment was never posted or updated again (#307). Every caller — the graph
 * check and the review in `./main.ts`, the outdate step in `./outdate.ts`, and
 * `tools/closing-refs/main.ts` — gets this through here.
 *
 * The match is on who wrote the comment, not on whose token reads it, so a dry run from a laptop
 * with a personal token (`DRY_RUN=1` in `tools/closing-refs/main.ts`) still finds the bot's.
 */
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
    const comments = (await response.json()) as (Comment & {
      user?: { login?: string } | null;
    })[];
    const mine = comments.find((c) => c.user?.login === POSTER && c.body.startsWith(marker));
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
