import { UNRESOLVED, type CallEdge } from "./calls.ts";
import type { Coverage, TestRun } from "./coverage.ts";
import type { ImportKind, Module } from "./surface.ts";
import { mergeImports, moduleName, packageWorkspace } from "./surface.ts";
import { totalTests, type TestFile, type TestTotals } from "./tests.ts";

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
  /**
   * What a real test run collected, where one left its count behind — the other half of the
   * claim this report opens with.
   *
   * Optional, and filled by `main.ts` rather than by `collect`, because the two readers have
   * different customers. `collect` is shared with `tools/pr-review`, which wants the graphs and
   * pays for no test run at all; the count of what a run collected is only ever wanted by the
   * page a reviewer reads. Where it is absent the report says the source's count is unchecked,
   * which is the honest reading of a missing file and not a reason to go quiet.
   */
  run?: TestRun;
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
 * A count, or a floor where a table's rows could not be read from the source.
 *
 * Every place the report prints a number of tests goes through this, so there is no spelling of
 * the total that can leave the caveat off. That was the shape of #140: one number, printed in
 * four places, meaning something narrower than its label in all four.
 */
const countOf = (totals: TestTotals): string =>
  totals.atLeast ? `at least ${totals.tests}` : `${totals.tests}`;

/** A number of tests, singular where it is one: "1 test", "80 tests", "at least 2 tests". */
const testsOf = (totals: TestTotals): string =>
  `${countOf(totals)} ${totals.tests === 1 && !totals.atLeast ? "test" : "tests"}`;

/** The same, for a plain number that did not come from the source. */
const nTests = (n: number): string => `${n} ${n === 1 ? "test" : "tests"}`;

/**
 * The source's count set against a real run's, file by file.
 *
 * The report opens by claiming two sources — "derived from the source and from a real test
 * run" — and until #140 the test count came from one of them, silently. Two readings of the
 * same thing that can disagree are worth more than either alone: the source count is right
 * today and is a parser that will meet a table it cannot read, and this is what notices.
 *
 * **Per file, and scoped by which files the run ran.** The run behind this report is the
 * coverage run, which is the node project alone, so its total is *smaller than the suite* by the
 * browser project. Comparing the two totals would therefore report a disagreement on every
 * tree and mean nothing. Compared file by file, the files the run did not run are named as
 * unchecked and the files it did run are checked exactly — which is the difference between
 * saying which run and presenting one run's number as another's.
 */
/**
 * Whether a run's count for one file confirms the source's.
 *
 * One predicate, asked by the summary row and by the mark on the file, because those two were
 * written separately and disagreed: a floor of 1 that a run answered with 9 got "agrees on
 * every one" at the top of the page and a bold contradiction of it two folds down. A floor the
 * run **exceeds** is the floor doing its job — the source said "at least this many" and the run
 * found more. A run **below** a floor is the report wrong about a file.
 */
const confirms = (totals: TestTotals, collected: number): boolean =>
  totals.atLeast ? collected >= totals.tests : collected === totals.tests;

type RunCheck = {
  /** Whether a run left a count that this report can be checked against at all. */
  available: boolean;
  /** Files the run ran that this report lists too, and the tests it collected in them. */
  ran: { files: number; tests: number };
  /** Files this report lists that the run did not run, and what the source counts in them. */
  unrun: { files: number; tests: number };
  /** Files where the two readings differ, each with both numbers. */
  disagree: Array<{ path: string; source: string; run: number }>;
  /** Test files the run ran that this report lists nowhere — a hole in its own walk. */
  unlisted: string[];
  /**
   * What was found for each file this report lists: the source's totals, and what the run
   * collected where it ran that file.
   *
   * Carried rather than recomputed. The per-file mark used to derive its own answer from
   * `totalTests` and its own comparison, which is how it came to contradict the row above it.
   */
  byFile: Map<string, { totals: TestTotals; collected: number | undefined }>;
};

