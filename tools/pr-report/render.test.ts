import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "./collect.ts";
import { render, type Report } from "./render.ts";
import type { TestRun } from "./coverage.ts";
import type { TestCase } from "./tests.ts";
import { packageWorkspace, type ImportKind, type Module } from "./surface.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * The report is posted as one pull request comment, and most of it is reference material
 * nobody reads in passing: every test title, every edge of two graphs. What is asserted
 * here is that it arrives folded, that each fold says its size on the outside, and that
 * the two parts written to be read arrive open.
 */

const coverageOf = (branches: number) => ({
  statements: 90,
  branches,
  functions: 90,
  lines: 90,
  uncoveredLines: 3,
});

/**
 * One ordinary entry: one title, one test.
 *
 * Named rather than written out, because the field that makes it one test is the whole subject
 * of #140 and a fixture that sets it inline reads as noise. A parameterised entry is written
 * out in full at the tests that are about one.
 */
const entry = (title: string, suite: string[] = []): TestCase => ({
  title,
  suite,
  tests: 1,
  atLeast: false,
});

/** `ImportKind`'s three states, named as `surface.ts` and `surface.test.ts` name them. */
const ERASED: ImportKind = { typeOnly: true, erasable: true };
const KEPT: ImportKind = { typeOnly: true, erasable: false };
const CODE: ImportKind = { typeOnly: false, erasable: false };

/** A node with no edges of its own, to be the far end of one. */
const leaf = (path: string): Module => ({
  path,
  workspace: "core",
  exports: [],
  imports: [],
  packages: [],
});

/** The same, somewhere other than `core`, so an edge can cross a workspace. */
const leafIn = (workspace: string, path: string): Module => ({ ...leaf(path), workspace });

/** A module whose only imports are bare specifiers, the way a cross-workspace one is written. */
const importing = (workspace: string, path: string, ...packages: Module["packages"]): Module => ({
  ...leafIn(workspace, path),
  packages,
});

/**
 * This repo's architecture in miniature: one module per workspace, each reaching the next
 * by package name, and `web`'s single edge written `import type` so it is erased. Every one
 * of these is in `Module.packages` and none in `Module.imports`, which is the whole reason
 * the graph used to draw four boxes and no arrow between any two of them.
 */
const chain: Module[] = [
  importing("web", "web/src/api.ts", { specifier: "@biu-cs-planner/server", ...ERASED }),
  importing(
    "server",
    "server/src/api.ts",
    { specifier: "@biu-cs-planner/app", ...CODE },
    { specifier: "@biu-cs-planner/core", ...CODE },
  ),
  importing("app", "app/src/queries.ts", { specifier: "@biu-cs-planner/core", ...CODE }),
  leafIn("core", "core/src/plan.ts"),
];

/** One module importing another once, in whichever of the three states is given. */
const one = (kind: ImportKind): Module[] => [
  { ...leaf("core/src/a.ts"), imports: [{ specifier: "core/src/b.ts", ...kind }] },
  leaf("core/src/b.ts"),
];

/**
 * All three states at once: `a` imports `b` erasably, `c` with the inline `{ type X }`, and
 * `d` for its code.
 */
const threeStates: Module[] = [
  {
    ...leaf("core/src/a.ts"),
    imports: [
      { specifier: "core/src/b.ts", ...ERASED },
      { specifier: "core/src/c.ts", ...KEPT },
      { specifier: "core/src/d.ts", ...CODE },
    ],
  },
  leaf("core/src/b.ts"),
  leaf("core/src/c.ts"),
  leaf("core/src/d.ts"),
];

function report(over: Partial<Report> = {}): Report {
  return {
    modules: [
      {
        path: "core/src/a.ts",
        workspace: "core",
        exports: [{ name: "Thing", kind: "type", signature: "{ id: string }" }],
        imports: [{ specifier: "core/src/b.ts", ...CODE }],
        packages: [{ specifier: "zod", ...CODE }],
      },
      leaf("core/src/b.ts"),
    ],
    tests: [{ path: "core/src/a.test.ts", cases: [entry("works")], targets: [] }],
    coverage: {
      available: true,
      total: coverageOf(91),
      byFile: new Map([["core/src/a.ts", coverageOf(91)]]),
      deadFunctions: [],
    },
    edges: [{ from: "core/src/a.ts#one", to: "core/src/b.ts#two" }],
    unmeasured: [],
    // Empty by default, so every test above this line describes the report as it is when the
    // whole of what it read is also the whole of what it measured. The ones that pass a value
    // are testing what it says when that stops being true.
    testOnlyDirs: [],
    ...over,
  };
}

/** The module graph's mermaid source, which is the code block in the first fold. */
function moduleGraph(markdown: string): string {
  const body = folds(markdown)[0]?.body ?? "";
  return body.split("```mermaid")[1]?.split("```")[0] ?? "";
}

/**
 * What every arrow in the module graph points at. A negative assertion about a package
 * belongs here rather than over the whole graph text: `not.toContain("react")` across the
 * markdown would also fail on a module named `react-bridge.ts`, which is not what it claims
 * to test. The pattern is literal — two spaces, an id, either arrow, the target.
 */
