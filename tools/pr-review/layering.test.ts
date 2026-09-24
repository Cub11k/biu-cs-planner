import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "../pr-report/collect.ts";
import { readModule, type ImportRef, type Module } from "../pr-report/surface.ts";
import { readTestFile, type TestFile } from "../pr-report/tests.ts";
import { LAYERS, WORKSPACES, explain, forbiddenEdges, summarise } from "./layering.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/** A specifier written as a bare string is a value import; `types(…)` is the other kind. */
const ref = (spec: string | ImportRef): ImportRef =>
  typeof spec === "string" ? { specifier: spec, typeOnly: false, erasable: false } : spec;

/** The same specifier, arriving as `import type` — type-only and erased from the emit. */
const types = (specifier: string): ImportRef => ({ specifier, typeOnly: true, erasable: true });

/**
 * The same specifier, arriving as the inline `import { type X }` — type-only and *not*
 * erased: `verbatimModuleSyntax` leaves the specifier behind for a bundler to resolve.
 * The distinction #59 exists for.
 */
const inlineTypes = (specifier: string): ImportRef => ({
  specifier,
  typeOnly: true,
  erasable: false,
});

type Specs = readonly (string | ImportRef)[];

const module = (
  path: string,
  edges: { imports?: Specs; packages?: Specs } = {},
): Module => ({
  path,
  workspace: path.split("/")[0] ?? "",
  exports: [],
  imports: (edges.imports ?? []).map(ref),
  packages: (edges.packages ?? []).map(ref),
});

const testFile = (path: string, targets: Specs): TestFile => ({
  path,
  cases: [],
  targets: targets.map(ref),
});

/**
 * One file written into a throwaway repo root and read back the way the report reads it.
 * Every other test here builds its input as an object literal and would still pass if
 * `tools/pr-report` quietly stopped recording an import — at which point nothing would
 * catch a `web → core` edge at all.
 */
