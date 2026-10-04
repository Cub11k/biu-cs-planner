import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOLLOWER_HOME,
  explainFollower,
  readSources,
  reExportFollowers,
  strayFollowers,
  type Source,
} from "./followers.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * One module in this repository follows a re-export chain, and this is what says so.
 *
 * #124 shipped the rule as a canary in `tools/pr-report/surface.test.ts`: five hard-coded
 * filenames read and searched for the literal string `declaringModule`. What it caught was the
 * walk being copied back into one of those five files. What it missed — and #203 is the ticket
 * that says so, filed by the agent that wrote it — was a second follower in a sixth file, one
 * under any other name, and one reached through a different spelling, which is the whole of
 * what the rule is about.
 *
 * So the tests below are about the *rule* and not about an identifier. Every fixture names its
 * functions something other than `declaringModule`, deliberately: if renaming the real one
 * retired this check, nothing here would pass.
 */

/** A fixture tree, as sources rather than as files, since the rule is about text. */
const sources = (files: Record<string, string>): Source[] =>
  Object.entries(files).map(([path, text]) => ({ path, text }));

/** `path#name` for every follower found, which is all these assertions need. */
const followers = (files: Record<string, string>): string[] =>
  reExportFollowers(sources(files)).map((f) => `${f.path}#${f.name}`);

const lines = (...text: string[]): string => text.join("\n");

/** A walk written as a recursive function, the way `declaringModule` happens to be. */
const RECURSIVE = lines(
  "export function whereDeclared(ref, named, origins, seen) {",
  "  const names = origins.modules.get(ref);",
  "  if (!names || !names.has(named)) return undefined;",
  "  const origin = names.get(named);",
  "  if (origin === null) return { path: ref, name: named };",
  "  return whereDeclared(origin.specifier, origin.name, origins, seen);",
  "}",
);

/** The same walk written as a loop, which recursion is not the only way to spell. */
const LOOPING = lines(
  "export const trace = (ref, named, origins) => {",
  "  let at = { specifier: ref, name: named };",
  "  while (true) {",
  "    const names = origins.modules.get(at.specifier);",
  "    const origin = names?.get(at.name);",
  "    if (!origin) return at;",
  "    at = { specifier: origin.specifier, name: origin.name };",
  "  }",
  "};",
);

