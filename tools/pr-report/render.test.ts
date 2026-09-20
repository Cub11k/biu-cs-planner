import { describe, expect, it } from "vitest";
import { render, type Report } from "./render.ts";
import type { ImportKind, Module } from "./surface.ts";

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
    tests: [{ path: "core/src/a.test.ts", cases: [{ title: "works", suite: [] }], targets: [] }],
    coverage: {
      available: true,
      total: coverageOf(91),
      byFile: new Map([["core/src/a.ts", coverageOf(91)]]),
      deadFunctions: [],
    },
    edges: [{ from: "core/src/a.ts#one", to: "core/src/b.ts#two" }],
    unmeasured: [],
    ...over,
  };
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

  it("leaves a blank line after every summary, which markdown inside needs", () => {
    // Without it GitHub renders the body as literal text, and a folded table becomes a
    // wall of pipes. It is invisible in review, so it is asserted here instead.
    for (const { body } of folds(render(report()))) expect(body.startsWith("\n\n")).toBe(true);
  });

  it("keeps the summary table out of a fold, because it is the part read at a glance", () => {
    const markdown = render(report());
    const firstFold = markdown.indexOf("<details>");

    expect(markdown.slice(0, firstFold)).toContain("| Modules | 2 across 1 workspaces |");
    expect(markdown.slice(0, firstFold)).toContain("| Tests | 1 in 1 files |");
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
    });

    expect(empty).toContain("| Coverage | not available — no coverage run |");
    expect(empty).toContain("0 modules, 0 imports");
    expect(empty).toContain("Nothing stands out");
    expect(folds(empty)).toHaveLength(5);
  });
});