function arrowTargets(markdown: string): string[] {
  return moduleGraph(markdown)
    .split("\n")
    .flatMap((line) => /^ {2}\w+ (?:-\.->|-->) (\S+)$/.exec(line)?.[1] ?? []);
}

/** The bodies of every fold, in order. */
function folds(markdown: string): Array<{ summary: string; body: string }> {
  const found: Array<{ summary: string; body: string }> = [];
  const parts = markdown.split("<details>").slice(1);
  for (const part of parts) {
    const open = part.indexOf("<summary>");
    const shut = part.indexOf("</summary>");
    found.push({
      summary: part.slice(open + "<summary>".length, shut),
      body: part.slice(shut + "</summary>".length, part.indexOf("</details>")),
    });
  }
  return found;
}

describe("the report comment", () => {
  it("folds every section that is reference material", () => {
    const summaries = folds(render(report())).map((f) => f.summary);

    expect(summaries).toHaveLength(5);
    for (const heading of [
      "How the modules depend on each other",
      "How a value flows through the functions",
      "The shapes the data takes",
      "What the tests claim the code does",
      "Coverage, file by file",
    ]) {
      expect(summaries.some((s) => s.includes(heading))).toBe(true);
    }
  });

  it("opens and closes every fold, so the comment is not one runaway section", () => {
    const markdown = render(report());
    const opened = markdown.split("<details>").length - 1;
    const shut = markdown.split("</details>").length - 1;

    expect(opened).toBe(shut);
  });

  it("says how much is inside before anyone spends the scroll on it", () => {
    const summaries = folds(render(report())).map((f) => f.summary);

    // A fold whose summary is only its title makes you open it to find out whether it was
    // worth opening, which is the thing folding was meant to stop.
    for (const summary of summaries) expect(summary).toMatch(/\d/);
  });

  it("counts what is actually in each fold", () => {
    const summaries = folds(render(report())).map((f) => f.summary).join("\n");

    expect(summaries).toContain("2 modules, 1 imports");
    expect(summaries).toContain("2 functions, 1 calls");
    expect(summaries).toContain("1 exported types");
    expect(summaries).toContain("1 tests in 1 files");
    expect(summaries).toContain("1 modules");
  });

  it("draws an erased import dashed and every import that survives the emit solid", () => {
    // The dashed arrow answers `erasable`, not `typeOnly`: it says nothing of the target
    // reaches the output. `a -> c` is the inline `import { type X }`, which carries only
    // types and still emits `import {} from "…"`, so it draws like the value edge beside
    // it — the review job fails that spelling on a narrowed edge, and a dashed arrow here
    // would tell a reviewer the opposite of the review's own comment on the pull request.
    const markdown = render(report({ modules: threeStates }));

    expect(markdown).toContain("core_src_a_ts -.-> core_src_b_ts");
    expect(markdown).toContain("core_src_a_ts --> core_src_c_ts");
    expect(markdown).toContain("core_src_a_ts --> core_src_d_ts");
    expect(markdown.match(/-\.->/g)).toHaveLength(1);
  });

  it("draws the inline spelling solid when it is the only narrowed import on the page", () => {
    // The middle state alone, with no erased edge to be compared against and no legend
    // sentence about dashed arrows: still not drawn as one.
    const markdown = render(report({ modules: one(KEPT) }));

    expect(markdown).toContain("core_src_a_ts --> core_src_b_ts");
    expect(markdown).not.toContain("-.->");
    expect(markdown).not.toContain("A dashed arrow");
  });

  it("counts the inline spelling apart from the imports that are erased", () => {
    const summaries = folds(render(report({ modules: threeStates })))
      .map((f) => f.summary)
      .join("\n");

    expect(summaries).toContain("4 modules, 3 imports, 1 erased, 1 type-only but not erased");
  });

  it("keeps the inline spelling out of the erased count when it is the only type-only edge", () => {
    // The count a reviewer reads before opening the fold. Grouping this edge with the
    // erased ones is the same claim the arrow used to make, one level up.
    const summaries = folds(render(report({ modules: one(KEPT) })))
      .map((f) => f.summary)
      .join("\n");

    expect(summaries).toContain("2 modules, 1 imports, 1 type-only but not erased");
    expect(summaries).not.toContain("1 erased");
  });

  it("explains what each arrow distinguishes, and names the spelling that draws solid", () => {
    const markdown = render(report({ modules: threeStates }));

    expect(markdown).toContain(
      "A dashed arrow is erased at compile time; a solid one leaves a statement in the output.",
    );
    expect(markdown).toContain('emits `import {} from "…"`');
  });

  it("says nothing about the inline spelling when no edge is written that way", () => {
    // A legend line for a state the graph does not contain is one more thing to hold in
    // mind while scanning, for nothing.
    const markdown = render(report({ modules: one(ERASED) }));

    expect(markdown).toContain("A dashed arrow is erased");
    expect(markdown).not.toContain("import {} from");
    expect(markdown).not.toContain("type-only but not erased");
  });

  it("leaves the count and the legend off when every edge carries code", () => {
    // Neither a "0 of them erased" nor a sentence explaining a dashed arrow that is not
    // on the page.
    const markdown = render(report());
    const summaries = folds(markdown).map((f) => f.summary).join("\n");

    expect(summaries).toContain("2 modules, 1 imports");
    expect(summaries).not.toContain("erased");
    expect(markdown).not.toContain("A dashed arrow");
    expect(markdown).not.toContain("import {} from");
  });

  it("draws an arrow at the imported workspace's box for an import written as a package name", () => {
    // The defect this covers: a cross-workspace import is always a bare specifier, so
    // `readModule` files it under `Module.packages`, and a graph built from
    // `Module.imports` alone drew all four workspaces as boxes and no arrow between any
    // two of them. A test over relative imports cannot see that field go unread.
    const graph = moduleGraph(render(report({ modules: chain })));

    // The arrow ends at the subgraph id, which is what makes it land in the box.
    expect(graph).toContain('subgraph server["server"]');
    expect(graph).toContain("web_src_api_ts -.-> server");
    expect(graph).toContain("server_src_api_ts --> app");
    expect(graph).toContain("server_src_api_ts --> core");
    expect(graph).toContain("app_src_queries_ts --> core");
  });

  it("draws a package edge dashed only when it is erased, the same rule as a local one", () => {
    // `web`'s one edge is `import type { ApiType } from "@biu-cs-planner/server"`, so it
    // is erased and dashed. Written with the inline `{ type ApiType }` it carries the same
    // type, still emits a specifier, and must draw solid — which is the spelling the
    // review job fails on this exact edge. The arrow and the gate ask one question.
    const inline = [
      importing("web", "web/src/api.ts", { specifier: "@biu-cs-planner/server", ...KEPT }),
      leafIn("server", "server/src/index.ts"),
    ];

    expect(moduleGraph(render(report({ modules: inline })))).toContain("web_src_api_ts --> server");
    expect(moduleGraph(render(report({ modules: inline })))).not.toContain("-.->");
  });

  it("draws no arrow for a package that is not one of this repo's workspaces", () => {
    // A node per library would bury the shape of the repo under its dependencies, and
    // `@biu-cs-planner/tools` is a box this graph never drew — an arrow at it would point
    // at nothing.
    //
    // The fixture draws one real arrow so that the negatives below are load-bearing: with
    // no arrow at all they would hold for a graph that was never rendered, which is how a
    // test passes for a reason its title does not mention.
    const markdown = render(
      report({
        modules: [
          {
            ...importing(
              "core",
              "core/src/plan.ts",
              { specifier: "zod", ...CODE },
              { specifier: "@types/node", ...ERASED },
              { specifier: "@biu-cs-planner/tools", ...CODE },
            ),
            imports: [{ specifier: "core/src/clock.ts", ...CODE }],
          },
          leaf("core/src/clock.ts"),
        ],
      }),
    );

    expect(arrowTargets(markdown)).toEqual(["core_src_clock_ts"]);
  });

  it("draws no arrow from a module to the box around it", () => {
    // A workspace importing its own package is an arrow from a node to its own container:
    // nothing a reader learns, and nothing mermaid draws sensibly. Anchored the same way —
    // the relative import beside it must still be drawn.
    const markdown = render(
      report({
        modules: [
          {
            ...importing("server", "server/src/api.ts", { specifier: "@biu-cs-planner/server", ...CODE }),
            imports: [{ specifier: "server/src/guard.ts", ...CODE }],
          },
          leafIn("server", "server/src/guard.ts"),
        ],
      }),
    );

    expect(arrowTargets(markdown)).toEqual(["server_src_guard_ts"]);
  });

  it("draws one arrow for a workspace imported twice, and lets the value import decide it", () => {
    // `@biu-cs-planner/core` beside a deep `@biu-cs-planner/core/thing` is one edge, and
    // `mergeImports` already says what one edge claims when two statements disagree: the
    // weaker wins, so a single value import makes it a value edge.
    const graph = moduleGraph(
      render(
        report({
          modules: [
            importing(
              "app",
              "app/src/queries.ts",
              { specifier: "@biu-cs-planner/core", ...ERASED },
              { specifier: "@biu-cs-planner/core/thing", ...CODE },
            ),
            leafIn("core", "core/src/plan.ts"),
          ],
        }),
      ),
    );

    expect(graph.match(/app_src_queries_ts/g)).toHaveLength(2);
    expect(graph).toContain("app_src_queries_ts --> core");
    expect(graph).not.toContain("-.->");
  });

  it("counts a package edge among the imports, and says how many leave their workspace", () => {
    // The counts and the arrows come from one function, so a field read for the picture
    // and not for the number is not a state this can be in.
    const summaries = folds(render(report({ modules: chain })))
      .map((f) => f.summary)
      .join("\n");

    expect(summaries).toContain("4 modules, 4 imports, 4 into another workspace, 1 erased");
  });

  it("explains that an arrow at a workspace box is an import written as a package name", () => {
    const markdown = render(report({ modules: chain }));

    expect(markdown).toContain("An arrow that ends at a **workspace box**");
    expect(markdown).toContain("names a package and not a file");
    // And does not claim these are the only edges the layering rule is about: a relative
    // cross-workspace import lands on a module, and test files are judged but not drawn.
    expect(markdown).toContain("relative path lands on a module rather than a box");
  });

  it("says nothing about workspace boxes when every arrow ends at a module", () => {
    // The default report imports `zod`, which is drawn nowhere, so there is no box edge to
    // explain and no count to print for one.
    const markdown = render(report());
    const summaries = folds(markdown).map((f) => f.summary).join("\n");

    expect(markdown).not.toContain("workspace box");
    expect(summaries).not.toContain("into another workspace");
  });

  it("leaves a blank line after every summary, which markdown inside needs", () => {
    // Without it GitHub renders the body as literal text, and a folded table becomes a
    // wall of pipes. It is invisible in review, so it is asserted here instead.
    for (const { body } of folds(render(report()))) expect(body.startsWith("\n\n")).toBe(true);
  });

  it("keeps the summary table out of a fold, because it is the part read at a glance", () => {
    const markdown = render(report());
    const firstFold = markdown.indexOf("<details>");

    expect(markdown.slice(0, firstFold)).toContain("| Modules | 2 across 1 workspaces |");
    expect(markdown.slice(0, firstFold)).toContain(
      "| Tests | 1 in 1 files, counted from the source |",
    );
  });

  it("keeps where-to-look out of a fold, and last", () => {
    const markdown = render(report({
      coverage: {
        available: true,
        total: coverageOf(40),
        byFile: new Map([["core/src/a.ts", coverageOf(40)]]),
        deadFunctions: [{ file: "core/src/a.ts", name: "never", line: 12 }],
      },
    }));

    const heading = markdown.indexOf("### Where to look, if you look anywhere");
    expect(heading).toBeGreaterThan(markdown.lastIndexOf("</details>"));
    expect(markdown.slice(heading)).toContain("`never` at `core/src/a.ts:12`");
    expect(markdown.slice(heading)).not.toContain("<details>");
  });

  it("still renders when there is nothing to report", () => {
    const empty = render({
      modules: [],
      tests: [],
      coverage: { available: false, byFile: new Map(), deadFunctions: [] },
      edges: [],
      unmeasured: [],
      testOnlyDirs: [],
    });

    expect(empty).toContain("| Coverage | not available — no coverage run |");
    expect(empty).toContain("0 modules, 0 imports");
    expect(empty).toContain("Nothing stands out");
    expect(folds(empty)).toHaveLength(5);
  });
});