describe("a second module that follows a re-export chain", () => {
  it("is seen in a file no list names", () => {
    // The assertion the five-filename canary could not make. `app/src/barrels.ts` is in no
    // list anywhere, in no directory the report's own `collect` walks, and under no name the
    // old grep searched for.
    expect(followers({ "app/src/barrels.ts": RECURSIVE })).toEqual([
      "app/src/barrels.ts#whereDeclared",
    ]);
  });

  it("is seen in `tools/`, which `collect` cannot read at all", () => {
    // `collect` walks `SOURCE_DIRS` — the four workspaces — so the other three mechanical
    // checks are blind to the directory the walk and every plausible copy of it live in. This
    // check reads the tree itself, which is what makes "anywhere" true.
    expect(followers({ "tools/pr-review/second.ts": LOOPING })).toEqual([
      "tools/pr-review/second.ts#trace",
    ]);
  });

  it("is seen whether it recurses or loops, because a chain is followed by repeating", () => {
    expect(followers({ "a.ts": RECURSIVE, "b.ts": LOOPING })).toEqual([
      "a.ts#whereDeclared",
      "b.ts#trace",
    ]);
  });

  it("survives the real function being renamed, because no name is searched for", () => {
    // Every fixture above calls its walk something else and is found anyway. Said once as its
    // own assertion: the literal `declaringModule` appears nowhere in the rule.
    const underAnyName = lines(
      "export function x(r, n, o) {",
      "  const step = o.modules.get(r)?.get(n);",
      "  return step ? x(step.specifier, step.name, o) : r;",
      "}",
    );

    expect(followers({ "core/src/x.ts": underAnyName })).toEqual(["core/src/x.ts#x"]);
  });

  it("is seen however the function itself is spelled", () => {
    // The four shapes a reviewer of #203 showed the first draft was blind to. Each is a full
    // walk — it reads the origin's two halves and advances — and each was written a way the
    // draft's `named` did not recognise, so a second walk parked as a method on a resolver
    // class was invisible while the rule claimed "anywhere else is a finding".
    const method = lines(
      "export class Barrels {",
      "  whereDeclared(ref, named, origins) {",
      "    const step = origins.modules.get(ref)?.get(named);",
      // Through a receiver, which is how a method reaches itself.
      "    return step ? this.whereDeclared(step.specifier, step.name, origins) : ref;",
      "  }",
      "}",
    );
    const objectLiteral = lines(
      "export const walk = {",
      "  trace(at, origins) {",
      "    for (;;) {",
      "      const step = origins.modules.get(at.specifier)?.get(at.name);",
      "      if (!step) return at;",
      "      at = { specifier: step.specifier, name: step.name };",
      "    }",
      "  },",
      "};",
    );
    const anonymousDefault = lines(
      "export default function (at, origins) {",
      "  for (;;) {",
      "    const step = origins.modules.get(at.specifier)?.get(at.name);",
      "    if (!step) return at;",
      "    at = { specifier: step.specifier, name: step.name };",
      "  }",
      "}",
    );
    const namedExpression = lines(
      "exports.trace = function go(ref, named, origins) {",
      "  const step = origins.modules.get(ref)?.get(named);",
      "  return step ? go(step.specifier, step.name, origins) : ref;",
      "};",
    );

    expect(
      followers({
        "app/src/method.ts": method,
        "app/src/object.ts": objectLiteral,
        "app/src/default.ts": anonymousDefault,
        "app/src/expression.ts": namedExpression,
      }),
    ).toEqual([
      "app/src/method.ts#whereDeclared",
      "app/src/object.ts#trace",
      // An anonymous default is reported under the name it is imported by.
      "app/src/default.ts#default",
      "app/src/expression.ts#go",
    ]);
  });

  it("is a finding, where a follower at home is not", () => {
    // The rule is one module, so the walk's own module is quiet however many functions in it
    // read a chain — `resolveReExports` iterates over the same pair beside `declaringModule`
    // and is that walk's caller rather than a second walk.
    const both = sources({ [FOLLOWER_HOME]: RECURSIVE, "server/src/barrels.ts": LOOPING });

    expect(reExportFollowers(both)).toHaveLength(2);
    expect(strayFollowers(both).map((f) => f.path)).toEqual(["server/src/barrels.ts"]);
  });

  it("says, in the finding, why there is only one of them", () => {
    const [stray] = strayFollowers(sources({ "server/src/barrels.ts": LOOPING }));

    expect(stray).toBeDefined();
    expect(explainFollower(stray!)).toContain("server/src/barrels.ts");
    expect(explainFollower(stray!)).toContain("trace");
    expect(explainFollower(stray!)).toContain(FOLLOWER_HOME);
    // The constraint itself, which is the part a reader needs and cannot derive: #124 moved
    // the walk out of `calls.ts` because that file already imports `surface.ts`.
    expect(explainFollower(stray!)).toContain("cycle");
  });
});

describe("what following a chain is not", () => {
  it("is not reading a specifier, which most of this repository does", () => {
    // `forbiddenEdges` reads `ref.specifier` for every import in the graph, in a loop, and
    // follows nothing. One half of the pair is too weak a signal — which is #86's finding
    // about keys, met again as a question about syntax.
    const everyImport = lines(
      "export function edges(modules) {",
      "  const out = [];",
      "  for (const m of modules) {",
      "    for (const ref of m.imports) out.push(ref.specifier);",
      "  }",
      "  return out;",
      "}",
    );

    expect(followers({ "tools/pr-review/edges.ts": everyImport })).toEqual([]);
  });

  it("is not resolving one step, which is what a module's own reader does", () => {
    // Reads both halves and stops. `readModule` does exactly this, one file at a time, and the
    // reason there is a second pass at all is that one step is not a chain.
    const oneStep = lines(
      "export function origin(clause, names) {",
      "  const binding = names.get(clause.name);",
      "  return { specifier: clause.specifier, name: binding ?? clause.name };",
      "}",
    );

    expect(followers({ "tools/pr-report/one.ts": oneStep })).toEqual([]);
  });

  it("is not any old recursion", () => {
    const walkTree = lines(
      "export function walk(dir) {",
      "  const out = [];",
      "  for (const entry of read(dir)) out.push(...walk(entry));",
      "  return out;",
      "}",
    );

    expect(followers({ "tools/pr-report/walk.ts": walkTree })).toEqual([]);
  });
});

