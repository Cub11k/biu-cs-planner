import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "../pr-report/collect.ts";
import type { Module } from "../pr-report/surface.ts";
import { LAYERS, WORKSPACES, explain, forbiddenEdges } from "./layering.ts";

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

/** The rule as one string per edge, which is all most of these tests care about. */
const broken = (modules: Module[]): string[] =>
  forbiddenEdges(modules).map((edge) => `${edge.fromWorkspace} → ${edge.toWorkspace}`);

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
    const paths = forbiddenEdges(modules).map((edge) => `${edge.from} ${edge.imported}`);
    expect(paths).toEqual([
      "web/src/a.ts @biu-cs-planner/app",
      "web/src/a.ts @biu-cs-planner/core",
      "web/src/b.ts @biu-cs-planner/core",
    ]);
  });
});

describe("explain", () => {
  it("names the importing file, the imported module and the rule broken", () => {
    const [edge] = forbiddenEdges([
      module("web/src/timetable/week.ts", { imports: ["core/src/catalog/schema.ts"] }),
    ]);
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
    expect(forbiddenEdges(collect(ROOT).modules).map(explain)).toEqual([]);
  });
});