/**
 * An area the report read test titles out of and described no other way. `collect` puts `tools/`
 * here; what is asserted below is not that `tools/` in particular is handled but that an
 * unmeasured area is never presented as an empty one — which is the criterion #123 states, and
 * the one that fails silently, because a report that says nothing looks exactly like a report
 * about code that has nothing.
 */
describe("a directory only test titles were read from", () => {
  /** Two `tools/` test files beside a measured one, which is this repo's own shape. */
  const withTools = (over: Partial<Report> = {}): Report =>
    report({
      tests: [
        { path: "core/src/a.test.ts", cases: [entry("works")], targets: [] },
        {
          path: "tools/ci/workflows.test.ts",
          cases: [
            entry("fails an install without --ignore-scripts", ["workflows"]),
            entry("fails a workflow with no permissions block", ["workflows"]),
          ],
          targets: [],
        },
        {
          path: "tools/ci/clock-pattern.test.ts",
          cases: [entry("fails a second clock body")],
          targets: [],
        },
      ],
      testOnlyDirs: ["tools"],
      ...over,
    });

  it("lists its test titles, so a change in it has a specification to be read against", () => {
    // The acceptance criterion in one assertion: a reviewer of a `tools/` change can see from
    // the report alone whether it has tests. Before #123 the titles were in no section of it.
    const markdown = render(withTools());

    expect(markdown).toContain("**tools/ci/workflows.test.ts** — 2 tests");
    expect(markdown).toContain("fails an install without --ignore-scripts");
    expect(markdown).toContain("fails a second clock body");
  });

  it("marks each such file, so its titles are not read as a measurement", () => {
    const markdown = render(withTools());

    expect(markdown).toContain(
      "**tools/ci/workflows.test.ts** — 2 tests — **titles only**, not graphed or measured",
    );
    // And the measured file beside it carries no such mark.
    expect(markdown).toContain("**core/src/a.test.ts** — 1 test\n");
  });

  it("says in the summary, above every fold, what the graphs and the numbers do not cover", () => {
    const markdown = render(withTools());
    const beforeFolds = markdown.slice(0, markdown.indexOf("<details>"));

    expect(beforeFolds).toContain("| Of those, titles only | 3 in 2 files under `tools/`");
    expect(beforeFolds).toContain(
      "`tools/` is in neither graph, in no exported-type list and in no coverage row",
    );
    // The distinction the whole ticket is about, in the words that make it: not measured is
    // not the same as has no tests.
    expect(beforeFolds).toContain("It is not measured, which is a different thing");
  });

  it("counts the titles-only tests apart on the fold that holds them", () => {
    const summaries = folds(render(withTools())).map((f) => f.summary).join("\n");

    expect(summaries).toContain("4 tests in 3 files, 3 of them titles only");
  });

  it("does not call the tree clean when part of it was never looked at", () => {
    // Everything measured is perfect, so the open section reaches its one-line verdict. That
    // line is the last thing a reviewer reads, and unqualified it says the repository is fine
    // on the strength of a run that never entered `tools/`.
    const markdown = render(withTools());
    const verdict = markdown.slice(markdown.indexOf("### Where to look"));

    expect(verdict).toContain("Nothing stands out among the modules measured");
    expect(verdict).not.toContain("Nothing stands out: every function ran");
    expect(verdict).toContain("Nothing above says anything about `tools/`");
    // "tests", not "test titles": the number counts what the run collects, and for `tools/`
    // the titles are still the whole of what the report knows about them (#136, #140).
    expect(verdict).toContain("3 tests in 2 files, their titles and nothing more");
  });

  it("explains inside the coverage fold why a path has no row there", () => {
    // A reader who opens only this fold and searches for a path finds nothing, and the absence
    // of a row reads like a row of zeroes.
    const coverageFold = folds(render(withTools()))[4]?.body ?? "";

    expect(coverageFold).toContain("No row is missing here because it is uncovered");
    expect(coverageFold).toContain("`tools/`");
  });

  it("keeps it out of the modules the coverage run failed to measure", () => {
    // Two different facts with one wrong name between them. `unmeasured` is for a module that
    // should have been covered and was not, which is a finding; a titles-only directory is a
    // decision. Listing the second among the first would make every report carry a permanent
    // complaint about a thing nobody intends to change.
    //
    // Asserted with a real `unmeasured` entry present, so the list is rendered and its contents
    // are what is being checked. Against an empty `unmeasured` the headings would be absent
    // whatever the implementation did, and the test would pass without asking anything.
    const markdown = render(withTools({ unmeasured: ["core/src/b.ts"] }));
    const verdict = markdown.slice(markdown.indexOf("### Where to look"));

    expect(markdown).toContain("| Modules with no coverage at all | 1 |");
    expect(verdict).toContain("Modules the test run does not measure at all");
    expect(verdict).toContain("- `core/src/b.ts`");
    // The decision, named separately and in its own sentence.
    expect(verdict).not.toContain("- `tools`");
    expect(verdict).not.toContain("- `tools/`");
    expect(verdict).toContain("Nothing above says anything about `tools/`");
  });

  it("says so even when the area declared unmeasured holds no test file at all", () => {
    // The case that forced scope and counts apart. Gating every sentence on the test files
    // *found* meant a declared directory with none produced total silence — no row, no scope
    // sentence, and "Nothing stands out: every function ran" as the last line read. That is
    // #123's failure mode restored in the one case where it is worst: not measured *and*
    // untested, reported as a clean tree.
    const markdown = render(report({ tests: [], testOnlyDirs: ["tools"] }));
    const verdict = markdown.slice(markdown.indexOf("### Where to look"));

    expect(markdown).toContain("| Titles only | `tools/` — no test file, no graph, no coverage |");
    expect(markdown).toContain("What it does have is **no test file at all**");
    expect(verdict).toContain("Nothing stands out among the modules measured");
    expect(verdict).not.toContain("Nothing stands out: every function ran");
    expect(verdict).toContain("**no test file at all**");
  });

  it("says the exported types do not cover it either", () => {
    // The fold built from `modules`, which the first draft of this left silent: a type exported
    // from a titles-only directory is absent exactly like a type that does not exist. `Report`
    // in `render.ts` is such a type, so this report was blind to its own shape.
    const typesFold = folds(render(withTools()))[2]?.body ?? "";

    expect(typesFold).toContain("Types exported from `tools/` are not here");
    // And the scope line above every fold enumerates it, rather than the graphs and coverage only.
    expect(render(withTools())).toContain("in no exported-type list");
  });

  it("reads as a list when more than one area is declared", () => {
    // Every sentence switches number on the directory list, which is its subject. Two entries
    // used to leave two of them reading "`a/`, `b/` has none because it is outside …".
    const markdown = render(withTools({ testOnlyDirs: ["tools", "scripts"] }));

    expect(markdown).toContain("`tools/`, `scripts/` are in neither graph");
    expect(markdown).toContain("What they do have is");
    expect(markdown).toContain("`tools/`, `scripts/` have none because they are outside");
    expect(markdown).not.toContain("are in neither graph, in no exported-type list and in no coverage row: a module graph of the tooling says nothing about the app, and `vitest.config.ts` leaves it out of coverage deliberately. What it does");
  });

  it("says none of it when everything read was also measured", () => {
    // The default fixture has no such directory. Every sentence above exists to stop one
    // reading, and with nothing to explain they would be a paragraph about nothing.
    const markdown = render(report());

    expect(markdown).not.toContain("titles only");
    expect(markdown).not.toContain("No row is missing here");
    expect(markdown).toContain("Nothing stands out: every function ran");
  });

  it("matches a directory by whole segments, not by the letters it starts with", () => {
    // `tools` is in the list and `toolsmith` is not, so the marker has to fall on exactly one of
    // the two. A plain `startsWith` would mark both and quietly stop measuring a workspace.
    const markdown = render(
      withTools({
        tests: [
          { path: "tools/ci/a.test.ts", cases: [entry("in tools")], targets: [] },
          {
            path: "toolsmith/src/a.test.ts",
            cases: [entry("not in tools")],
            targets: [],
          },
        ],
      }),
    );

    expect(markdown).toContain("**tools/ci/a.test.ts** — 1 test — **titles only**");
    expect(markdown).toContain("**toolsmith/src/a.test.ts** — 1 test\n");
    expect(markdown).toContain("| Of those, titles only | 1 in 1 files under `tools/`");
  });
});

