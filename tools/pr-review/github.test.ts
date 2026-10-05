import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PAGES, fetchPullRequest } from "./github.ts";

/**
 * A GraphQL endpoint holding `count` closing references, which serves them the way GitHub does:
 * `first` of them after the cursor, with `pageInfo` saying whether there are more.
 *
 * It reads `first` out of the query the code sent rather than assuming a page size, so a query
 * that went back to asking for five (#306) gets five, and the assertions below see the loss.
 */
function closingReferences(count: number | "endless") {
  const asked: { first: number; after: string | null }[] = [];
  const fake = vi.fn(async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as {
      query: string;
      variables: { after: string | null };
    };
    const first = Number(/closingIssuesReferences\(first: (\d+)/.exec(query)?.[1]);
    const after = variables.after;
    asked.push({ first, after });
    const start = after === null ? 0 : Number(after);
    const end = count === "endless" ? start + first : Math.min(count, start + first);
    const nodes = Array.from({ length: end - start }, (_, i) => ({
      number: start + i + 1,
      title: `issue ${start + i + 1}`,
      body: "",
    }));
    return new Response(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: 1,
              title: "t",
              body: "b",
              headRefOid: "head",
              baseRefOid: "base",
              isCrossRepository: false,
              closingIssuesReferences: {
                nodes,
                pageInfo: {
                  hasNextPage: count === "endless" || end < count,
                  endCursor: String(end),
                },
              },
            },
          },
        },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fake);
  return { fake, asked };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPullRequest's closing references", () => {
  it("keeps a sixth reference, which `first: 5` used to drop", async () => {
    // A composed parent, its three children and two more issues: the normal case since
    // `issue-tracker.md` composed tickets, and one past where the old query stopped.
    closingReferences(6);
    const pr = await fetchPullRequest("o/r", 1, "token");

    expect(pr.closes.map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pr.closesCutAt).toBeUndefined();
  });

  it("pages until GitHub says there is no next page", async () => {
    const { asked } = closingReferences(250);
    const pr = await fetchPullRequest("o/r", 1, "token");

    expect(pr.closes).toHaveLength(250);
    expect(pr.closes.at(-1)?.number).toBe(250);
    expect(asked.map((a) => a.after)).toEqual([null, "100", "200"]);
    expect(pr.closesCutAt).toBeUndefined();
  });

  it("says how far it read when it stops at the cap, instead of stopping silently", async () => {
    const { fake } = closingReferences("endless");
    const pr = await fetchPullRequest("o/r", 1, "token");

    expect(fake).toHaveBeenCalledTimes(MAX_PAGES);
    expect(pr.closesCutAt).toBe(pr.closes.length);
    expect(pr.closes.length).toBeGreaterThan(5);
  });
});
