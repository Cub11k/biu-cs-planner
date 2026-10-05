import { describe, expect, it } from "vitest";
import {
  MARKER,
  decide,
  issueList,
  openFence,
  proseOnly,
  renderFindings,
  renderResolved,
  run,
  unclosedChildren,
  unregistered,
  writtenClosings,
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

const REPO = "Cub11k/biu-cs-planner";

describe("writtenClosings", () => {
  it("reads a deliberate `Closes` line", () => {
    expect(writtenClosings("Some prose.\n\nCloses #308\nCloses #313\n", REPO)).toEqual([308, 313]);
  });

  it("reads every keyword GitHub documents, in any case, with or without a colon", () => {
    const body = [
      "close #1",
      "closes #2",
      "Closed #3",
      "fix #4",
      "FIXES #5",
      "fixed #6",
      "resolve #7",
      "resolves #8",
      "Resolved: #9",
    ].join("\n");
    expect(writtenClosings(body, REPO)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("reads a keyword mid-sentence, as GitHub does — #223's `the closed #125`", () => {
    expect(writtenClosings("a dated amendment on the closed #125, which is why", REPO)).toEqual([
      125,
    ]);
  });

  it("does not read a keyword that is only the end of another word", () => {
    expect(writtenClosings("enclosed #5, disclosed #6, prefixed #7", REPO)).toEqual([]);
  });

  it("does not read a number with no keyword before it", () => {
    expect(writtenClosings("See #236 and PR #276.", REPO)).toEqual([]);
  });

  it("reads this repository's `owner/name#n` and not another's", () => {
    const body = "Closes cub11k/BIU-CS-PLANNER#10\nCloses someone/else#11";
    expect(writtenClosings(body, REPO)).toEqual([10]);
  });

  it("names a number once, however often it is closed", () => {
    expect(writtenClosings("Closes #4\nFixes #4", REPO)).toEqual([4]);
  });

  it("ignores references inside fenced code blocks, of either fence", () => {
    const body = [
      "Closes #1",
      "```",
      "Closes #2",
      "```",
      "~~~md",
      "Fixes #3",
      "~~~",
      "Closes #4",
    ].join("\n");
    expect(writtenClosings(body, REPO)).toEqual([1, 4]);
  });

  it("ignores references inside inline code", () => {
    const body = "Not `Closes #179, #124`, and not ``fixes #5``. Closes #6";
    expect(writtenClosings(body, REPO)).toEqual([6]);
  });
});

describe("proseOnly", () => {
  it("runs an unclosed fence to the end of the body", () => {
    expect(proseOnly("Closes #1\n```\nCloses #2")).toBe("Closes #1\n\n");
  });

  it("closes a fence only with a run of the same character at least as long", () => {
    const body = ["````", "```", "Closes #2", "~~~~", "````", "Closes #3"].join("\n");
    expect(proseOnly(body)).toBe("\n\n\n\n\nCloses #3");
  });

  it("closes a code span only with a run of exactly the same length", () => {
    expect(proseOnly("``a ` b`` c")).toBe("  c");
  });

  it("does not let a fence line with an info string close a fence", () => {
    expect(writtenClosings("```\n```js\nCloses #11\n```\n", "o/r")).toEqual([]);
  });

  it("does not let a stray backtick hide a `Closes` line in a later paragraph", () => {
    // A code span never leaves its paragraph, and a blanked fence ends one too.
    expect(writtenClosings("don't type ` here\n\nCloses #6\n\nlater `x`", "o/r")).toEqual([6]);
    expect(writtenClosings("a ` b\n```\ncode\n```\nCloses #7 then `y`", "o/r")).toEqual([7]);
  });

  it("blanks an HTML comment, closed or running to the end", () => {
    expect(writtenClosings("<!-- Closes #12 -->\nCloses #3\n<!-- Fixes #4", "o/r")).toEqual([3]);
  });

  it("does not read a comment marker quoted in inline code as a comment", () => {
    // #223's body quotes `<!-- pr-review -->` long before its `Closes` block.
    expect(writtenClosings("The marker `<!-- pr-review -->` is code.\n\nCloses #205", "o/r")).toEqual(
      [205],
    );
  });

  it("leaves a lone backtick as written", () => {
    expect(proseOnly("it's a ` stray")).toBe("it's a ` stray");
  });
});

/** #223's body in miniature: a fence quoting a fence, and the `Closes` block after it. */
const NESTED = [
  "Prose that closed #125 in passing.",
  "",
  "```",
  "**core/shoham/details**",
  "",
  "```ts",
  "type DetailKey = {}",
  "```",
  "",
  "- `RawDetail`",
  "```",
  "",
  "More prose.",
  "",
  "Closes #205",
  "Closes #202",
].join("\n");

describe("openFence", () => {
  it("finds the fence a quoted fence left open, and the closing lines it swallowed", () => {
    expect(openFence(NESTED, "o/r")).toEqual({ line: 11, hidden: [205, 202] });
    // And the ordinary reading skips them, as GitHub does.
    expect(writtenClosings(NESTED, "o/r")).toEqual([125]);
  });

  it("is nothing when every fence closes", () => {
    expect(openFence("```\nCloses #1\n```\nCloses #2", "o/r")).toBeUndefined();
  });

  it("is nothing when the open fence swallowed no closing line", () => {
    expect(openFence("Closes #1\n```\ncode", "o/r")).toBeUndefined();
  });
});

describe("unregistered", () => {
  it("keeps what the body closes and the list lacks, in the body's order", () => {
    expect(unregistered([205, 202, 203], [125, 202])).toEqual([205, 203]);
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

describe("renderFindings for closing lines GitHub did not record", () => {
  it("names the issues the body closes and the list lacks, and what the list holds", () => {
    const body = renderFindings([125], [], [205, 202]);

    expect(body).toContain(
      "The body puts a closing keyword before #205 and #202, and GitHub's list holds #125, so " +
        "merging will not close them.",
    );
    expect(body).toContain("close them by hand after the merge");
    expect(body).not.toContain("open child");
  });

  it("says so when the list holds nothing at all", () => {
    expect(renderFindings([], [], [308])).toContain(
      "The body puts a closing keyword before #308, and GitHub's list holds no issue at all, so " +
        "merging will not close it.",
    );
  });

  it("carries both findings in one comment", () => {
    const body = renderFindings([205], [{ parent: 205, missing: [203] }], [203]);

    expect(body).toContain("#203 is an open child of #205");
    expect(body).toContain("The body puts a closing keyword before #203");
    expect(body.split(MARKER)).toHaveLength(2);
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
  body = "",
): Port & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    repository: "Cub11k/biu-cs-planner",
    closingReferences: async () => references,
    body: async () => body,
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

  it("posts a comment naming a `Closes` line GitHub did not register", async () => {
    // #223: deliberate lines, and a list that held none of them. Nothing listed is no parent,
    // so before #308 this was silent.
    const port = fakePort([], {}, undefined, "Body.\n\nCloses #205\nCloses #202\n");

    const decision = await run(port, () => {});

    expect(decision?.kind).toBe("post");
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]).toContain("The body puts a closing keyword before #205 and #202");
  });

  it("names the unclosed fence that swallowed #223's `Closes` block", async () => {
    const port = fakePort([125], {}, undefined, NESTED);

    await run(port, () => {});

    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]).toContain(
      "The code fence opened on line 11 of the body is never closed, so GitHub reads everything " +
        "after it as code, including the closing keywords before #205 and #202",
    );
    // Not named twice: outside code the body closes only #125, which the list holds.
    expect(port.writes[0]).not.toContain("The body puts a closing keyword");
  });

  it("says nothing of a swallowed line GitHub registered anyway", async () => {
    const port = fakePort([125, 205, 202], {}, undefined, NESTED);

    expect(await run(port, () => {})).toEqual({ kind: "silent" });
  });

  it("is silent when the body and the list agree", async () => {
    const port = fakePort([205, 202], {}, undefined, "Closes #205\nCloses #202\n");

    expect(await run(port, () => {})).toEqual({ kind: "silent" });
    expect(port.writes).toEqual([]);
  });

  it("is silent about a `Closes` line inside a code fence", async () => {
    const port = fakePort([], {}, undefined, "Not like this:\n\n```\nCloses #179, #124\n```\n");

    expect(await run(port, () => {})).toEqual({ kind: "silent" });
  });

  it("resolves its comment once the list holds what the body closes", async () => {
    const earlier = renderFindings([], [], [205]);
    const port = fakePort([205], {}, { id: 4, body: earlier }, "Closes #205");

    await run(port, () => {});

    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]).toMatch(/^edit:4:/);
    expect(port.writes[0]).toContain("Resolved.");
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