/** The call graph's mermaid source, which is the code block in the second fold. */
const callGraph = (markdown: string): string => {
  const body = folds(markdown)[1]?.body ?? "";
  return body.split("```mermaid")[1]?.split("```")[0] ?? "";
};

/** The second fold whole, because half of what this graph says is on the outside of it. */
const callFold = (markdown: string): { summary: string; body: string } =>
  folds(markdown)[1] ?? { summary: "", body: "" };

/**
 * The call graph, whose nodes are `module#function` — and the module half is the whole of
 * #86. `calls.ts` is where a call is resolved and `calls.test.ts` is where that resolution is
 * held to account; what is asked here is what the report *says* about it, including the one
 * thing the graph used to say by saying nothing.
 */
describe("the call graph", () => {
  /** One call placed, one not. Both drawn. */
  const unplaced = report({
    edges: [
      { from: "core/src/a.ts#one", to: "core/src/b.ts#two" },
      { from: "core/src/a.ts#one", to: "(unresolved)#three" },
    ],
  });

  it("labels a node with the module the function is written in", () => {
    const graph = callGraph(render(report()));

    expect(graph).toContain('core_src_b_ts_two["b.two"]');
    expect(graph).toContain("core_src_a_ts_one --> core_src_b_ts_two");
  });

  it("draws a callee it could not place instead of leaving the call out", () => {
    // A dropped edge and a misdrawn one are the same failure: the graph is read before the
    // diff, so its silence is taken for an absence. The label is what a reader sees; the node
    // id is `id()`'s escaping and says nothing to anybody.
    const graph = callGraph(render(unplaced));

    expect(graph).toContain('["three — unresolved"]');
    expect(graph.split("\n").filter((line) => /^ {2}\w+ --> \w+$/.test(line))).toHaveLength(2);
  });

  it("counts the unresolved callees outside the fold, and not as functions", () => {
    // Two functions and one unresolved callee, which is not a third function: it stands for one
    // whose module could not be found. Counting it among them would be the summary making the
    // same confident claim the graph itself used to make.
    expect(callFold(render(unplaced)).summary).toContain("2 functions, 2 calls, 1 unresolved");
  });

  it("explains an unresolved node only when the graph holds one", () => {
    const placed = callFold(render(report()));

    // Rendered, and then silent on unresolved calls: a graph with none has nothing to explain
    // and a count of zero is noise. The first assertion is what stops the other two passing
    // over a fold that was never drawn.
    expect(placed.body).toContain("```mermaid");
    expect(placed.summary).not.toContain("unresolved");
    expect(placed.body).not.toContain("unresolved");
    expect(callFold(render(unplaced)).body).toContain("**unresolved**");
  });

  it("says what the graph is a graph of, resolution included", () => {
    // The sentence beside the picture used to be "Calls between the project's own functions.
    // Library calls are left out." — true, and silent on the question the graph was getting
    // wrong. What a reader needs to know is that a name is read as the caller's import of it,
    // and that a call staying inside its module is not an edge.
    const said = callFold(render(report())).body;

    expect(said).toContain("resolved through the calling module's own imports");
    expect(said).toContain("does not leave the module it is written in");
  });
});