function fromSource<T>(
  relPath: string,
  source: string,
  read: (file: string, root: string) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), "layering-"));
  try {
    const file = join(root, relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source, "utf8");
    return read(file, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const moduleFromSource = (relPath: string, source: string): Module =>
  fromSource(relPath, source, readModule);

const testFromSource = (relPath: string, source: string): TestFile =>
  fromSource(relPath, source, readTestFile);

/** The rule as one string per edge, which is all most of these tests care about. */
const broken = (modules: Module[], tests: TestFile[] = []): string[] =>
  forbiddenEdges(modules, tests).map((edge) => `${edge.fromWorkspace} → ${edge.toWorkspace}`);

describe("the declared rule", () => {
  it("gives every workspace exactly one entry", () => {
    expect(LAYERS.map((layer) => layer.workspace)).toEqual([...WORKSPACES]);
  });

  it("lets nothing import web", () => {
    // Written against both forms an entry can take: a bare name and a narrowed one.
    const allowed = LAYERS.flatMap((layer) =>
      layer.mayImport.map((entry) => (typeof entry === "string" ? entry : entry.workspace)),
    );
    expect(allowed).not.toContain("web");
  });

  it("has one strength of narrowing, and it is erasable", () => {
    // The ruling on #59, pinned: a narrowed entry always means the erased spelling, so
    // there is no weaker object form for a later edit to reach for by accident. If this
    // ever needs to become per-entry, this test is the place the reason gets written.
    const narrowed = LAYERS.flatMap((layer) =>
      layer.mayImport.filter((entry) => typeof entry !== "string"),
    );
    expect(narrowed).toEqual([{ workspace: "server", erasable: true }]);
  });
});

describe("edges the rule allows", () => {
  it("lets app import core", () => {
    expect(
      broken([module("app/src/use.ts", { packages: ["@biu-cs-planner/core"] })]),
    ).toEqual([]);
  });

  it("lets server import app and core", () => {
    expect(
      broken([
        module("server/src/api.ts", {
          packages: ["@biu-cs-planner/app", "@biu-cs-planner/core"],
        }),
      ]),
    ).toEqual([]);
  });

  it("lets web learn the contract from server, as types", () => {
    expect(
      broken([module("web/src/api.ts", { packages: [types("@biu-cs-planner/server")] })]),
    ).toEqual([]);
  });

  it("says nothing about a module importing its own workspace", () => {
    expect(
      broken([module("web/src/timetable/week.ts", { imports: ["web/src/api.ts"] })]),
    ).toEqual([]);
  });

  it("says nothing about packages that are not this project's workspaces", () => {
    expect(
      broken([module("web/src/App.tsx", { packages: ["react", "hono/client", "zod"] })]),
    ).toEqual([]);
  });

  it("says nothing about a file outside the four workspaces", () => {
    // `tools/` is not governed by this rule: it reads all four on purpose.
    expect(
      broken([module("tools/pr-review/main.ts", { packages: ["@biu-cs-planner/core"] })]),
    ).toEqual([]);
  });

  it("says nothing about an import that leaves the four workspaces", () => {
    // Out of scope on purpose: this check is about direction between workspaces.
    expect(
      broken([module("core/src/plan.ts", { imports: ["tools/pr-report/surface.ts"] })]),
    ).toEqual([]);
  });
});

describe("edges the rule forbids", () => {
  it("catches web importing core", () => {
    expect(
      broken([module("web/src/timetable/week.ts", { packages: ["@biu-cs-planner/core"] })]),
    ).toEqual(["web → core"]);
  });

  it("catches web importing app", () => {
    expect(broken([module("web/src/App.tsx", { packages: ["@biu-cs-planner/app"] })])).toEqual([
      "web → app",
    ]);
  });

  it("catches web reaching core by relative path rather than by package name", () => {
    // The package boundary is the front door; this is the window beside it.
    expect(
      broken([module("web/src/timetable/week.ts", { imports: ["core/src/catalog/schema.ts"] })]),
    ).toEqual(["web → core"]);
  });

  it("catches a deep import into a workspace", () => {
    expect(
      broken([module("web/src/api.ts", { packages: ["@biu-cs-planner/core/catalog"] })]),
    ).toEqual(["web → core"]);
  });

  it("catches core importing anything above it", () => {
    // Sorted by the imported module, so the package names come before the path.
    expect(
      broken([
        module("core/src/plan.ts", {
          packages: ["@biu-cs-planner/app", "@biu-cs-planner/server"],
          imports: ["web/src/api.ts"],
        }),
      ]),
    ).toEqual(["core → app", "core → server", "core → web"]);
  });

  it("catches app importing server", () => {
    expect(broken([module("app/src/use.ts", { packages: ["@biu-cs-planner/server"] })])).toEqual([
      "app → server",
    ]);
  });

  it("catches anything importing web, which nothing may", () => {
    expect(
      broken([
        module("app/src/use.ts", { imports: ["web/src/api.ts"] }),
        module("server/src/ui.ts", { imports: ["web/src/api.ts"] }),
      ]),
    ).toEqual(["app → web", "server → web"]);
  });

  it("counts a type-only import like any other on an edge nobody allowed", () => {
    // The guardrail on `web → core` is about what `web` is allowed to know, not about
    // what reaches the bundle, so writing `import type` does not buy a way past it.
    expect(
      broken([
        module("web/src/timetable/catalog.ts", { imports: [types("core/src/catalog/schema.ts")] }),
      ]),
    ).toEqual(["web → core"]);
  });

  it("lists the same tree in the same order every time", () => {
    const modules = [
      module("web/src/b.ts", { packages: ["@biu-cs-planner/core"] }),
      module("web/src/a.ts", { packages: ["@biu-cs-planner/app", "@biu-cs-planner/core"] }),
    ];
    const paths = forbiddenEdges(modules, []).map((edge) => `${edge.from} ${edge.imported}`);
    expect(paths).toEqual([
      "web/src/a.ts @biu-cs-planner/app",
      "web/src/a.ts @biu-cs-planner/core",
      "web/src/b.ts @biu-cs-planner/core",
    ]);
  });
});

describe("the erasable type-only edge, `web` to `server`", () => {
  /**
   * The narrowest entry in the table, and the only one that reads the kind of import.
   * `web` learns the API's shape from `server`'s exported `ApiType` and must learn
   * nothing else from it: a value import would pull `node:fs` and the rest of the Node
   * runtime into the browser bundle, which the old rule allowed and nothing caught.
   *
   * And it must learn it in the spelling that leaves nothing behind. #59: the inline
   * `import { type ApiType }` carries only types and still emits a specifier, so the
   * bundler resolves `server/src/index.ts` → `workspace.fs.ts` → `node:fs/promises` and
   * the edge fails the purpose it was narrowed for.
   */

  it("lets the contract in, by package name", () => {
    expect(
      broken([module("web/src/api.ts", { packages: [types("@biu-cs-planner/server")] })]),
    ).toEqual([]);
  });

  it("lets the contract in by relative path too, which is the same knowledge", () => {
    expect(
      broken([module("web/src/api.ts", { imports: [types("server/src/api.ts")] })]),
    ).toEqual([]);
  });

  it("fails a value import from web to server", () => {
    expect(broken([module("web/src/api.ts", { packages: ["@biu-cs-planner/server"] })])).toEqual([
      "web → server",
    ]);
  });

  it("fails a value import written as a relative path", () => {
    expect(broken([module("web/src/api.ts", { imports: ["server/src/api.ts"] })])).toEqual([
      "web → server",
    ]);
  });

  it("fails a deep value import into server", () => {
    expect(
      broken([module("web/src/api.ts", { packages: ["@biu-cs-planner/server/token"] })]),
    ).toEqual(["web → server"]);
  });

  it("fails the inline `import { type X }` form, which is not erased from the emit", () => {
    expect(
      broken([module("web/src/api.ts", { packages: [inlineTypes("@biu-cs-planner/server")] })]),
    ).toEqual(["web → server"]);
  });

  it("fails the inline form written as a relative path too", () => {
    expect(
      broken([module("web/src/api.ts", { imports: [inlineTypes("server/src/api.ts")] })]),
    ).toEqual(["web → server"]);
  });

  it("tells the three failures apart, since each has a different fix", () => {
    const edges = forbiddenEdges(
      [
        module("web/src/api.ts", { packages: ["@biu-cs-planner/server"] }),
        module("web/src/contract.ts", { packages: [inlineTypes("@biu-cs-planner/server")] }),
        module("web/src/plan.ts", { packages: [types("@biu-cs-planner/core")] }),
      ],
      [],
    );
    expect(edges.map((edge) => `${edge.from}:${edge.kind}`)).toEqual([
      "web/src/api.ts:value",
      "web/src/contract.ts:spelling",
      "web/src/plan.ts:direction",
    ]);
  });

  it("names the erasable spelling as the fix, since nothing else would hint at it", () => {
    const [edge] = forbiddenEdges(
      [module("web/src/api.ts", { packages: [inlineTypes("@biu-cs-planner/server")] })],
      [],
    );
    expect(edge && explain(edge)).toBe(
      "`web/src/api.ts` takes types from `@biu-cs-planner/server` with the `type` keyword " +
        "inside the clause, which `verbatimModuleSyntax` leaves in the emit as a specifier a " +
        "bundler must resolve; write `import type { … } from` (or `export type { … } from`) " +
        "instead, which is erased — `web` knows only the HTTP API contract, which it learns " +
        "from `server`'s exported `ApiType`, so it may import types from `server` and nothing " +
        "else — never a value from `server`, only in the spelling that erases, and never " +
        "`core` or `app` at all.",
    );
  });

  it("says a value arrived where only a type may, so the fix is legible", () => {
    const [edge] = forbiddenEdges(
      [module("web/src/api.ts", { packages: ["@biu-cs-planner/server"] })],
      [],
    );
    expect(edge && explain(edge)).toBe(
      "`web/src/api.ts` imports a value from `@biu-cs-planner/server`; `web` may import only " +
        "types from `server` — `web` knows only the HTTP API contract, which it learns from " +
        "`server`'s exported `ApiType`, so it may import types from `server` and nothing " +
        "else — never a value from `server`, only in the spelling that erases, and never " +
        "`core` or `app` at all.",
    );
  });

  it("narrows nothing else: `app` may still import `core` either way", () => {
    // "Not in this ticket" on #51: every other entry stays as wide as it was.
    expect(
      broken([
        module("app/src/use.ts", { packages: [types("@biu-cs-planner/core")] }),
        module("server/src/api.ts", { packages: ["@biu-cs-planner/app"] }),
      ]),
    ).toEqual([]);
  });

  it("lets a web test file take the contract, and not a value", () => {
    expect(broken([], [testFile("web/src/api.test.ts", [types("server/src/api.ts")])])).toEqual(
      [],
    );
    expect(broken([], [testFile("web/src/api.test.ts", ["server/src/api.ts"])])).toEqual([
      "web → server",
    ]);
  });

  it("holds a web test file to the erasable spelling too", () => {
    // `tests.ts` records the same two flags a module carries, so the rule reads the same.
    expect(
      broken([], [testFile("web/src/api.test.ts", [inlineTypes("server/src/api.ts")])]),
    ).toEqual(["web → server"]);
  });
});

describe("test files", () => {
  it("catches a web test reaching into core, which `modules` alone would never show", () => {
    // `collect` keeps test files out of `modules`, so judging only those would have let a
    // whole class of file break the rule in silence.
    expect(
      broken([], [testFile("web/src/timetable/week.test.ts", ["core/src/timetable/clashes.ts"])]),
    ).toEqual(["web → core"]);
  });

  it("names the test file itself, not the module it is a test of", () => {
    const [edge] = forbiddenEdges(
      [],
      [testFile("web/src/api.test.ts", ["app/src/queries.ts"])],
    );
    expect(edge?.from).toBe("web/src/api.test.ts");
    expect(edge?.imported).toBe("app/src/queries.ts");
  });

  it("says nothing about a test importing its own workspace", () => {
    expect(broken([], [testFile("core/src/plan.test.ts", ["core/src/plan.ts"])])).toEqual([]);
  });

  it("cannot see a package a test file imports, because the graphs do not record it", () => {
    // A known hole, pinned here rather than left to be discovered: `tests.ts` keeps only a
    // test's relative imports, since what it is really after is what each test is a test
    // *of*. Closing it means changing `tools/pr-report`. The module doc says so too.
    const sneaky = testFromSource(
      "web/src/api.test.ts",
      [
        'import { expect, it } from "vitest";',
        'import { parseCatalog } from "@biu-cs-planner/core";',
        'it("reaches into core", () => expect(parseCatalog).toBeDefined());',
      ].join("\n"),
    );
    expect(sneaky.targets).toEqual([]);
    expect(forbiddenEdges([], [sneaky])).toEqual([]);
  });
});

describe("real source text", () => {
  it("becomes a finding, through the same reader the report uses", () => {
    const reaching = moduleFromSource(
      "web/src/reaches-into-core.ts",
      [
        'import type { Catalog } from "@biu-cs-planner/core";',
        'import { parse } from "../../core/src/index.ts";',
        "export const read = (file: Catalog) => parse(file);",
      ].join("\n"),
    );
    expect(forbiddenEdges([reaching], []).map((edge) => edge.imported)).toEqual([
      "@biu-cs-planner/core",
      "core/src/index.ts",
    ]);
  });

  it("catches a value pulled out of server, which no `import type` would have allowed", () => {
    const smuggled = moduleFromSource(
      "web/src/api.ts",
      [
        'import { serve } from "@biu-cs-planner/server";',
        "export const start = () => serve();",
      ].join("\n"),
    );
    expect(forbiddenEdges([smuggled], []).map((edge) => edge.kind)).toEqual(["value"]);
  });

  it("catches a mixed import, where one named binding is a value", () => {
    const mixed = moduleFromSource(
      "web/src/api.ts",
      [
        'import { type ApiType, serve } from "@biu-cs-planner/server";',
        "export const start = (): ApiType => serve();",
      ].join("\n"),
    );
    expect(forbiddenEdges([mixed], []).map((edge) => edge.kind)).toEqual(["value"]);
  });

  it("lets web re-export the contract with `export type { X } from`, which is erased", () => {
    const passing = moduleFromSource(
      "web/src/contract.ts",
      ['export type { ApiType } from "@biu-cs-planner/server";'].join("\n"),
    );
    expect(forbiddenEdges([passing], [])).toEqual([]);
  });

  it("fails web writing the inline `import { type X }`, which the emit keeps", () => {
    // The line #59 is about, read from source through the same reader the report uses.
    // It carries only a type and it is still a finding: `import { type ApiType } from
    // "@biu-cs-planner/server"` emits `import {} from "@biu-cs-planner/server"`, so the
    // bundler resolves `server/src/index.ts` and `node:fs/promises` arrives with it.
    const inline = moduleFromSource(
      "web/src/api.ts",
      [
        'import { hc } from "hono/client";',
        'import { type ApiType } from "@biu-cs-planner/server";',
        'export const api = hc<ApiType>("/");',
      ].join("\n"),
    );
    const edges = forbiddenEdges([inline], []);
    expect(edges.map((edge) => `${edge.toWorkspace}:${edge.kind}`)).toEqual(["server:spelling"]);
    expect(edges.map(explain).join("\n")).toContain("write `import type { … } from`");
  });

  it("fails the inline `export { type X } from` re-export by the very same rule", () => {
    // The other direction, judged the same way and for the same reason: `export { type
    // ApiType } from "…"` emits `export {} from "…"` and keeps the specifier.
    const inline = moduleFromSource(
      "web/src/contract.ts",
      ['export { type ApiType } from "@biu-cs-planner/server";'].join("\n"),
    );
    expect(forbiddenEdges([inline], []).map((edge) => edge.kind)).toEqual(["spelling"]);
  });

  it("still fails a value re-export out of server, which is not a spelling problem", () => {
    const value = moduleFromSource(
      "web/src/contract.ts",
      ['export { launchToken } from "@biu-cs-planner/server";'].join("\n"),
    );
    expect(forbiddenEdges([value], []).map((edge) => edge.kind)).toEqual(["value"]);
  });

  it("cannot see a dynamic import, because no graph records one", () => {
    // A known hole, pinned here rather than left to be discovered. `readModule` reads the
    // static `import` and `export … from` at the top of a file and nothing else, so this
    // is invisible to the report, to the cycle check and to this alike — which is exactly
    // the outcome the type-only rule is otherwise guarding against. Closing it means
    // teaching `tools/pr-report` to walk call expressions; the module doc says so too.
    const dynamic = moduleFromSource(
      "web/src/api.ts",
      [
        "export const start = async () => {",
        '  const { serve } = await import("@biu-cs-planner/server");',
        "  return serve();",
        "};",
      ].join("\n"),
    );
    expect(dynamic.packages).toEqual([]);
    expect(forbiddenEdges([dynamic], [])).toEqual([]);
  });

  it("stays quiet for the contract arriving in web, which is how web is meant to work", () => {
    const client = moduleFromSource(
      "web/src/api.ts",
      [
        'import { hc } from "hono/client";',
        'import type { ApiType } from "@biu-cs-planner/server";',
        "export const api = hc<ApiType>(\"/\");",
      ].join("\n"),
    );
    expect(forbiddenEdges([client], [])).toEqual([]);
  });
});

describe("summarise", () => {
  it("says the whole rule, generated from the table so the two cannot drift", () => {
    expect(summarise()).toBe(
      "`core` imports none of the others, `app` imports `core`, " +
        "`server` imports `core` and `app`, " +
        "`web` imports `server` for types only, written `import type`",
    );
  });
});

describe("explain", () => {
  it("names the importing file, the imported module and the rule broken", () => {
    const [edge] = forbiddenEdges(
      [module("web/src/timetable/week.ts", { imports: ["core/src/catalog/schema.ts"] })],
      [],
    );
    expect(edge && explain(edge)).toBe(
      "`web/src/timetable/week.ts` imports `core/src/catalog/schema.ts`; `web` may not import " +
        "`core` — `web` knows only the HTTP API contract, which it learns from `server`'s " +
        "exported `ApiType`, so it may import types from `server` and nothing else — never " +
        "a value from `server`, only in the spelling that erases, and never `core` or `app` " +
        "at all.",
    );
  });
});

describe("this repository", () => {
  it("points every dependency the way the rule says", () => {
    // Not a unit test: the guardrail itself, run against the tree the modules are read
    // from, so a rule-breaking import fails `npm test` and not only the PR comment.
    const derived = collect(ROOT);
    expect(forbiddenEdges(derived.modules, derived.tests).map(explain)).toEqual([]);
  });
});
