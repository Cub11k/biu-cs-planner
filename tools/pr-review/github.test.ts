import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PAGES,
  POSTER,
  fetchPullRequest,
  findComment,
  upsertComment,
} from "./github.ts";

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

/** An issue-comments endpoint holding `comments`, which records every write sent to it. */
function issueComments(comments: { id: number; body: string; user: { login: string } | null }[]) {
  const writes: { method: string; url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        writes.push({ method, url });
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify(comments), { status: 200 });
    }),
  );
  return writes;
}

const MARK = "<!-- closing-references -->";

describe("findComment", () => {
  it("passes over a comment that carries the marker but was written by someone else", async () => {
    // #307: a person quoting the bot's comment wrote the first match. Taking it meant an edit
    // GitHub refused, and the bot's own comment never being touched again.
    issueComments([
      { id: 1, body: `${MARK}\n> quoted from the bot`, user: { login: "Cub11k" } },
      { id: 2, body: `${MARK}\nthe bot's own`, user: { login: POSTER } },
    ]);

    expect((await findComment("o/r", 7, "token", MARK))?.id).toBe(2);
  });

  it("finds nothing when only someone else's comment carries the marker", async () => {
    issueComments([{ id: 1, body: MARK, user: { login: "Cub11k" } }]);

    expect(await findComment("o/r", 7, "token", MARK)).toBeUndefined();
  });

  it("finds nothing in a comment whose author GitHub no longer knows", async () => {
    // A deleted account's comments come back with `user: null`.
    issueComments([{ id: 1, body: MARK, user: null }]);

    expect(await findComment("o/r", 7, "token", MARK)).toBeUndefined();
  });

  it("still tells the bot's comments apart by marker", async () => {
    issueComments([
      { id: 1, body: "<!-- pr-report -->", user: { login: POSTER } },
      { id: 2, body: MARK, user: { login: POSTER } },
    ]);

    expect((await findComment("o/r", 7, "token", MARK))?.id).toBe(2);
  });
});

describe("upsertComment", () => {
  it("posts its own comment rather than editing a person's that quotes its marker", async () => {
    const writes = issueComments([{ id: 1, body: MARK, user: { login: "Cub11k" } }]);

    await upsertComment("o/r", 7, "token", MARK, `${MARK}\nbody`);

    expect(writes).toEqual([
      { method: "POST", url: "https://api.github.com/repos/o/r/issues/7/comments" },
    ]);
  });

  it("edits its own comment in place", async () => {
    const writes = issueComments([{ id: 9, body: MARK, user: { login: POSTER } }]);

    await upsertComment("o/r", 7, "token", MARK, `${MARK}\nbody`);

    expect(writes).toEqual([
      { method: "PATCH", url: "https://api.github.com/repos/o/r/issues/comments/9" },
    ]);
  });
});
