import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "../pr-report/collect.ts";
import { readModule, type Module } from "../pr-report/surface.ts";
import { readTestFile, type TestFile } from "../pr-report/tests.ts";
import { LAYERS, WORKSPACES, explain, forbiddenEdges, summarise } from "./layering.ts";

const ROOT = resolve(import.meta.dirname, "../..");

const module = (
  path: string,
  edges: { imports?: string[]; packages?: string[] } = {},
): Module => ({
  path,
  workspace: path.split("/")[0] ?? "",
  exports: [],
  imports: edges.imports ?? [],
  packages: edges.packages ?? [],
});

const testFile = (path: string, targets: string[]): TestFile => ({ path, cases: [], targets });

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
    expect(LAYERS.flatMap((layer) => layer.mayImport)).not.toContain("web");
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

  it("lets web learn the contract from server", () => {
    expect(broken([module("web/src/api.ts", { packages: ["@biu-cs-planner/server"] })])).toEqual(
      [],
    );
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

  it("counts a type-only import like any other, because it is still knowledge of core", () => {
    // `Module` carries no type-only flag, and the rule does not want one: the guardrail
    // is about what `web` is allowed to know, not about what reaches the bundle.
    expect(
      broken([
        module("web/src/timetable/catalog.ts", { imports: ["core/src/catalog/schema.ts"] }),
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
        "`server` imports `core` and `app`, `web` imports `server`",
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
        "exported `ApiType`, so it may never import `core` or `app`.",
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