function runCheck(tests: readonly TestFile[], run: TestRun | undefined): RunCheck {
  const byFile = new Map<string, { totals: TestTotals; collected: number | undefined }>();
  for (const file of tests) {
    byFile.set(file.path, { totals: totalTests([file]), collected: run?.byFile.get(file.path) });
  }

  const empty = { files: 0, tests: 0 };
  if (!run?.available) {
    return { available: false, ran: empty, unrun: empty, disagree: [], unlisted: [], byFile };
  }

  const ran = { files: 0, tests: 0 };
  const unrun = { files: 0, tests: 0 };
  const disagree: RunCheck["disagree"] = [];
  for (const [path, { totals, collected }] of byFile) {
    if (collected === undefined) {
      unrun.files += 1;
      unrun.tests += totals.tests;
      continue;
    }
    ran.files += 1;
    ran.tests += collected;
    if (!confirms(totals, collected)) {
      disagree.push({ path, source: countOf(totals), run: collected });
    }
  }

  const listed = new Set(tests.map((t) => t.path));
  const unlisted = [...run.byFile.keys()].filter((path) => !listed.has(path)).sort();

  // A run that overlaps **none** of the files listed here checks nothing, and saying it "agrees
  // on every one" of zero files is agreement asserted from no evidence — in the row read first,
  // which is the defect this whole section exists to remove. It happens when the file is left
  // over from another tree or another root, so the paths do not match: `unlisted` then names
  // what it did run, and `available` is false because nothing here was checked.
  return { available: ran.files > 0, ran, unrun, disagree, unlisted, byFile };
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
  const { modules, tests, coverage, edges, unmeasured, testOnlyDirs, run } = report;
  // Tests, and not entries. `tests.reduce((n, t) => n + t.cases.length, 0)` was what stood here,
  // and it counts the `it` and `describe` calls the parser recovered: a parameterised suite is
  // one entry and many tests, so on the tree this changed the number was 1097 where `npm test`
  // ran 1190 (#140). `totalTests` sums what each entry runs and says how much of the sum is a
  // floor, and every number of tests below comes from it.
  const totals = totalTests(tests);
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
  const titlesOnlyTotals = totalTests(titlesOnly);
  const anyTestOnly = testOnlyDirs.length > 0;
  // Singular or plural of the directory list, which is the subject of each of those sentences.
  const one = testOnlyDirs.length === 1;
  const they = one ? "it" : "they";
  const isAre = one ? "is" : "are";
  // What the report does hold about those areas, in the one phrase four sentences want. An area
  // with no test file at all gets the blunt version rather than "0 test titles in 0 files".
  const whatItHas = titlesOnly.length
    ? `**${countOf(titlesOnlyTotals)} tests in ${titlesOnly.length} files, their titles and ` +
      "nothing more**"
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
  // Labelled with where it comes from, because that is the whole of what went wrong: a row
  // called `Tests` under a sentence promising a real test run read as the number the run ran,
  // and was the number a parser recovered. It is now the number of tests, said to be counted
  // from the source, and the row under it is what a run says about the same question.
  out.push(`| Tests | ${countOf(totals)} in ${tests.length} files, counted from the source |`);
  if (totals.atLeast) {
    out.push(
      // Not "counts for one test": an entry whose own table went unread still multiplies by
      // every table around it that did not, so inside a readable `describe.each` it counts for
      // one row and several tests. The row a table is counted as is the fact; the tests it comes
      // to are not.
      `| Tables not fixed by the source | ${totals.atLeast} parameterised ` +
        `${totals.atLeast === 1 ? "suite is" : "suites are"} counted as one row each, because ` +
        `${totals.atLeast === 1 ? "its table" : "their tables"} could not be read — so the ` +
        `count above is a floor |`,
    );
  }
  const checked = runCheck(tests, run);
  // Named in the summary rather than only inside the fold, because it qualifies every number
  // under it: the tests counted above are not all the tests this report can say anything about.
  //
  // Kept directly under `Tests`, and the cross-check row below it, because "Of those" has to
  // have `Tests` as the thing it is of. An earlier arrangement put the run between them and
  // left "Of those" pointing at a number about a different question.
  if (anyTestOnly) {
    out.push(
      titlesOnly.length
        ? `| Of those, titles only | ${countOf(titlesOnlyTotals)} in ${titlesOnly.length} ` +
            `files under ${dirList(testOnlyDirs)} — no graph, no coverage |`
        : `| Titles only | ${dirList(testOnlyDirs)} — no test file, no graph, no coverage |`,
    );
  }
  // Worded without "of them" for the same reason: this row is read wherever it sits, and a
  // pronoun in it would bind to whichever number the table happens to put above it.
  out.push(
    !checked.available
      ? checked.unlisted.length
        ? "| A run to check it against | a run left a count, but it ran none of the files " +
          "listed here — see below |"
        : "| A run to check it against | none — no test run left its own count beside this report |"
      : checked.disagree.length
        ? `| A run to check it against | **it disagrees on ${checked.disagree.length} ` +
            `${checked.disagree.length === 1 ? "file" : "files"}** — named below |`
        : `| A run to check it against | ${nTests(checked.ran.tests)} across the ` +
            `${checked.ran.files} ${checked.ran.files === 1 ? "file" : "files"} it ran, and it ` +
            `agrees on every one |`,
  );
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

  // Which run, said in the report rather than left for a reader to assume. The run behind this
  // report is the coverage run and the coverage run is the node project, so its total is
  // smaller than the suite's by the browser project. Naming that is the difference between a
  // cross-check and a second misleading number: a node-only count printed beside a whole-tree
  // count, with nothing saying which was which, would replace #140's defect rather than fix it.
  if (!checked.available) {
    out.push(
      checked.unlisted.length
        ? "**Nothing here was checked.** A test run did leave a count beside this report, but " +
            "not one of the files it ran is a file this report lists, so it confirms nothing " +
            "above. That happens when the count is left over from another tree or another " +
            "root — the paths then match nothing. What it did run is named below, and the " +
            "number above is the source's alone."
        : "**Nothing checks the count above.** No test run left its own count beside this " +
            "report, so the number is the source's alone — read as what a parser recovered, " +
            "not as what a run collected. `npm run coverage` leaves that count behind, so this " +
            "line means the report was built some other way.",
    );
    out.push("");
  } else {
    out.push(
      `**Which run.** The count above is read from the source; the run it is set against is ` +
        // Only where there is coverage to point at. Without it the row above says so, and this
        // sentence would be naming a section that is not there.
        (coverage.available
          ? "the one that produced the coverage below"
          : "the one beside this report") +
        `, and that run is **not the whole suite**. It ran ${checked.ran.files} of the ` +
        `${tests.length} files here and collected ${nTests(checked.ran.tests)} in them` +
        (checked.disagree.length
          ? `, and it does not agree with the source about all of them.`
          : `, agreeing with the source on every one.`) +
        (checked.unrun.files
          ? ` The other ${checked.unrun.files} ` +
            `${checked.unrun.files === 1 ? "file was" : "files were"} not in it: ` +
            `${nTests(checked.unrun.tests)} that only the source counts, marked where they are ` +
            `listed below.`
          : "") +
        ` The two numbers answer different questions and neither is the other — ` +
        `${countOf(totals)} is what the source accounts for across every file, ` +
        `${checked.ran.tests} is what that one run collected.`,
    );
    out.push("");
  }
  if (checked.disagree.length) {
    out.push(
      "**Where they disagree.** The source is read by `tools/pr-report/tests.ts` and the run " +
        "by vitest. A difference is a file this report is wrong about, and it is named rather " +
        "than resolved in favour of either:",
    );
    out.push("");
    for (const d of checked.disagree) {
      out.push(`- \`${d.path}\` — the source counts ${d.source}, the run collected ${d.run}`);
    }
    out.push("");
  }
  if (checked.unlisted.length) {
    out.push(
      "**The run found tests in files this report does not list.** That is a gap in this " +
        "report's own walk of the tree, which is the defect #123 was about, and it is here so " +
        "that it cannot pass unnoticed:",
    );
    out.push("");
    for (const path of checked.unlisted) out.push(`- \`${path}\``);
    out.push("");
  }

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
    // The same reason the mark above is per file: whether a run confirmed this file's count is
    // a fact about this file, and a reader who arrives here by name would otherwise have to
    // carry the scope sentence from the top of the report in their head to know.
    // Taken from `runCheck` rather than recomputed here. Deriving it twice is how this line
    // came to bold a contradiction of the row that called the same file agreement: `confirms`
    // treats a floor the run exceeds as confirmed, and a second comparison written here did not.
    const found = checked.byFile.get(file.path);
    const fileTotals = found?.totals ?? totalTests([file]);
    const collected = checked.available ? found?.collected : undefined;
    const confirmed =
      collected === undefined
        ? checked.available
          ? " — not in the run this report was built beside"
          : ""
        : confirms(fileTotals, collected)
          ? // Worth printing where the source only claimed a floor: the run says which number it
            // is, and that is information rather than a disagreement. Unbolded, because bold here
            // is the mark for the report being wrong about a file.
            fileTotals.atLeast
            ? ` — the run found ${collected}`
            : ""
          : ` — **the run collected ${collected}**`;
    claims.push(`**${file.path}** — ${testsOf(fileTotals)}${confirmed}${only}`);
    claims.push("");
    for (const c of file.cases) {
      // An entry is a title and a count, and the count is not always one. Said on the entry
      // because a list of 1118 titles under a total of 1190 invites exactly the arithmetic
      // that produced #140: a reader counting the bullets and taking that for the tests.
      const rows = c.atLeast
        ? ` — parameterised by a table this report could not read, so **at least ${c.tests}**`
        : c.tests === 1
          ? ""
          : ` — **${c.tests} cases**, one per row of its table`;
      claims.push(`- ${c.suite.length ? `*${c.suite.join(" › ")}* — ` : ""}${c.title}${rows}`);
    }
    claims.push("");
  }
  out.push(
    ...fold(
      title(
        "What the tests claim the code does",
        `${countOf(totals)} tests in ${tests.length} files` +
          (titlesOnly.length ? `, ${countOf(titlesOnlyTotals)} of them titles only` : ""),
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
