import { describe, expect, it } from "vitest";
import { FOLLOWER_HOME, type Source } from "./followers.ts";
import { graphsOf } from "./graphs.ts";
import { renderGraphs } from "./render.ts";

/** A re-export walk written as a loop, under a name that is not the real one's. */
const WALK = [
  "export const trace = (ref, named, origins) => {",
  "  let at = { specifier: ref, name: named };",
  "  while (true) {",
  "    const origin = origins.modules.get(at.specifier)?.get(at.name);",
  "    if (!origin) return at;",
  "    at = { specifier: origin.specifier, name: origin.name };",
  "  }",
  "};",
].join("\n");

const nothingDerived = { modules: [], edges: [], tests: [] };

describe("graphsOf", () => {
  it("carries a stray re-export walk from the tree into the graph comment", () => {
    // The wiring #237 asked for, end to end: what `main.ts` hands `renderGraphs` comes from
    // here, so a `graphsOf` that stopped calling `strayFollowers` fails this.
    const sources: Source[] = [
      { path: FOLLOWER_HOME, text: WALK },
      { path: "tools/pr-review/second.ts", text: WALK },
    ];
    const graphs = graphsOf(nothingDerived, sources);

    expect(graphs.followers).toEqual([{ path: "tools/pr-review/second.ts", name: "trace" }]);
    expect(
      renderGraphs({ headSha: "abcdef1234567890", graphs, judgement: { kind: "not-requested" } }),
    ).toContain("`tools/pr-review/second.ts` follows a re-export chain in `trace`.");
  });

  it("finds nothing to report in a tree whose only walk is at home", () => {
    const graphs = graphsOf(nothingDerived, [{ path: FOLLOWER_HOME, text: WALK }]);

    expect(graphs.followers).toEqual([]);
    expect(graphs.moduleCycles).toEqual([]);
    expect(graphs.callCycles).toEqual([]);
    expect(graphs.forbidden).toEqual([]);
  });
});
