import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCalls, UNRESOLVED, type CallTargets } from "./calls.ts";
import { collect } from "./collect.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Which function a call reaches is a question about the **calling module**, and these read it
 * the way the report does: whole fixture repositories written to a throwaway root, imports
 * and manifests included, put through `collect`.
 *
 * Nothing here is a hand-built edge list. The defect this file exists for (#86) was in the
 * step between the source and the edges — a repo-wide `Map<name, module>` that let whichever
 * module exported a name last answer for every call to it — so a test that started from
 * edges would have asserted the bug.
 */

/** One fixture repository, written out and read back as `collect` reads this one. */
function edgesOf(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "calls-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const file = join(root, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, "utf8");
    }
    return collect(root)
      .edges.map((e) => `${e.from} -> ${e.to}`)
      .sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A workspace manifest. `main` absent is `web`'s case: no `exports`, so nothing imports it. */
const manifest = (workspace: string, main?: string): string =>
  JSON.stringify({
    name: `@biu-cs-planner/${workspace}`,
    ...(main === undefined ? {} : { exports: { ".": main } }),
  });

const lines = (...text: string[]): string => text.join("\n");

/**
 * One module read against a table built by hand, which is the only way to vary the order the
 * table was filled in: `collect` sorts its modules by path, so through it the order is always
 * the alphabet's.
 */
function callsFrom(relPath: string, text: string, targets: CallTargets): string[] {
  const root = mkdtempSync(join(tmpdir(), "calls-"));
  try {
    const file = join(root, relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
    return readCalls(file, root, targets).map((e) => `${e.from} -> ${e.to}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The same function name exported by three workspaces, each with its own caller.
 *
 * This is the shape of the real defect: `groupKey` is `core/src/shoham/changes.ts`'s
 * `(number, lessonType)` and `web/src/timetable/week.ts`'s `(group)`, two correct names for
 * two different things. Three exporters rather than two on purpose — one global entry per
 * name can be right about at most one of them, whichever way the files are ordered, so there
 * is no reading order under which the old resolution passes this.
 */
const collision = (workspaces: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    workspaces.flatMap((w) => [
      [`${w}/package.json`, manifest(w, "./src/index.ts")],
      [
        `${w}/src/key.ts`,
        lines(`export function groupKey(of: string): string {`, `  return "${w}:" + of;`, `}`),
      ],
      [
        `${w}/src/use.ts`,
        lines(
          `import { groupKey } from "./key.ts";`,
          `export function keysOf(all: string[]): string[] {`,
          `  return all.map((one) => groupKey(one));`,
          `}`,
        ),
      ],
    ]),
  );

describe("two modules exporting the same name", () => {
  it("resolves each call to the copy the calling module imported", () => {
    // Three workspaces, three identical calls, three different answers. Read by a name
    // alone, all three land on one module — and which one is decided by nothing more than
    // the alphabet.
    expect(edgesOf(collision(["core", "app", "web"]))).toEqual([
      "app/src/use.ts#keysOf -> app/src/key.ts#groupKey",
      "core/src/use.ts#keysOf -> core/src/key.ts#groupKey",
      "web/src/use.ts#keysOf -> web/src/key.ts#groupKey",
    ]);
  });

  it("does not consult the other copies of the name at all", () => {
    // `collect` sorts by path, so `web` is always read after `core`, and the entry that
    // survived a last-writer-wins map was `web`'s. Dropping `web` out of the fixture changes
    // nothing about `core`'s or `app`'s answer, which is what says the other copies play no
    // part. (Read order itself is varied in the test below; this one varies the *set*.)
    const withWeb = edgesOf(collision(["core", "app", "web"]));
    const withoutWeb = edgesOf(collision(["core", "app"]));
    expect(withoutWeb).toEqual(withWeb.filter((edge) => !edge.startsWith("web/")));
  });

  it("answers the same whichever order the modules were read in", () => {
    // The criterion itself, and `collect` cannot test it: it sorts modules by path, so the
    // order is never anything but alphabetical. `readCalls` takes the table, and a table can be
    // built either way round — which is exactly what a last-writer-wins map was sensitive to.
    const exporters: Array<[string, ReadonlyMap<string, null>]> = [
      ["core/src/key.ts", new Map([["groupKey", null]])],
      ["web/src/key.ts", new Map([["groupKey", null]])],
    ];
    const caller = lines(
      `import { groupKey } from "./key.ts";`,
      `export function keysOf(all: string[]): string[] {`,
      `  return all.map((one) => groupKey(one));`,
      `}`,
    );
    const answers = [exporters, [...exporters].reverse()].map((order) =>
      callsFrom("core/src/use.ts", caller, {
        modules: new Map([...order, ["core/src/use.ts", new Map()]]),
        entries: new Map(),
        workspaces: new Set(["core", "web"]),
      }),
    );

    expect(answers[0]).toEqual(["core/src/use.ts#keysOf -> core/src/key.ts#groupKey"]);
    expect(answers[1]).toEqual(answers[0]);
  });

  it("draws no edge for a call to the module's own copy of the name", () => {
    // `core/src/shoham/changes.ts:92` calls the `groupKey` declared at line 42, in the same
    // file, and that was one of the three edges pointing at `web`. A call that does not leave
    // its module has never been in this graph — `tools/pr-review/cycles.ts` says so and
    // counts on it — so the honest answer here is no edge at all rather than a nearby one.
    //
    // This one passes because the name is bound by no import: there is nothing to resolve, and
    // `web`'s copy of it is not consulted. The guard against an edge that resolves *back* to
    // the module it started in is a different mechanism, and has its own test below.
    expect(
      edgesOf({
        "core/package.json": manifest("core", "./src/index.ts"),
        "core/src/key.ts": lines(
          `export function groupKey(of: string): string {`,
          `  return of;`,
          `}`,
          `export function keysOf(all: string[]): string[] {`,
          `  return all.map((one) => groupKey(one));`,
          `}`,
        ),
        "web/package.json": manifest("web"),
        "web/src/key.ts": lines(`export function groupKey(of: { id: string }): string {`, `  return of.id;`, `}`),
      }),
    ).toEqual([]);
  });

  it("draws no edge when following the import leads back to the calling module", () => {
    // The awkward case the test above does not reach: the name *is* imported, from a barrel,
    // and the barrel re-exports it from the very module doing the calling. Resolution comes
    // home, and a call that ends where it started still does not leave its module. Written
    // with an alias, which is the spelling that compiles — importing `groupKey` into the
    // module that declares `groupKey` is a duplicate identifier, and a fixture nobody
    // type-checks is no reason to write source nobody could.
    expect(
      edgesOf({
        "core/package.json": manifest("core", "./src/index.ts"),
        "core/src/index.ts": lines(`export { groupKey } from "./key.ts";`),
        "core/src/key.ts": lines(
          `import { groupKey as key } from "./index.ts";`,
          `export function groupKey(of: string): string {`,
          `  return of;`,
          `}`,
          `export function keysOf(all: string[]): string[] {`,
          `  return all.map((one) => key(one));`,
          `}`,
        ),
      }),
    ).toEqual([]);
  });
});

describe("where a call lands", () => {
  it("follows a barrel to the module that declares the function", () => {
    // `server/src/bin.ts` imports `createApi` from `./api.ts` while `./index.ts` re-exports
    // it, and the old map answered `index.ts` because `a` sorts before `i`. A barrel holds no
    // code, so an edge ending there ends the path a reader was following.
    expect(
      edgesOf({
        "server/package.json": manifest("server", "./src/index.ts"),
        "server/src/api.ts": lines(`export function createApi(): string {`, `  return "api";`, `}`),
        "server/src/index.ts": lines(`export { createApi } from "./api.ts";`),
        "server/src/bin.ts": lines(
          `import { createApi } from "./index.ts";`,
          `export function start(): string {`,
          `  return createApi();`,
          `}`,
        ),
      }),
    ).toEqual(["server/src/bin.ts#start -> server/src/api.ts#createApi"]);
  });

  it("resolves a call across a package boundary through that workspace's entry module", () => {
    // What `app` writes is `@biu-cs-planner/core`, which names a package and not a file. The
    // manifest says which file that is, so the edge reaches the declaration rather than
    // stopping at the boundary and cutting the path in two.
    expect(
      edgesOf({
        "core/package.json": manifest("core", "./src/index.ts"),
        "core/src/index.ts": lines(`export { parseCatalogFile } from "./catalog/file.ts";`),
        "core/src/catalog/file.ts": lines(
          `export function parseCatalogFile(input: unknown): unknown {`,
          `  return input;`,
          `}`,
        ),
        "app/package.json": manifest("app", "./src/index.ts"),
        "app/src/queries.ts": lines(
          `import { parseCatalogFile } from "@biu-cs-planner/core";`,
          `export function loadCatalog(text: string): unknown {`,
          `  return parseCatalogFile(text);`,
          `}`,
        ),
      }),
    ).toEqual(["app/src/queries.ts#loadCatalog -> core/src/catalog/file.ts#parseCatalogFile"]);
  });

  it("keeps the name the target knows a call by, not the caller's alias", () => {
    expect(
      edgesOf({
        "core/package.json": manifest("core", "./src/index.ts"),
        "core/src/key.ts": lines(`export function groupKey(of: string): string {`, `  return of;`, `}`),
        "core/src/use.ts": lines(
          `import { groupKey as key } from "./key.ts";`,
          `export function keysOf(all: string[]): string[] {`,
          `  return all.map((one) => key(one));`,
          `}`,
        ),
      }),
    ).toEqual(["core/src/use.ts#keysOf -> core/src/key.ts#groupKey"]);
  });

  it("follows a renaming re-export, which knows the name by its other one", () => {
    // `export { groupKey as key } from "./key.ts"` exports `key`, and `key.ts` has never heard
    // of `key`. Following the module alone would look for `key` there, find nothing, and draw
    // an unresolved node for a call that is perfectly resolvable — the same mistake as #86 one
    // step over, so the name travels beside the specifier.
    expect(
      edgesOf({
        "core/package.json": manifest("core", "./src/index.ts"),
        "core/src/key.ts": lines(`export function groupKey(of: string): string {`, `  return of;`, `}`),
        "core/src/index.ts": lines(`export { groupKey as key } from "./key.ts";`),
        "app/package.json": manifest("app", "./src/index.ts"),
        "app/src/use.ts": lines(
          `import { key } from "@biu-cs-planner/core";`,
          `export function keysOf(one: string): string {`,
          `  return key(one);`,
          `}`,
        ),
      }),
    ).toEqual(["app/src/use.ts#keysOf -> core/src/key.ts#groupKey"]);
  });

  it("does not take a name from an `import type` statement for a callee", () => {
    // The clause-level form, which erases whole. Its inline cousin is the test below; they are
    // separate guards in `importBindings` and a fixture using one says nothing about the other.
    expect(
      edgesOf({
        "core/package.json": manifest("core", "./src/index.ts"),
        "core/src/key.ts": lines(`export function groupKey(of: string): string {`, `  return of;`, `}`),
        "core/src/use.ts": lines(
          `import type { groupKey } from "./key.ts";`,
          `export function keysOf(all: string[]): string[] {`,
          `  return all.map((one) => groupKey(one));`,
          `}`,
        ),
      }),
    ).toEqual([]);
  });

  it("draws nothing for a call into a third-party package", () => {
    // "Library calls are left out" is what the report says, and a library is not this
    // repository's to resolve — so it is neither an edge nor an unresolved one.
    expect(
      edgesOf({
        "server/package.json": manifest("server", "./src/index.ts"),
        "server/src/serve.ts": lines(
          `import { serve } from "@hono/node-server";`,
          `export function start(): void {`,
          `  serve({ port: 1 });`,
          `}`,
        ),
      }),
    ).toEqual([]);
  });

  it("draws nothing for a scoped name that is no workspace this report walks", () => {
    // `@biu-cs-planner/tools` is this project's scope and not one of the four workspaces, so
    // there is no module for it and no box either. #83 ruled for the module graph that such a
    // name gets no arrow rather than an invented node; an unresolved node here would be the
    // same invention, permanently, for a dependency that is simply outside this graph.
    expect(
      edgesOf({
        "core/package.json": manifest("core", "./src/index.ts"),
        "core/src/use.ts": lines(
          `import { report } from "@biu-cs-planner/tools";`,
          `export function run(): void {`,
          `  report();`,
          `}`,
        ),
      }),
    ).toEqual([]);
  });

  it("does not take an inline type binding for a callee", () => {
    // A type cannot be called, so the name binds nothing here. The `groupKey` beside it in
    // the same clause still resolves, which is what says the clause was read rather than
    // skipped whole. (`Shape()` is not valid TypeScript; the point is that this reader never
    // has to decide what it would mean.)
    expect(
      edgesOf({
        "core/package.json": manifest("core", "./src/index.ts"),
        "core/src/key.ts": lines(
          `export type Shape = { id: string };`,
          `export function groupKey(of: string): string {`,
          `  return of;`,
          `}`,
        ),
        "core/src/use.ts": lines(
          `import { type Shape, groupKey } from "./key.ts";`,
          `export function keysOf(all: string[]): string[] {`,
          `  return [groupKey(all[0] ?? ""), String(Shape())];`,
          `}`,
        ),
      }),
    ).toEqual(["core/src/use.ts#keysOf -> core/src/key.ts#groupKey"]);
  });
});

describe("a call this repository owns and cannot place", () => {
  it("draws a node saying so when the module it was imported from does not export it", () => {
    // The barrel stopped re-exporting the name. Dropping the edge would say there is no call
    // here, which is the same kind of confident falsehood #86 was about, one direction over.
    expect(
      edgesOf({
        "server/package.json": manifest("server", "./src/index.ts"),
        "server/src/index.ts": lines(`export { launchToken } from "./token.ts";`),
        "server/src/token.ts": lines(`export function launchToken(): string {`, `  return "t";`, `}`),
        "server/src/bin.ts": lines(
          `import { createApi } from "./index.ts";`,
          `export function start(): string {`,
          `  return createApi();`,
          `}`,
        ),
      }),
    ).toEqual([`server/src/bin.ts#start -> ${UNRESOLVED}#createApi`]);
  });

  it("draws one when the workspace it names has no package entry to reach it by", () => {
    // `web`'s manifest has no `exports`, because nothing imports `web`. A call written across
    // that boundary anyway has no module to land on, and the graph says that rather than
    // picking one.
    expect(
      edgesOf({
        "web/package.json": manifest("web"),
        "web/src/key.ts": lines(`export function groupKey(of: string): string {`, `  return of;`, `}`),
        "server/package.json": manifest("server", "./src/index.ts"),
        "server/src/use.ts": lines(
          `import { groupKey } from "@biu-cs-planner/web";`,
          `export function keysOf(one: string): string {`,
          `  return groupKey(one);`,
          `}`,
        ),
      }),
    ).toEqual([`server/src/use.ts#keysOf -> ${UNRESOLVED}#groupKey`]);
  });

  it("ends a re-export loop instead of following it forever", () => {
    // Two barrels re-exporting a name from each other declare it nowhere. A defect, and
    // `tools/pr-review/cycles.ts` is what reports one; what this asks is that the report is
    // still generated.
    expect(
      edgesOf({
        "core/package.json": manifest("core", "./src/index.ts"),
        "core/src/one.ts": lines(`export { thing } from "./two.ts";`),
        "core/src/two.ts": lines(`export { thing } from "./one.ts";`),
        "core/src/use.ts": lines(
          `import { thing } from "./one.ts";`,
          `export function useIt(): unknown {`,
          `  return thing();`,
          `}`,
        ),
      }),
    ).toEqual([`core/src/use.ts#useIt -> ${UNRESOLVED}#thing`]);
  });
});

/**
 * The graph against the repository it describes. The fixtures above prove the rule; these
 * prove the rule is what this tree is read by.
 */
describe("this repository", () => {
  const edges = collect(ROOT).edges;
  const workspaceOf = (ref: string): string => ref.split("/")[0] ?? "";

  /**
   * Who may call into whom, which is `docs/design.md`'s architecture read as a call graph:
   * `web → server → app → core`, and `core` calls nobody. `tools/pr-review/layering.ts` is
   * the gate and judges *imports*; this asks the same question of the **calls**, which no
   * check asks, and which is the question the graph answered wrongly for three edges.
   */
  const MAY_CALL: Record<string, readonly string[]> = {
    core: [],
    app: ["core"],
    server: ["app", "core"],
    web: ["server"],
  };

  it("draws no call between core and web, in either direction", () => {
    // Three edges pointed from `core` at `web/src/timetable/week.ts#groupKey` before #86, and
    // the direction was the alphabet's doing: `core` read last would have drawn `web` calling
    // into `core`, the absolute prohibition. So both directions are asserted, not one.
    const across = edges
      .filter((e) => workspaceOf(e.from) !== workspaceOf(e.to))
      .map((e) => `${workspaceOf(e.from)} -> ${workspaceOf(e.to)}`);
    expect(across.filter((pair) => pair.includes("core") && pair.includes("web"))).toEqual([]);
    // Asserted over a graph that was actually read, rather than over an empty list that would
    // satisfy any negative. Which pairs exist is the next test's question; that some do is
    // this one's precondition.
    expect(across.length).toBeGreaterThan(0);
  });

  it("draws no call in a direction the architecture forbids", () => {
    // Over the edges that name a module at both ends. An unresolved node's ref names no
    // workspace, so it would fail this under a title about direction rather than under the
    // canary below, which is the test that is actually about it.
    const wrong = edges.filter((e) => {
      if (e.to.startsWith(`${UNRESOLVED}#`)) return false;
      const from = workspaceOf(e.from);
      const to = workspaceOf(e.to);
      return from !== to && !(MAY_CALL[from] ?? []).includes(to);
    });
    expect(wrong).toEqual([]);
  });

  it("resolves core's `groupKey` to core's, and web's to web's", () => {
    // The two functions #86 named, and the same name declared in two workspaces is exactly
    // the case it was got wrong for: before #86 three edges landed on `web`'s, whichever
    // workspace was read last. Every call now lands in the workspace that made it, which is
    // asserted as the pair rather than as the far end alone.
    const groupKey = edges.filter((e) => e.to.endsWith("#groupKey"));
    expect([...new Set(groupKey.map((e) => `${workspaceOf(e.from)} -> ${e.to}`))].sort()).toEqual(
      [
        "core -> core/src/shoham/changes.ts#groupKey",
        "web -> web/src/timetable/week.ts#groupKey",
      ],
    );
    expect(
      groupKey
        .filter((e) => e.to.startsWith("core/"))
        .map((e) => e.from)
        .sort(),
    ).toEqual([
      "core/src/shoham/import.ts#groupIndexOf",
      "core/src/shoham/import.ts#importRawCrawl",
    ]);
  });

  it("places every call it draws, so the graph holds no unresolved node", () => {
    // A canary rather than a rule. If this fails, the report is not wrong — it is telling you
    // that a name someone imports is no longer exported where they import it from, or that a
    // workspace is being imported as a package it cannot be reached by.
    expect(edges.filter((e) => e.to.startsWith(`${UNRESOLVED}#`))).toEqual([]);
  });
});