/**
 * The graph against the tree it describes. The unit tests above prove the rule; these prove
 * that this repo's own dependencies land in the picture a reviewer is told to read first.
 */
describe("this repository", () => {
  it("draws the narrowed `web → server` edge, and draws it dashed", () => {
    // `web/src/api.ts` writes `import type { ApiType } from "@biu-cs-planner/server"`: the
    // project's only narrowed edge, the subject of #51, #58, #59 and #69 — and, until #77,
    // in neither this graph nor its counts.
    expect(moduleGraph(render(collect(ROOT)))).toContain("web_src_api_ts -.-> server");
  });

  it("draws every cross-workspace dependency the source actually writes", () => {
    // Re-derived from `Module.packages` rather than listed by hand, so a new cross-workspace
    // import is covered the day it is written and this does not go stale.
    //
    // That makes `expected` and the implementation share an oracle — both apply
    // `packageWorkspace` and read `erasable` — so the count is then checked the other way
    // round as well, against arrows counted straight out of the mermaid by shape. A
    // dropped edge fails the loop below; an invented one, or an edge dropped on both
    // sides, fails the length. `packageWorkspace` itself is pinned by its own tests in
    // `surface.test.ts`, and the one hardcoded edge is the test above.
    const derived = collect(ROOT);
    const graph = moduleGraph(render(derived));

    // The same boxes the graph drew, so a `@biu-cs-planner/<something not a workspace>`
    // import would not fail this test for behaving exactly as designed.
    const boxes = new Set(derived.modules.map((m) => m.workspace));
    const expected = derived.modules.flatMap((m) =>
      m.packages.flatMap((dep) => {
        const workspace = packageWorkspace(dep.specifier);
        if (!workspace || workspace === m.workspace || !boxes.has(workspace)) return [];
        const arrow = dep.erasable ? "-.->" : "-->";
        return [`${m.path.replace(/[^A-Za-z0-9]/g, "_")} ${arrow} ${workspace}`];
      }),
    );

    // A literal pattern, not one built from data: two spaces, an id, either arrow, and a
    // target that is one of the four workspace box ids and nothing longer.
    const boxArrows = graph
      .split("\n")
      .filter((line) => /^ {2}\w+ (-\.->|-->) (core|app|server|web)$/.test(line));

    expect(expected.length).toBeGreaterThan(1);
    expect(boxArrows).toHaveLength(expected.length);
    for (const edge of expected) expect(graph).toContain(edge);
  });

  it("points no arrow at a third-party package", () => {
    // `zod`, `hono` and `react` are in `Module.packages` beside the workspace names, and an
    // arrow is the only way a package could enter this graph. Asserted against the arrow
    // targets rather than the graph text, so a module file named after a library does not
    // fail it.
    const targets = arrowTargets(render(collect(ROOT)));

    for (const pkg of ["zod", "hono", "react"]) expect(targets).not.toContain(pkg);
    expect(targets.length).toBeGreaterThan(1);
  });
});

