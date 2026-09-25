import { UNRESOLVED, type CallEdge } from "./calls.ts";
import type { Coverage } from "./coverage.ts";
import type { ImportKind, Module } from "./surface.ts";
import { mergeImports, moduleName, packageWorkspace } from "./surface.ts";
import type { TestFile } from "./tests.ts";

export type Report = {
  modules: Module[];
  tests: TestFile[];
  coverage: Coverage;
  edges: CallEdge[];
  /** Modules the coverage run did not measure at all. */
  unmeasured: string[];
  /**
   * Directories `collect` read test titles out of and described no other way: no module in
   * either graph, no row in the coverage table. `TEST_ONLY_DIRS` in `tools/pr-report/collect.ts`
   * says which and why.
   *
   * It is here so that the report can **say** so. An area left out silently reads as an area
   * with nothing in it, and a reviewer sent to this report before a `tools/` diff (`CLAUDE.md`)
   * read "no tests" where the truth was "not measured" (#123). Every sentence `render` builds
   * from this field exists to stop one specific reading, so an empty list produces none of
   * them rather than a paragraph about nothing.
   */
  testOnlyDirs: string[];
};

const id = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "_");
const esc = (s: string): string => s.replace(/"/g, "'").replace(/\|/g, "\\|");
const bar = (n: number): string => "█".repeat(Math.round(n / 10)).padEnd(10, "░");

/**
 * Whether a repo-relative path lies in one of the directories only test titles were read from.
 *
 * Matched a whole segment at a time rather than by `startsWith` alone, so `tools` does not claim
 * a `toolsmith/` nobody put in the list. The comparison lives here, in the one place that asks
 * the question, rather than each caller re-deriving a prefix rule.
 */
const inTestOnly = (path: string, dirs: readonly string[]): boolean =>
  dirs.some((dir) => path === dir || path.startsWith(`${dir}/`));

/** The directories as a reader names them: one `tools/`, or a list where there are several. */
const dirList = (dirs: readonly string[]): string =>
  dirs.map((dir) => `\`${dir}/\``).join(", ");

/**
 * One arrow, ready to draw.
 *
 * Deliberately **not** an `ImportRef` with fields added. `ImportRef.specifier` is documented
 * as "repo-relative path for a local import, the package name for a bare one", and `to` here
 * is neither of those for a package edge: it is the **workspace name**, which is the id of
 * its box. Widening a documented field to mean a third thing is how a report starts
 * disagreeing with itself, so the mermaid target gets its own name and the import's kind is
 * carried whole rather than spread flat.
 *
 * `box` says whether the arrow ends at a workspace box or at a module, so the legend can
 * explain the first only when the graph holds one. The two workspaces are carried because
 * the count a reviewer reads before opening the fold is how many arrows leave their
 * workspace, and that is a question about where an arrow lands rather than how it was
 * written.
 */
type DrawnEdge = {
  /** Repo-relative path of the module that writes the import. */
  from: string;
  /** The workspace that module lives in. */
  fromWorkspace: string;
  /** What the arrow points at: a module's repo-relative path, or a workspace's name. */
  to: string;
  /** The workspace the arrow lands in. */
  toWorkspace: string;
  /** Whether `to` is a workspace box rather than a module. */
  box: boolean;
  /** What travels along the import, and whether the statement survives the emit. */
  kind: ImportKind;
};

/**
 * Every arrow the module graph draws, from **both** of the fields an import can land in.
 *
 * `readModule` splits an import two ways: a relative one goes to `Module.imports` as a
 * repo-relative path, and a bare one goes to `Module.packages` under the name it was
 * written with. A cross-workspace import in this repo is always bare, so it is always in
 * `packages` — and a version of this drawing read `imports` alone. It drew all four
 * workspaces as boxes and **not one arrow between two of them**: the whole
 * `web → server → app → core` chain that `docs/design.md` "Architecture" describes and
 * `tools/pr-review/layering.ts` polices was absent from the picture `CLAUDE.md` sends a
 * reviewer to before the diff (#77). `forbiddenEdges` reads both fields and always has,
 * which is why the check was right about `web → server` while the graph beside it was
 * silent.
 *
 * So the counts and the arrows both come from here, one function, rather than each field
 * being remembered in each place: it was exactly one field going unread in one place that
 * caused this, and `render` used to recompute the drawn set for its own summary.
 *
 * What still gets no arrow, and each for its own reason:
 *
 * - A third-party package — `zod`, `hono`, `react`. This graph is the shape of *this* repo,
 *   and a node per library would bury that.
 * - A scoped name with no workspace behind it. `@biu-cs-planner/tools` would be an arrow at
 *   a box this graph never drew, so it is dropped rather than invented.
 * - A workspace importing its own package. That is an arrow from a node to the box around
 *   it, which tells a reader nothing and which mermaid has no sensible drawing for.
 * - A `node:` builtin and a dynamic `import()`, neither of which `readModule` records at
 *   all.
 */
function drawnEdges(modules: readonly Module[]): DrawnEdge[] {
  const paths = new Set(modules.map((m) => m.path));
  const boxes = new Set(modules.map((m) => m.workspace));
  const out: DrawnEdge[] = [];

  for (const m of modules) {
    for (const dep of m.imports) {
      if (!paths.has(dep.specifier)) continue;
      out.push({
        from: m.path,
        fromWorkspace: m.workspace,
        to: dep.specifier,
        toWorkspace: dep.specifier.split("/")[0] ?? "",
        box: false,
        kind: dep,
      });
    }

    // Re-specified from the package name to the workspace name, which is the id of its
    // box, and then merged: `@biu-cs-planner/core` beside `@biu-cs-planner/core/thing` is
    // one arrow, and `mergeImports` is already the rule for what that one arrow says —
    // the weaker statement wins, so a single value import makes the edge a value edge.
    const crossing = m.packages.flatMap((dep) => {
      const workspace = packageWorkspace(dep.specifier);
      if (!workspace || workspace === m.workspace || !boxes.has(workspace)) return [];
      return [{ ...dep, specifier: workspace }];
    });
    for (const dep of mergeImports(crossing)) {
      out.push({
        from: m.path,
        fromWorkspace: m.workspace,
        to: dep.specifier,
        toWorkspace: dep.specifier,
        box: true,
        kind: dep,
      });
    }
  }

  return out;
}

/**
 * Modules as nodes, grouped into a box per workspace, and every import an edge — but not
 * every edge ends at a module. A relative import points at the module it names; a
 * cross-workspace import is written as a package name and points at the **workspace box**.
 * `drawnEdges` is where that is decided, and where what is deliberately drawn nowhere is
 * listed.
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
 * **A package edge is drawn by that same rule**, which is much of the point of drawing them
 * at all: the project's one narrowed edge is `web/src/api.ts -.-> server`, dashed because
 * `import type { ApiType } from "@biu-cs-planner/server"` is erased. Four tickets in a row
 * (#51, #58, #59, #69) reasoned about how that edge is drawn while it was in neither this
 * graph nor its counts. It is in both now, and it asks the question the gate asks.
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
  for (const edge of drawnEdges(modules)) {
    lines.push(`  ${id(edge.from)} ${edge.kind.erasable ? "-.->" : "-->"} ${id(edge.to)}`);
  }
  return lines.join("\n");
}

/**
 * Function-level call graph: the path a value actually takes through the code.
 *
 * A node is `module#function`, and the module half is the point. `calls.ts` resolves a call
 * through the importing module's own import statements, so a `groupKey()` written in `core`
 * is `core`'s `groupKey` whatever else in the repository exports that name (#86).
 *
 * A callee this repo owns that could not be placed in a module gets a node of its own,
 * labelled unresolved, rather than being left out — see `UNRESOLVED` for why silence would be
 * the worse answer. The graph is read before the diff, so a missing arrow makes a claim too.
 */
function logicFlow(edges: CallEdge[]): string {
  if (!edges.length) return "flowchart LR\n  none[\"no internal calls found\"]";
  const label = (ref: string): string => {
    const [path, fn] = ref.split("#");
    return path === UNRESOLVED
      ? `${fn ?? ""} — unresolved`
      : `${moduleName(path ?? "")}.${fn ?? ""}`;
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
  const { modules, tests, coverage, edges, unmeasured, testOnlyDirs } = report;
  const cases = tests.reduce((n, t) => n + t.cases.length, 0);
  // Two different questions, and every sentence below turns on one or the other.
  //
  // `anyTestOnly` is whether an area was **declared** unmeasured; `titlesOnly` is what was
  // **found** in those areas. They are kept apart because they differ in exactly the case that
  // matters most: a declared directory holding no test file is unmeasured *and* untested, and an
  // earlier draft of this gated every sentence on the files found — which in that one case
  // restored the whole silence #123 is about, with "every function ran" as the last line a
  // reviewer reads. So scope is said whenever an area was declared, and counts only where there
  // is something to count.
  const titlesOnly = tests.filter((t) => inTestOnly(t.path, testOnlyDirs));
  const titlesOnlyCases = titlesOnly.reduce((n, t) => n + t.cases.length, 0);
  const anyTestOnly = testOnlyDirs.length > 0;
  // Singular or plural of the directory list, which is the subject of each of those sentences.
  const one = testOnlyDirs.length === 1;
  const they = one ? "it" : "they";
  const isAre = one ? "is" : "are";
  // What the report does hold about those areas, in the one phrase four sentences want. An area
  // with no test file at all gets the blunt version rather than "0 test titles in 0 files".
  const whatItHas = titlesOnly.length
    ? `**${titlesOnlyCases} test titles in ${titlesOnly.length} files**`
    : "**no test file at all**";
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
  // Named in the summary rather than only inside the fold, because it qualifies every number
  // under it: the tests counted above are not all the tests this report can say anything about.
  if (anyTestOnly) {
    out.push(
      titlesOnly.length
        ? `| Of those, titles only | ${titlesOnlyCases} in ${titlesOnly.length} files under ` +
            `${dirList(testOnlyDirs)} — no graph, no coverage |`
        : `| Titles only | ${dirList(testOnlyDirs)} — no test file, no graph, no coverage |`,
    );
  }
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

  // The scope of everything else, stated where the numbers are read rather than left to be
  // worked out from which paths happen to appear. This is the sentence #123 asked for: the
  // report is told to be read *before* the diff, so its silence about an area is read as a
  // statement about that area, and it was making one that was not true.
  if (anyTestOnly) {
    out.push(
      `Both graphs, the exported types and every coverage number here describe the workspaces ` +
        `counted above. ${dirList(testOnlyDirs)} ${isAre} in neither graph, in no exported-type ` +
        `list and in no coverage row: a module graph of the tooling says nothing about the app, ` +
        `and \`vitest.config.ts\` leaves it out of coverage deliberately. What ${they} ` +
        `${one ? "does" : "do"} have is ${whatItHas}${titlesOnly.length ? ", listed below and marked where they appear" : ""}` +
        ` — so read nothing here as a claim about ${dirList(testOnlyDirs)} that this report did ` +
        `not measure. ${one ? "It is" : "They are"} not measured, which is a different thing ` +
        `from being empty.`,
    );
    out.push("");
  }

  const drawn = drawnEdges(modules);
  const erased = drawn.filter((d) => d.kind.erasable).length;
  // Counted apart from the erased ones, never folded in with them: an import written
  // `import { type X }` carries only types and still leaves `import {} from "…"` in the
  // output, which is the difference `tools/pr-review/layering.ts` fails a narrowed edge
  // over. A summary that added the two together would make the same claim the arrow used
  // to make, one level up and read even sooner.
  const kept = drawn.filter((d) => d.kind.typeOnly && !d.kind.erasable).length;
  // Both counts are named in the summary rather than left inside, so a reviewer deciding
  // whether to open the fold already knows whether any edge is only a shape — and whether
  // any edge only looks like one.
  //
  // The arrows that leave their workspace get a count of their own beside them, because
  // those few are the architecture: `web → server → app → core`, the chain
  // `docs/design.md` draws and `tools/pr-review/layering.ts` enforces. It is the one number
  // here that answers a question about the shape of the project rather than about one
  // file's imports, and naming it outside the fold is what a separate workspace-level
  // diagram would otherwise have been for. Counted by where an arrow **lands**, not by how
  // it was written, so a relative import that reaches into another workspace counts too —
  // there is none today and the label should not quietly stop being true if one appears.
  const crossing = drawn.filter((d) => d.fromWorkspace !== d.toWorkspace).length;
  const boxed = drawn.some((d) => d.box);
  const size =
    `${modules.length} modules, ${drawn.length} imports` +
    (crossing ? `, ${crossing} into another workspace` : "") +
    (erased ? `, ${erased} erased` : "") +
    (kept ? `, ${kept} type-only but not erased` : "");
  out.push(
    ...fold(title("How the modules depend on each other", size), [
      // Each line is worth saying only when the graph contains the thing it explains. A
      // graph of solid arrows explains itself, and a graph with no arrows at all has
      // nothing to explain.
      ...(boxed
        ? [
            "An arrow that ends at a **workspace box** is an import written as a package " +
              "name — `@biu-cs-planner/core` — which names a package and not a file, so there " +
              "is no module for it to point at. `tools/pr-review/layering.ts` judges these " +
              "edges, and others this graph does not hold: a cross-workspace import written " +
              "as a relative path lands on a module rather than a box, and a test file's " +
              "relative imports are judged without being drawn here at all.",
            "",
          ]
        : []),
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

  const refs = new Set(edges.flatMap((e) => [e.from, e.to]));
  const calls = new Set(edges.map((e) => `${e.from}->${e.to}`)).size;
  // Counted outside the fold for the same reason the crossing arrows are: it is the one
  // number here that says how much of this graph is not known rather than how big it is, and
  // a reviewer deciding whether to open the fold should not have to open it to learn that.
  //
  // Counted apart from the functions, too, because an unresolved node is not one: it stands
  // for a callee whose module could not be found, and adding it to a count of functions would
  // be the summary making the same kind of confident claim the graph itself used to make.
  const unresolved = [...refs].filter((ref) => ref.startsWith(`${UNRESOLVED}#`)).length;
  const functions = refs.size - unresolved;
  out.push(
    ...fold(
      title(
        "How a value flows through the functions",
        `${functions} functions, ${calls} calls` + (unresolved ? `, ${unresolved} unresolved` : ""),
      ),
      [
        "Calls between the project's own functions, each resolved through the calling " +
          "module's own imports — so a name two modules both export is not confused for " +
          "itself. Library calls are left out, and so is a call that does not leave the " +
          "module it is written in.",
        "",
        ...(unresolved
          ? [
              "A node marked **unresolved** is a call to something this repository owns whose " +
                "module could not be found — a name imported from a barrel that no longer " +
                "re-exports it, say, or from a workspace with no package entry to reach it by. " +
                "`tools/pr-report/calls.ts` lists the ways one can arise. It is drawn rather " +
                "than dropped: an arrow missing from this graph reads as \"nothing is here\", " +
                "which is a claim, and a wrong one.",
              "",
            ]
          : []),
        "```mermaid",
        logicFlow(edges),
        "```",
        "",
      ],
    ),
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
  if (anyTestOnly) {
    // The fold a reviewer of *this* very change opens, and the one the first draft of #123's fix
    // forgot: `shapes` is built from `modules`, so a type exported from a titles-only directory
    // is absent exactly like a type that does not exist. `Report` itself is such a type, so the
    // change that added this line would have been invisible in its own report.
    shapes.push(
      `Types exported from ${dirList(testOnlyDirs)} are not here. Nothing read ` +
        `${one ? "that directory" : "those directories"} for exported shapes, so this list says ` +
        `nothing about ${they} either way.`,
    );
    shapes.push("");
  }
  out.push(...fold(title("The shapes the data takes", `${typeCount} exported types`), shapes));

  const claims: string[] = [];
  claims.push("Test titles, verbatim. This is the specification the change is held to.");
  claims.push("");
  if (titlesOnly.length) {
    claims.push(
      `A file marked **titles only** is one from ${dirList(testOnlyDirs)}: its titles are read ` +
        `from the source like every other file's, and the graphs and the coverage table above ` +
        `describe it not at all. The titles are the whole of what this report knows about it, ` +
        `which is more than the nothing it used to say (#123).`,
    );
    claims.push("");
  }
  for (const file of tests) {
    if (!file.cases.length) continue;
    // Marked on the file rather than gathered into a section of their own, because this is
    // where a reviewer of a `tools/` change arrives looking for its file by name, and a
    // heading elsewhere is a thing to be scrolled past instead of read.
    const only = inTestOnly(file.path, testOnlyDirs)
      ? " — **titles only**, not graphed or measured"
      : "";
    claims.push(`**${file.path}** — ${file.cases.length} tests${only}`);
    claims.push("");
    for (const c of file.cases) {
      claims.push(`- ${c.suite.length ? `*${c.suite.join(" › ")}* — ` : ""}${c.title}`);
    }
    claims.push("");
  }
  out.push(
    ...fold(
      title(
        "What the tests claim the code does",
        `${cases} tests in ${tests.length} files` +
          (titlesOnly.length ? `, ${titlesOnlyCases} of them titles only` : ""),
      ),
      claims,
    ),
  );

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
  if (anyTestOnly) {
    // Inside this fold as well as above it: a reader who opens only this one and scans for a
    // path would otherwise take the absence of a row for a row of zeroes.
    byFile.push(
      `No row is missing here because it is uncovered. ${dirList(testOnlyDirs)} ` +
        `${one ? "has" : "have"} none because ${they} ${isAre} outside ` +
        `\`vitest.config.ts\`'s coverage \`include\`, which is deliberate.`,
    );
    byFile.push("");
  }
  out.push(...fold(title("Coverage, file by file", `${rows.length} modules`), byFile));

  // Open, and last. It is the only section that says where to spend attention, and folding
  // it would hide the one part of this report written to be read rather than consulted.
  out.push("### Where to look, if you look anywhere");
  out.push("");
  const weak = rows.filter(([, c]) => c.branches < 85);
  const dead = coverage.deadFunctions;

  if (!weak.length && !dead.length && !unmeasured.length) {
    // "Every function ran" is true of the functions that were measured, and the sentence has to
    // say which those are when some of the repository is not among them — otherwise the one line
    // here written to be read is the one that makes the claim #123 is about.
    out.push(
      anyTestOnly
        ? "Nothing stands out among the modules measured: every function of them ran, and no " +
            "file is below 85% branch coverage."
        : "Nothing stands out: every function ran, and no file is below 85% branch coverage.",
    );
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
  // Kept out of the list above, which is for modules that *should* have been measured and were
  // not. This is the other kind — not measured by choice — and running the two together would
  // turn a decision into a finding and a finding into noise.
  if (anyTestOnly) {
    out.push(
      `Nothing above says anything about ${dirList(testOnlyDirs)}, in either direction: no ` +
        `coverage number, no graph and no exported type covers ${they}. What ${they} ` +
        `${one ? "has" : "have"} is ${whatItHas}` +
        `${titlesOnly.length ? ", in the fold above, each marked *titles only*" : ""} — ` +
        `read ${titlesOnly.length ? "those, and " : ""}the diff, which for ` +
        `${dirList(testOnlyDirs)} this report does not replace.`,
    );
    out.push("");
  }
  out.push(
    "> Coverage says a line ran, never that it is right. A high number with vague test " +
      "titles is worth less than a lower one whose titles above read like the behaviour you wanted.",
  );

  return out.join("\n");
}
