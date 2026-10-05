import { afterEach, expect, it, vi } from "vitest";
import { MAX_PAGES } from "../pr-review/github.ts";
import { readClosingReferences } from "./read.ts";

/**
 * A GraphQL endpoint holding `count` closing references, served the way GitHub serves them:
 * `first` of them after the cursor, with `pageInfo` saying whether there are more. `first` is
 * read out of the query the code sent, so a read that went back to one page of 100 and no
 * cursor (#320) is served exactly that, and the assertions below see what it dropped.
 */
function closingReferences(count: number | "endless") {
  const asked: (string | null)[] = [];
  const fake = vi.fn(async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as {
      query: string;
      variables: { after?: string | null };
    };
    const first = Number(/closingIssuesReferences\(first: (\d+)/.exec(query)?.[1]);
    const after = variables.after ?? null;
    asked.push(after);
    const start = after === null ? 0 : Number(after);
    const end = count === "endless" ? start + first : Math.min(count, start + first);
    const nodes = Array.from({ length: end - start }, (_, i) => ({
      number: start + i + 1,
      repository: { nameWithOwner: "o/r" },
    }));
    return new Response(
      JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "dev" },
            pullRequest: {
              body: "Closes #1",
              baseRefName: "dev",
              closingIssuesReferences: {
                nodes,
                pageInfo: { hasNextPage: count === "endless" || end < count, endCursor: String(end) },
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

it("keeps the references past the first page, which a single `first: 100` dropped", async () => {
  const { asked } = closingReferences(250);

  const read = await readClosingReferences("o/r", 1, "token");

  expect(read.references).toHaveLength(250);
  expect(read.references.at(-1)).toBe(250);
  expect(asked).toEqual([null, "100", "200"]);
  expect(read.cutAt).toBeUndefined();
  expect(read.body).toBe("Closes #1");
});

it("says how far it read when it stops at the cap, instead of stopping silently", async () => {
  const { fake } = closingReferences("endless");

  const read = await readClosingReferences("o/r", 1, "token");

  expect(fake).toHaveBeenCalledTimes(MAX_PAGES);
  expect(read.cutAt).toBe(read.references.length);
  expect(read.references.length).toBeGreaterThan(100);
});