describe("this repository", () => {
  it("keeps the re-export walk in one module, over the whole tree", () => {
    // The rule, against the tree rather than against a fixture. `strayFollowers` empty is the
    // clean state, exactly as `forbiddenEdges` returning `[]` is; a second follower written
    // anywhere under this root fails here and nowhere else.
    //
    // **No name is asserted.** A draft of this ended with
    // `expect(found.map((f) => f.name)).toContain("declaringModule")`, and a reviewer of #203
    // renamed the real walk to check the criterion: the two assertions below passed, and that
    // third one failed — a red suite at an identifier, in the file whose whole subject is that
    // no identifier is searched for. The two lines that remain are the rule, and they are
    // indifferent to what the walk is called.
    const sources = readSources(ROOT);
    const found = reExportFollowers(sources);

    expect(strayFollowers(sources)).toEqual([]);
    expect(new Set(found.map((f) => f.path))).toEqual(new Set([FOLLOWER_HOME]));
    expect(found.length).toBeGreaterThan(0);
    // A budget rather than the default five seconds, because this reads and parses every
    // source file in the repository and pays for the TypeScript compiler's first load. Under
    // `npm run coverage`, which instruments all of that, it was measured at 4157ms on a CI
    // runner (#223's report job) and 4819ms here — passing with 3% of the budget to spare, and
    // only while no other worker was busy. #211 added a test file that runs a real Vite build
    // and an `npm pack`, and this one went over. The assertions above are unchanged; what was
    // wrong was a default timeout standing in for a measurement nobody had taken.
    //
    // **Why the three whole-tree tests each call `readSources` rather than share one read in a
    // `beforeAll`** (#256, measured 2026-10-04 on a tree of 163 `.ts` and `.tsx` files). The read is not
    // what costs: `readSources(ROOT)` took 12–15ms cold and 4ms warm in a plain node process,
    // and 5–11ms inside the suite. The parse does — `reExportFollowers` at 225ms cold and
    // 115–150ms warm, `strayFollowers` (which parses again) at 115–130ms. Inside vitest this
    // test ran 645–940ms on its own and 1163–1492ms in the full suite; with coverage,
    // 2300–3064ms on its own and 4641–4889ms in the full suite, and the next one 1249–1424ms.
    // Hoisting the read would save about 30ms of that and nothing of the cold parse, which is
    // what sits near five seconds, so no budget could come back down on the strength of it.
    // Sharing the *parse* would mean handing `strayFollowers` another call's result, which
    // changes what this test asserts. So the read stays per test and the budget stays.
  }, 30_000);

  it("over-reports inside the walk's own module, which is the direction it errs in", () => {
    // Three functions in `FOLLOWER_HOME` match and one walk exists: `readModule` reads an
    // origin's two halves off each export clause and loops over the statements, and calls
    // `declaringModule` nowhere. Asserted rather than left implicit, because the module claims
    // to over-report and a claim about a rule's failure direction should fail if it stops being
    // true. `strayFollowers` reports none of them, so the cost is paid by nobody today.
    const found = reExportFollowers(readSources(ROOT));

    expect(found.length).toBeGreaterThan(1);
    expect(found.every((f) => f.path === FOLLOWER_HOME)).toBe(true);
    // The same whole-tree walk, and so the same budget and the same reason as above. Given
    // one now rather than when it becomes the next to time out: it is cheaper than its
    // neighbour only because that one paid the compiler's first load, which is an ordering
    // this file does not control.
  }, 30_000);

  it("reads the whole tree and not a list of files", () => {
    // What makes the assertion above worth anything. Derived from the walk rather than listed
    // here, so a file added tomorrow is covered the day it is written — and the five-filename
    // canary this replaces looked at five.
    const paths = readSources(ROOT).map((s) => s.path);

    expect(paths.length).toBeGreaterThan(100);
    for (const dir of ["core/src/", "app/src/", "server/src/", "web/src/", "tools/"]) {
      expect(paths.some((p) => p.startsWith(dir))).toBe(true);
    }
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    // Whole tree, same budget, same reason.
  }, 30_000);

  it("finds a second follower written into the tree beside the first", () => {
    // The mutation as a test: a real file, written to a real root that holds the real walk,
    // and a check that was handed no list of filenames and no name to search for. The root is
    // a throwaway one rather than this repository, because a test that wrote into `tools/`
    // would leave a follower behind if it failed halfway.
    const root = mkdtempSync(join(tmpdir(), "followers-"));
    try {
      for (const [rel, text] of Object.entries({
        [FOLLOWER_HOME]: RECURSIVE,
        "web/src/timetable/later.ts": LOOPING,
      })) {
        const file = join(root, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text, "utf8");
      }

      expect(strayFollowers(readSources(root)).map((f) => `${f.path}#${f.name}`)).toEqual([
        "web/src/timetable/later.ts#trace",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
