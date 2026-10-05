import { PAGE, readAllPages, type Page } from "../pr-review/github.ts";

/**
 * The closing-references check's one read of a pull request: its body, where GitHub would read
 * closing keywords from it, and every issue of this repository in its closing references.
 *
 * Out of `main.ts` so it can be tested against a fake endpoint: `main.ts` runs the check when it
 * is loaded. The calls the port makes besides this one stay there.
 */
export const API = "https://api.github.com";

export const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "biu-cs-planner-closing-refs",
});

export async function ok(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`${what} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

/**
 * Paged the way the review's read pages (`readAllPages`, `tools/pr-review/github.ts`). It used to
 * ask for `first: 100` once and stop, which dropped the 101st reference without a word (#320).
 *
 * The body and the two branch names come in the first page's read, so the body is compared
 * against the list GitHub held at the same moment rather than one fetched a request later; the
 * pages after it ask for the same fields and only their closing references are read.
 */
const QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      body
      baseRefName
      closingIssuesReferences(first: ${PAGE}, after: $after) {
        nodes { number repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

type Reference = { number: number; repository?: { nameWithOwner?: string } };

type PullRequest = {
  body?: string | null;
  baseRefName?: string;
  closingIssuesReferences?: Page<Reference>;
};

export type Read = {
  /** The issues of this repository the pull request closes. */
  references: number[];
  /** The body, or `""` where GitHub would read no closing keyword in it (see `Port.body`). */
  body: string;
  /**
   * Set only when GitHub held more closing references than the read's page cap: how many were
   * read. Absent means `references` is all of them.
   */
  cutAt?: number;
};

export async function readClosingReferences(
  repo: string,
  number: number,
  token: string,
): Promise<Read> {
  const [owner, name] = repo.split("/");

  const readPage = async (after: string | null) => {
    const response = await ok(
      await fetch(`${API}/graphql`, {
        method: "POST",
        headers: { ...headers(token), "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { owner, name, number, after } }),
      }),
      "reading the closing references",
    );
    const payload = (await response.json()) as {
      errors?: { message: string }[];
      data?: {
        repository?: {
          defaultBranchRef?: { name?: string } | null;
          pullRequest?: PullRequest | null;
        };
      };
    };
    if (payload.errors?.length) {
      throw new Error(`reading the closing references failed: ${payload.errors[0]!.message}`);
    }
    const repository = payload.data?.repository;
    const pr = repository?.pullRequest;
    if (!pr) throw new Error(`pull request ${repo}#${number} was not found`);
    return { repository, pr };
  };

  const { repository, pr } = await readPage(null);
  const { nodes, cutAt } = await readAllPages(
    pr.closingIssuesReferences,
    async (after) => (await readPage(after)).pr.closingIssuesReferences,
  );

  // Into any branch but the default one GitHub links no closing keyword, so a body full of
  // them is not a list that failed to register (see `Port.body`).
  const intoDefault =
    pr.baseRefName !== undefined && pr.baseRefName === repository?.defaultBranchRef?.name;
  return {
    // An issue in another repository can be closed too, but its number means nothing
    // here: looking it up would read this repository's issue of the same number.
    references: nodes
      .filter((node) => node.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase())
      .map((node) => node.number),
    body: intoDefault ? (pr.body ?? "") : "",
    ...(cutAt !== undefined ? { cutAt } : {}),
  };
}
