import type { CallEdge } from "./calls.ts";
import type { Coverage } from "./coverage.ts";
import type { Module } from "./surface.ts";
import { moduleName } from "./surface.ts";
import type { TestFile } from "./tests.ts";

export type Report = {
  modules: Module[];
  tests: TestFile[];
  coverage: Coverage;
  edges: CallEdge[];
  /** Modules the coverage run did not measure at all. */
  unmeasured: string[];
};

const id = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "_");
const esc = (s: string): string => s.replace(/"/g, "'").replace(/\|/g, "\\|");
const bar = (n: number): string => "█".repeat(Math.round(n / 10)).padEnd(10, "░");

/**
 * Modules as nodes, imports as edges, grouped by workspace.
 *
 * A dashed arrow is **erased**: every statement on that edge compiles to nothing, so the
 * edge leaves no specifier for a bundler to resolve. (Only the edge — another importer may
 * still reach the same module.) It is still a real dependency — the shapes it names bind
 * the two modules together — and that is worth seeing without opening either file.
 *
 * A solid arrow leaves a statement in the output. Usually because it carries code, and also
 * for the inline `import { type X } from "…"`, which carries only types and still emits
 * `import {} from "…"` — `ImportKind`'s table measures each of the five static forms
 * against the compiler. That specifier is resolved, so the target module is reached and
 * whatever it imports at its top comes with it.
 *
 * **So the arrow asks `erasable`, not `typeOnly`.** `typeOnly` is the weaker of the two
 * fields and splits the wrong way for a graph: it would draw the inline spelling like the
 * erased imports, while `tools/pr-review/layering.ts` decides a narrowed edge on `erasable`
 * alone and posts a `spelling` finding against that same edge — in the review's own
 * comment, under its own marker, beside this one on the same pull request. A reviewer is
 * told to read this report before the diff, so a dashed arrow here would be the reassuring
 * half of a pair of comments that disagree.
 *
 * Two styles, not three for `ImportKind`'s three states. What a reader scans this graph for
 * is whether an edge survives to the output. Mermaid can draw a third — `==>`, or a
 * labelled edge — but solid and dashed are the pair that read as "real" and "not real" on
 * sight, and a third mark would carry its meaning entirely in the legend. The legend is
 * what misled here: "carries only types" was true and still wrong. And the inline spelling
 * is a state to notice and fix rather than one to give standing notation to. It is not
 * hidden — solid is the safe direction, and `render` counts it separately and names the
 * spelling whenever the graph holds one.
 *
 * One limit to know while reading the graph: it draws only edges between modules it has
 * nodes for, so a bare specifier goes into `Module.packages` and is drawn nowhere — and
 * `@biu-cs-planner/server`, the project's one narrowed edge, is bare. `forbiddenEdges`
 * judges both. So what this arrow now agrees with the check about is every cross-workspace
 * edge written as a relative path, and the bare-package spelling is outside this graph and
 * its counts entirely.
 */
function moduleMap(modules: Module[]): string {
  const byWorkspace = new Map<string, Module[]>();
  for (const m of modules) {
    byWorkspace.set(m.workspace, [...(byWorkspace.get(m.workspace) ?? []), m]);
  }

  const lines = ["flowchart LR"];
  for (const [workspace, mods] of byWorkspace) {
    lines.push(`  subgraph ${id(workspace)}["${workspace}"]`);
    for (const m of mods) lines.push(`    ${id(m.path)}["${esc(moduleName(m.path))}"]`);
    lines.push("  end");
  }
  const paths = new Set(modules.map((m) => m.path));
  for (const m of modules) {
    for (const dep of m.imports) {
      if (!paths.has(dep.specifier)) continue;
      lines.push(`  ${id(m.path)} ${dep.erasable ? "-.->" : "-->"} ${id(dep.specifier)}`);
    }
  }
  return lines.join("\n");
}

/** Function-level call graph: the path a value actually takes through the code. */
function logicFlow(edges: CallEdge[]): string {
  if (!edges.length) return "flowchart LR\n  none[\"no internal calls found\"]";
  const label = (ref: string): string => {
    const [path, fn] = ref.split("#");
    return `${moduleName(path ?? "")}.${fn ?? ""}`;
  };
  const lines = ["flowchart LR"];
  const seen = new Set<string>();
  for (const e of edges) {
    for (const ref of [e.from, e.to]) {
      if (!seen.has(ref)) {
        seen.add(ref);
        lines.push(`  ${id(ref)}["${esc(label(ref))}"]`);
      }
    }
  }
  const drawn = new Set<string>();
  for (const e of edges) {
    const key = `${e.from}->${e.to}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    lines.push(`  ${id(e.from)} --> ${id(e.to)}`);
  }
  return lines.join("\n");
}

/**
 * A section GitHub keeps shut until someone asks for it.
 *
 * Most of this report is reference material — every test title, every edge of two graphs —
 * and a reviewer scanning a pull request reads none of it in passing. Shut, each section is
 * one line carrying its own size, so the choice to open it is made knowing what it costs.
 *
 * The blank line after `</summary>` is load-bearing. Without it GitHub renders the body as
 * literal text instead of markdown, which is how a folded table becomes a wall of pipes.
 */
function fold(summary: string, body: readonly string[]): string[] {
  return ["<details>", `<summary>${summary}</summary>`, "", ...body, "</details>", ""];
}

/** A fold's title. Bold rather than a heading: `<summary>` renders no `###`. */
const title = (text: string, size: string): string => `<strong>${text}</strong> — ${size}`;

export function render(report: Report): string {
  const { modules, tests, coverage, edges, unmeasured } = report;
  const cases = tests.reduce((n, t) => n + t.cases.length, 0);
  const out: string[] = [];

  out.push("## What this change is, without reading it");
  out.push("");
  out.push(
    "Everything below is derived from the source and from a real test run. " +
      "Nothing is summarised by hand, so if it disagrees with the code, it is the report that is wrong.",
  );
  out.push("");
  out.push("The sections fold open. Each says how much is inside before you spend the scroll on it.");
  out.push("");

  const t = coverage.total;
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Modules | ${modules.length} across ${new Set(modules.map((m) => m.workspace)).size} workspaces |`);
  out.push(`| Tests | ${cases} in ${tests.length} files |`);
  if (t) {
    out.push(`| Statements | \`${bar(t.statements)}\` ${t.statements}% |`);
    out.push(`| Branches | \`${bar(t.branches)}\` ${t.branches}% |`);
    out.push(`| Functions | \`${bar(t.functions)}\` ${t.functions}% |`);
    out.push(`| Uncovered lines | ${t.uncoveredLines} |`);
  } else {
    out.push("| Coverage | not available — no coverage run |");
  }
  out.push(`| Functions never executed by a test | ${coverage.deadFunctions.length} |`);
  if (unmeasured.length) out.push(`| Modules with no coverage at all | ${unmeasured.length} |`);
  out.push("");

  const paths = new Set(modules.map((m) => m.path));
  const drawn = modules.flatMap((m) => m.imports.filter((d) => paths.has(d.specifier)));
  const erased = drawn.filter((d) => d.erasable).length;
  // Counted apart from the erased ones, never folded in with them: an import written
  // `import { type X }` carries only types and still leaves `import {} from "…"` in the
  // output, which is the difference `tools/pr-review/layering.ts` fails a narrowed edge
  // over. A summary that added the two together would make the same claim the arrow used
  // to make, one level up and read even sooner.
  const kept = drawn.filter((d) => d.typeOnly && !d.erasable).length;
  // Both counts are named in the summary rather than left inside, so a reviewer deciding
  // whether to open the fold already knows whether any edge is only a shape — and whether
  // any edge only looks like one.
  const size =
    `${modules.length} modules, ${drawn.length} imports` +
    (erased ? `, ${erased} erased` : "") +
    (kept ? `, ${kept} type-only but not erased` : "");
  out.push(
    ...fold(title("How the modules depend on each other", size), [
      // Each line is worth saying only when the graph contains the thing it explains. A
      // graph of solid arrows explains itself, and a graph with no arrows at all has
      // nothing to explain.
      ...(erased
        ? ["A dashed arrow is erased at compile time; a solid one leaves a statement in the output.", ""]
        : []),
      ...(kept
        ? [
            'An inline `import { type X } from "…"` carries only types and still emits ' +
              '`import {} from "…"`, so the target is reached. Those draw solid, and where the ' +
              "layering table narrows an edge, that spelling fails it.",
            "",
          ]
        : []),
      "```mermaid",
      moduleMap(modules),
      "```",
      "",
    ]),
  );

  const functions = new Set(edges.flatMap((e) => [e.from, e.to])).size;
  const calls = new Set(edges.map((e) => `${e.from}->${e.to}`)).size;
  out.push(
    ...fold(title("How a value flows through the functions", `${functions} functions, ${calls} calls`), [
      "Calls between the project's own functions. Library calls are left out.",
      "",
      "```mermaid",
      logicFlow(edges),
      "```",
      "",
    ]),
  );

  const shapes: string[] = [];
  let typeCount = 0;
  for (const m of modules) {
    const types = m.exports.filter((e) => e.kind === "type");
    if (!types.length) continue;
    typeCount += types.length;
    shapes.push(`**${moduleName(m.path)}**`);
    shapes.push("");
    shapes.push("```ts");
    for (const e of types) shapes.push(`type ${e.name} = ${e.signature}`);
    shapes.push("```");
    shapes.push("");
  }
  out.push(...fold(title("The shapes the data takes", `${typeCount} exported types`), shapes));

  const claims: string[] = [];
  claims.push("Test titles, verbatim. This is the specification the change is held to.");
  claims.push("");
  for (const file of tests) {
    if (!file.cases.length) continue;
    claims.push(`**${file.path}** — ${file.cases.length} tests`);
    claims.push("");
    for (const c of file.cases) {
      claims.push(`- ${c.suite.length ? `*${c.suite.join(" › ")}* — ` : ""}${c.title}`);
    }
    claims.push("");
  }
  out.push(...fold(title("What the tests claim the code does", `${cases} tests in ${tests.length} files`), claims));

  const rows = [...coverage.byFile.entries()].sort((a, b) => a[1].branches - b[1].branches);
  const byFile: string[] = [];
  byFile.push("| Module | Statements | Branches | Functions | Uncovered lines |");
  byFile.push("|---|---:|---:|---:|---:|");
  for (const [path, c] of rows) {
    byFile.push(
      `| \`${moduleName(path)}\` | ${c.statements}% | ${c.branches}% | ${c.functions}% | ${c.uncoveredLines} |`,
    );
  }
  byFile.push("");
  out.push(...fold(title("Coverage, file by file", `${rows.length} modules`), byFile));

  // Open, and last. It is the only section that says where to spend attention, and folding
  // it would hide the one part of this report written to be read rather than consulted.
  out.push("### Where to look, if you look anywhere");
  out.push("");
  const weak = rows.filter(([, c]) => c.branches < 85);
  const dead = coverage.deadFunctions;

  if (!weak.length && !dead.length && !unmeasured.length) {
    out.push("Nothing stands out: every function ran, and no file is below 85% branch coverage.");
    out.push("");
  }
  if (dead.length) {
    out.push("**Functions no test ever entered.** Not a style complaint — this code did not run:");
    out.push("");
    for (const d of dead) {
      out.push(`- \`${d.name}\` at \`${d.file}:${d.line}\``);
    }
    out.push("");
  }
  if (weak.length) {
    out.push("Files whose branches are least exercised — the paths most likely to be wrong:");
    out.push("");
    for (const [path, c] of weak) {
      out.push(`- \`${moduleName(path)}\` — ${c.branches}% of branches, ${c.uncoveredLines} lines never run`);
    }
    out.push("");
  }
  if (unmeasured.length) {
    out.push("Modules the test run does not measure at all:");
    out.push("");
    for (const p of unmeasured) out.push(`- \`${p}\``);
    out.push("");
  }
  out.push(
    "> Coverage says a line ran, never that it is right. A high number with vague test " +
      "titles is worth less than a lower one whose titles above read like the behaviour you wanted.",
  );

  return out.join("\n");
}