/**
 * The count a reviewer reads as "tests", and what the report says it is.
 *
 * `CLAUDE.md` sends a reviewer to this page *before* the diff, on the grounds that it is derived
 * from the source and so cannot drift from it. That is what makes a mislabelled number here
 * worse than the same number anywhere else: it is read instead of the thing it is wrong about.
 * What is asserted below is not a count but a claim — that no number in the report is presented
 * as something it is not, and that where the two sources it opens by claiming can disagree, it
 * says so instead of choosing (#140).
 */
describe("the number a reviewer reads as tests", () => {
  /** An entry that runs its table's rows: one title, several tests. */
  const parameterised = (title: string, tests: number): TestCase => ({
    title,
    suite: [],
    tests,
    atLeast: false,
  });

  /** An entry parameterised by a table the source does not fix. */
  const floor = (title: string): TestCase => ({ title, suite: [], tests: 1, atLeast: true });

  /** A file of entries, under a path. */
  const file = (path: string, ...cases: TestCase[]) => ({ path, cases, targets: [] });

  /** A run that collected what it collected, per file. */
  const ran = (byFile: Record<string, number>): TestRun => ({
    available: true,
    byFile: new Map(Object.entries(byFile)),
    tests: Object.values(byFile).reduce((n, c) => n + c, 0),
  });

  /** The summary table, which is the part read at a glance and where the row lives. */
  const summary = (markdown: string): string => markdown.slice(0, markdown.indexOf("<details>"));

  it("says the count is read from the source, not leaving `Tests` to be read as a run's", () => {
    const markdown = render(
      report({ tests: [file("core/src/a.test.ts", parameterised("handles %s", 4))] }),
    );

    expect(summary(markdown)).toContain("| Tests | 4 in 1 files, counted from the source |");
  });

  it("counts a parameterised entry's rows, and says on the entry that it is one", () => {
    // The entry list is 1 bullet under a total of 4, which is exactly the arithmetic that
    // produced this ticket: a reader counting bullets and taking the answer for the tests.
    const markdown = render(
      report({ tests: [file("core/src/a.test.ts", parameterised("handles %s", 4))] }),
    );

    expect(markdown).toContain("**core/src/a.test.ts** — 4 tests");
    expect(markdown).toContain("- handles %s — **4 cases**, one per row of its table");
  });

  it("prints a floor where a table could not be read, and does not pass it off as a count", () => {
    const markdown = render(
      report({ tests: [file("core/src/a.test.ts", floor("handles %s"), entry("works"))] }),
    );

    expect(summary(markdown)).toContain("| Tests | at least 2 in 1 files, counted from the source |");
    // "counted as one row", not "counts for one test": an entry whose table went unread still
    // multiplies by every readable table around it, so the tests it comes to need not be one.
    expect(summary(markdown)).toContain(
      "| Tables not fixed by the source | 1 parameterised suite is counted as one row each",
    );
    expect(markdown).toContain(
      "- handles %s — parameterised by a table this report could not read, so **at least 1**",
    );
  });

  it("says nothing checks the count when no run left one behind", () => {
    // Not silence: a report built without a run has one source for a sentence that claims two,
    // and a reader has no way to tell that from a report whose two sources agreed.
    const markdown = render(report());

    expect(summary(markdown)).toContain(
      "| A run to check it against | none — no test run left its own count beside this report |",
    );
    expect(markdown).toContain("**Nothing checks the count above.**");
  });

  it("says which run it checked against, and that the run is not the whole suite", () => {
    // The trap this ticket sets: the run behind the report is the coverage run, which is the
    // node project alone, so its total is smaller than the suite's by the browser project.
    // Printed beside a whole-tree total with nothing saying which was which, it would be a
    // second misleading number in place of the first.
    const markdown = render(
      report({
        tests: [
          file("core/src/a.test.ts", parameterised("handles %s", 4)),
          file("web/src/b.browser.test.tsx", entry("draws the week")),
        ],
        run: ran({ "core/src/a.test.ts": 4 }),
      }),
    );

    expect(summary(markdown)).toContain(
      "| A run to check it against | 4 tests across the 1 file it ran, and it agrees on every one |",
    );
    // The row carries no pronoun, so it reads the same wherever the table puts it.
    expect(summary(markdown)).not.toContain("of them, across");
    expect(markdown).toContain("that run is **not the whole suite**");
    expect(markdown).toContain("1 file was not in it: 1 test that only the source counts");
    expect(markdown).toContain("5 is what the source accounts for across every file, 4 is what that one run collected");
  });

  it("marks the file the run did not run, where that file is listed", () => {
    // Per file, because a reviewer arrives at the fold looking a file up by name and would
    // otherwise have to carry the scope sentence from the top of the report in their head.
    const markdown = render(
      report({
        tests: [
          file("core/src/a.test.ts", entry("works")),
          file("web/src/b.browser.test.tsx", entry("draws the week")),
        ],
        run: ran({ "core/src/a.test.ts": 1 }),
      }),
    );

    expect(markdown).toContain(
      "**web/src/b.browser.test.tsx** — 1 test — not in the run this report was built beside",
    );
    // And the file the run did confirm carries no mark, because there is nothing to say.
    expect(markdown).toContain("**core/src/a.test.ts** — 1 test\n");
  });

  it("names a file the two sources disagree about, and chooses neither", () => {
    const markdown = render(
      report({
        tests: [file("core/src/a.test.ts", parameterised("handles %s", 4))],
        run: ran({ "core/src/a.test.ts": 7 }),
      }),
    );

    expect(summary(markdown)).toContain(
      "| A run to check it against | **it disagrees on 1 file** — named below |",
    );
    expect(markdown).toContain("**Where they disagree.**");
    expect(markdown).toContain("`core/src/a.test.ts` — the source counts 4, the run collected 7");
    // Marked on the file too, so the disagreement is in front of whoever opens that fold.
    expect(markdown).toContain("**core/src/a.test.ts** — 4 tests — **the run collected 7**");
  });

  it("treats a run above a floor as agreement and one below it as a disagreement", () => {
    // A floor says "at least this many". A run that finds more is the floor working; a run that
    // finds fewer is the report wrong about a file, and only the second is worth a reader's
    // attention. Reported the other way round, every unread table would read as a defect.
    const above = render(
      report({
        tests: [file("core/src/a.test.ts", floor("handles %s"))],
        run: ran({ "core/src/a.test.ts": 9 }),
      }),
    );
    const below = render(
      report({
        tests: [file("core/src/a.test.ts", floor("handles %s"), entry("works"))],
        run: ran({ "core/src/a.test.ts": 1 }),
      }),
    );

    expect(above).not.toContain("**Where they disagree.**");
    expect(below).toContain("`core/src/a.test.ts` — the source counts at least 2, the run collected 1");
  });

  it("claims no agreement from a run that ran none of the files listed here", () => {
    // A stale `coverage/test-results.json` — left by another tree, or another root, so no path
    // matches. The run is available and its totals are non-zero, and a check that only asked
    // "did any file disagree?" answered no and printed "agrees on every one" of nothing. That is
    // agreement asserted from no evidence, in the row read first, which is this ticket's own
    // defect wearing a third hat.
    const markdown = render(
      report({
        tests: [file("core/src/a.test.ts", entry("works"))],
        run: ran({ "somewhere/else/b.test.ts": 40 }),
      }),
    );

    expect(summary(markdown)).not.toContain("agrees on every one");
    expect(summary(markdown)).toContain("it ran none of the files listed here");
    expect(markdown).toContain("**Nothing here was checked.**");
    // And it still says what that run did run, so the reader can see why nothing matched.
    expect(markdown).toContain("- `somewhere/else/b.test.ts`");
  });

  it("does not bold a floor the run merely exceeded as though the report were wrong", () => {
    // The summary calls this agreement, so the line on the file must not contradict it. Both
    // answers used to be derived separately, and one said "agrees on every one" while the other
    // printed the run's number in the bold kept for the report being wrong about a file.
    const markdown = render(
      report({
        tests: [file("core/src/a.test.ts", floor("handles %s"))],
        run: ran({ "core/src/a.test.ts": 9 }),
      }),
    );

    expect(summary(markdown)).toContain("agrees on every one");
    expect(markdown).toContain("**core/src/a.test.ts** — at least 1 tests — the run found 9");
    expect(markdown).not.toContain("**the run collected 9**");
  });

  it("names a test file the run found that it lists nowhere", () => {
    // The other direction, and the one #123 was about: a file the report never walked is a file
    // it says nothing about, and silence about a file that has tests reads as a file that has
    // none. Here the run is the witness that the walk missed something.
    const markdown = render(
      report({
        tests: [file("core/src/a.test.ts", entry("works"))],
        run: ran({ "core/src/a.test.ts": 1, "tools/ci/workflows.test.ts": 12 }),
      }),
    );

    expect(markdown).toContain("**The run found tests in files this report does not list.**");
    expect(markdown).toContain("- `tools/ci/workflows.test.ts`");
  });
});
