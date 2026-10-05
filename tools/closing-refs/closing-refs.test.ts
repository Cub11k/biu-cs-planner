import { describe, expect, it } from "vitest";
import {
  MARKER,
  decide,
  issueList,
  renderFindings,
  renderResolved,
  run,
  unclosedChildren,
  type Child,
  type Existing,
  type Port,
} from "./closing-refs.ts";

const open = (number: number): Child => ({ number, open: true });
const closed = (number: number): Child => ({ number, open: false });

describe("unclosedChildren", () => {
  it("names the open children of a listed parent that the list does not hold", () => {
    const found = unclosedChildren([
      { number: 205, children: [open(202), open(203), open(204)] },
      { number: 202, children: [] },
    ]);

    expect(found).toEqual([{ parent: 205, missing: [203, 204] }]);
  });

  it("finds nothing when the parent and every child are listed", () => {
    const found = unclosedChildren([
      { number: 201, children: [open(198), open(199)] },
      { number: 198, children: [] },
      { number: 199, children: [] },
    ]);

    expect(found).toEqual([]);
  });

  it("does not count a child that is already closed", () => {
    expect(unclosedChildren([{ number: 178, children: [closed(163), closed(176)] }])).toEqual(
      [],
    );
  });

  it("finds nothing in a list that holds no parent", () => {
    expect(unclosedChildren([{ number: 260, children: [] }])).toEqual([]);
    expect(unclosedChildren([])).toEqual([]);
  });

  it("reports each parent apart, in the order GitHub listed them", () => {
    const found = unclosedChildren([
      { number: 10, children: [open(11)] },
      { number: 20, children: [open(21), open(22)] },
    ]);

    expect(found).toEqual([
      { parent: 10, missing: [11] },
      { parent: 20, missing: [21, 22] },
    ]);
  });
});

describe("issueList", () => {
  it("reads like a sentence at every length", () => {
    expect(issueList([])).toBe("");
    expect(issueList([1])).toBe("#1");
    expect(issueList([1, 2])).toBe("#1 and #2");
    expect(issueList([1, 2, 3])).toBe("#1, #2 and #3");
  });
});

describe("renderFindings", () => {
  it("says, in its first sentence, what is listed and what is missing from where", () => {
    const body = renderFindings([205, 202], [{ parent: 205, missing: [203, 204] }]);

    expect(body).toContain(
      "This pull request closes #205 and #202; #203 and #204 are open children of #205 and " +
        "are not in the list.",
    );
  });

  it("agrees in number with a single missing child", () => {
    const body = renderFindings([10], [{ parent: 10, missing: [11] }]);

    expect(body).toContain("#11 is an open child of #10 and is not in the list.");
  });

  it("names the exact lines that would close the rest", () => {
    const body = renderFindings([205], [{ parent: 205, missing: [203, 204] }]);

    expect(body).toContain("`Closes #203`, `Closes #204`");
  });

  it("starts with the marker, so the next run edits it instead of posting again", () => {
    expect(renderFindings([1], [{ parent: 1, missing: [2] }]).startsWith(MARKER)).toBe(true);
  });
});

describe("renderResolved", () => {
  const fixed = [
    { number: 205, children: [open(203)] },
    { number: 203, children: [] },
  ];

  it("keeps the marker and says what changed", () => {
    expect(renderResolved(fixed).startsWith(MARKER)).toBe(true);
    expect(renderResolved(fixed)).toContain(
      "closes #205 and #203, and every open child of a parent among them is in that list",
    );
  });

  it("says so when the parent left the list instead of its children joining it", () => {
    expect(renderResolved([{ number: 260, children: [] }])).toContain(
      "closes #260, and it is not a parent",
    );
    expect(
      renderResolved([
        { number: 1, children: [] },
        { number: 2, children: [] },
      ]),
    ).toContain("closes #1 and #2, and none of them is a parent");
    expect(renderResolved([])).toContain("no longer closes any issue");
  });
});

describe("decide", () => {
  const missingOne = [{ number: 205, children: [open(203), open(204)] }, { number: 204, children: [] }];

  it("says nothing at all on a pull request that closes no parent", () => {
    expect(decide([{ number: 260, children: [] }], undefined)).toEqual({ kind: "silent" });
    expect(decide([], undefined)).toEqual({ kind: "silent" });
  });

  it("says nothing on a pull request that closes a parent and all its open children", () => {
    const all = [
      { number: 205, children: [open(203), closed(204)] },
      { number: 203, children: [] },
    ];

    expect(decide(all, undefined)).toEqual({ kind: "silent" });
  });

  it("posts when a child is missing and no comment is there yet", () => {
    const decision = decide(missingOne, undefined);

    expect(decision.kind).toBe("post");
    expect(decision.kind === "post" && decision.body).toContain(
      "#203 is an open child of #205",
    );
  });

  it("edits its own comment rather than posting a second one", () => {
    const existing: Existing = { id: 7, body: `${MARKER}\n\nan older finding` };

    expect(decide(missingOne, existing)).toMatchObject({ kind: "edit", id: 7 });
  });

  it("leaves its comment alone when it already says the right thing", () => {
    const body = renderFindings([205, 204], [{ parent: 205, missing: [203] }]);

    expect(decide(missingOne, { id: 7, body })).toEqual({ kind: "silent" });
  });

  it("turns an earlier finding into a resolved line once the body is fixed", () => {
    const fixed = [
      { number: 205, children: [open(203), open(204)] },
      { number: 203, children: [] },
      { number: 204, children: [] },
    ];
    const decision = decide(fixed, { id: 7, body: renderFindings([205], [{ parent: 205, missing: [203] }]) });

    expect(decision).toMatchObject({ kind: "edit", id: 7 });
    expect(decision.kind === "edit" && decision.body).toContain("Resolved.");
  });
});

/** A port over fixed data, recording what was written. */
function fakePort(
  references: number[],
  children: Record<number, Child[]>,
  existing?: Existing,
): Port & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    closingReferences: async () => references,
    subIssues: async (issue) => children[issue] ?? [],
    findComment: async () => existing,
    postComment: async (body) => {
      writes.push(`post:${body}`);
    },
    editComment: async (id, body) => {
      writes.push(`edit:${id}:${body}`);
    },
  };
}

describe("run", () => {
  it("posts the finding on a pull request that leaves a child open", async () => {
    const port = fakePort([205, 202], { 205: [open(202), open(203)] });

    await run(port, () => {});

    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]).toMatch(/^post:/);
    expect(port.writes[0]).toContain("#203 is an open child of #205");
  });

  it("writes nothing on a pull request that closes no parent", async () => {
    const port = fakePort([260], {});

    expect(await run(port, () => {})).toEqual({ kind: "silent" });
    expect(port.writes).toEqual([]);
  });

  it("edits its existing comment", async () => {
    const port = fakePort([205], { 205: [open(203)] }, { id: 9, body: `${MARKER}\nold` });

    await run(port, () => {});

    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]).toMatch(/^edit:9:/);
  });

  it("never throws: a failing GitHub call becomes a warning in the log", async () => {
    const port = fakePort([205], { 205: [open(203)] });
    port.postComment = async () => {
      throw new Error("Resource not accessible by integration");
    };
    const lines: string[] = [];

    await expect(run(port, (line) => lines.push(line))).resolves.toBeUndefined();
    expect(lines).toEqual([
      expect.stringMatching(/^::warning::.*Resource not accessible by integration/),
    ]);
  });
});
