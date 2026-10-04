import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  mergeImports,
  packageWorkspace,
  readModule,
  resolveReExports,
  RE_EXPORTED,
  specifierTarget,
  type ImportKind,
  type ImportRef,
  type Module,
} from "./surface.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * How an import is written decides what the layering rule may allow, so the forms are
 * read from real source text here rather than described by an object literal. Every case
 * below is a line somebody could plausibly write; the question each asks is whether any
 * code can travel along the edge.
 */

/** One file written into a throwaway root and read back the way the report reads it. */
function moduleFromSource(relPath: string, lines: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), "surface-"));
  try {
    const file = join(root, relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join("\n"), "utf8");
    return readModule(file, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Several files written into one throwaway root and read back the way the report reads them.
 *
 * `moduleFromSource` is one file, which is all `readModule` ever sees — and `resolveReExports`
 * is the pass that exists because one file is not enough, so its fixtures are written as the
 * little module graphs they are.
 */
function modulesFromSources(files: Readonly<Record<string, readonly string[]>>): Module[] {
  const root = mkdtempSync(join(tmpdir(), "surface-"));
  try {
    return Object.entries(files).map(([relPath, lines]) => {
      const file = join(root, relPath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, lines.join("\n"), "utf8");
      return readModule(file, root);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every import the module records, local and package alike. */
const refs = (lines: readonly string[]): ImportRef[] => {
  const module = moduleFromSource("web/src/subject.ts", lines);
  return [...module.imports, ...module.packages];
};

/** Every import the module records, as `specifier:type|value`. */
const kinds = (lines: readonly string[]): string[] =>
  refs(lines).map((ref) => `${ref.specifier}:${ref.typeOnly ? "type" : "value"}`);

/**
 * The same imports, as `specifier:erased|kept` — whether the statement survives the emit.
 *
 * A separate reading from `kinds` because it is a separate question, and the whole reason
 * `ImportKind` has two fields: the answers differ for the inline `type` spellings, which
 * is the trap #59 was filed about.
 */
const emits = (lines: readonly string[]): string[] =>
  refs(lines).map((ref) => `${ref.specifier}:${ref.erasable ? "erased" : "kept"}`);

describe("whether an import carries only types", () => {
  it("reads `import type { X }` as type-only", () => {
    expect(kinds(['import type { ApiType } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:type",
    ]);
  });

  it("reads the inline `import { type X }` form as type-only too", () => {
    // Same bindings, different spelling: nothing but a type arrives either way, so this
    // answer is about knowledge and says nothing about the emit. `erasable` is where the
    // two lines part, in the suite below.
    expect(kinds(['import { type ApiType } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:type",
    ]);
  });

  it("reads a mixed `import { type X, y }` as a value import", () => {
    // `y` is code, whatever `X` is.
    expect(kinds(['import { type ApiType, serve } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:value",
    ]);
  });

  it("reads `import type * as ns` as type-only", () => {
    expect(kinds(['import type * as api from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:type",
    ]);
  });

  it("reads `import type D` as type-only, keyword before clause beating binding shape", () => {
    // `import type` covers whatever follows it, so a default binding under the keyword is
    // still a type. Pinned because the same binding *without* the keyword is a value.
    expect(kinds(['import type ApiClient from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:type",
    ]);
  });

  it("reads a namespace import as a value, because the whole module arrives", () => {
    expect(kinds(['import * as api from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:value",
    ]);
  });

  it("reads a default import as a value", () => {
    expect(kinds(['import ts from "typescript";'])).toEqual(["typescript:value"]);
  });

  it("reads a bare `import \"./x\"` as a value, because a side effect is code running", () => {
    expect(kinds(['import "./styles.ts";'])).toEqual(["web/src/styles.ts:value"]);
  });

  it("reads an empty clause as a value, for the same reason", () => {
    // `import {} from "./x"` is written for the side effect and nothing else.
    expect(kinds(['import {} from "./styles.ts";'])).toEqual(["web/src/styles.ts:value"]);
  });

  it("reads `export type { X } from` as type-only", () => {
    expect(kinds(['export type { ApiType } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:type",
    ]);
  });

  it("reads the inline `export { type X } from` form as type-only", () => {
    expect(kinds(['export { type ApiType } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:type",
    ]);
  });

  it("reads `export { x } from` as a value", () => {
    expect(kinds(['export { serve } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:value",
    ]);
  });

  it("reads `export * from` as a value, since whatever is there comes with it", () => {
    expect(kinds(['export * from "./api.ts";'])).toEqual(["web/src/api.ts:value"]);
  });

  it("lets a value import beat a type-only one of the same module", () => {
    // One arrow per pair, and the question it answers is whether code can travel along
    // it. One value import is enough for yes.
    expect(
      kinds([
        'import type { ApiType } from "@biu-cs-planner/server";',
        'import { serve } from "@biu-cs-planner/server";',
      ]),
    ).toEqual(["@biu-cs-planner/server:value"]);
  });

  it("keeps a module type-only when every mention of it is", () => {
    expect(
      kinds([
        'import type { ApiType } from "@biu-cs-planner/server";',
        'export type { ApiType } from "@biu-cs-planner/server";',
      ]),
    ).toEqual(["@biu-cs-planner/server:type"]);
  });

  it("still leaves node: built-ins out of the graph", () => {
    expect(kinds(['import { readFileSync } from "node:fs";'])).toEqual([]);
  });
});

describe("what the compiler actually emits", () => {
  /**
   * The premise the whole `erasable` field rests on, asked of the compiler rather than
   * asserted in a comment. `ImportKind`'s doc carries this as a table, and a table in a
   * comment is exactly the kind of claim that is true when written and wrong two releases
   * later — so the table is pinned here instead, against the same `typescript` the report
   * parses with.
   *
   * Each source below keeps a second, ordinary export. Without one, a file whose only
   * statement was erased picks up a bare `export {};` module marker, which says nothing
   * about the import and would read as though `import type` emitted something.
   */
  const emitted = (line: string): string =>
    ts.transpileModule(`${line}\nexport const a = 1;`, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        allowImportingTsExtensions: true,
      },
    }).outputText.trim();

  it("erases the three keyword-before-clause forms, leaving no specifier", () => {
    expect(emitted('import type { X } from "./m.ts";')).toBe("export const a = 1;");
    expect(emitted('import type * as ns from "./m.ts";')).toBe("export const a = 1;");
    expect(emitted('export type { X } from "./m.ts";')).toBe("export const a = 1;");
  });

  it("keeps the specifier for both inline forms, which is the whole of #59", () => {
    // `import {}` and `export {}` still name a module a bundler must resolve, so
    // `server/src/index.ts` is reached and `node:fs/promises` arrives with it.
    expect(emitted('import { type X } from "./m.ts";')).toBe(
      'import {} from "./m.ts";\nexport const a = 1;',
    );
    expect(emitted('export { type X } from "./m.ts";')).toBe(
      'export {} from "./m.ts";\nexport const a = 1;',
    );
  });
});

describe("whether the statement survives the emit", () => {
  /**
   * The reader's answer to the question the suite above asks the compiler. The two must
   * agree: `erasable` is true for exactly the forms `transpileModule` erases.
   */

  it("erases `import type { X }`, leaving no specifier at all", () => {
    expect(emits(['import type { ApiType } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:erased",
    ]);
  });

  it("keeps the inline `import { type X }`, matching what the compiler emitted", () => {
    // The whole of #59: type-only and *not* erased. A bundler still resolves the
    // specifier, so `server/src/index.ts` is reached and `node:fs/promises` comes with it.
    expect(emits(['import { type ApiType } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:kept",
    ]);
  });

  it("erases `export type { X } from`", () => {
    expect(emits(['export type { ApiType } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:erased",
    ]);
  });

  it("keeps the inline `export { type X } from`, the same trap in the other direction", () => {
    expect(emits(['export { type ApiType } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:kept",
    ]);
  });

  it("erases `import type * as ns`, because the keyword before the clause covers it", () => {
    expect(emits(['import type * as api from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:erased",
    ]);
  });

  it("erases `import type D`, for the same reason", () => {
    expect(emits(['import type ApiClient from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:erased",
    ]);
  });

  it("keeps every import that carries code", () => {
    expect(
      emits([
        'import { serve } from "@biu-cs-planner/server";',
        'import "./styles.ts";',
        'export * from "./api.ts";',
      ]),
    ).toEqual([
      "web/src/styles.ts:kept",
      "web/src/api.ts:kept",
      "@biu-cs-planner/server:kept",
    ]);
  });

  it("keeps the edge when one mention of the module is the inline form", () => {
    // Type-only twice over and still not erased: the re-export leaves the specifier.
    expect(
      refs([
        'import type { ApiType } from "@biu-cs-planner/server";',
        'export { type ApiType } from "@biu-cs-planner/server";',
      ]),
    ).toEqual([{ specifier: "@biu-cs-planner/server", typeOnly: true, erasable: false }]);
  });

  it("never calls an import erasable without calling it type-only", () => {
    // The invariant the layering rule leans on: `erasable` is the stricter of the two, so
    // demanding it also rules out a value import. Asserted over every form above.
    const forms = [
      'import type { A } from "./a.ts";',
      'import { type B } from "./b.ts";',
      'import type * as c from "./c.ts";',
      'import type D from "./d.ts";',
      'import { e } from "./e.ts";',
      'import * as f from "./f.ts";',
      'import g from "./g.ts";',
      'import "./h.ts";',
      'import {} from "./i.ts";',
      'export type { J } from "./j.ts";',
      'export { type K } from "./k.ts";',
      'export { l } from "./l.ts";',
      'export * from "./m.ts";',
      'export type * from "./n.ts";',
    ];
    const broken = refs(forms).filter((ref) => ref.erasable && !ref.typeOnly);
    expect(broken).toEqual([]);
    // And the set that *is* erasable is exactly the four keyword-before-clause forms.
    expect(refs(forms).filter((ref) => ref.erasable).map((ref) => ref.specifier)).toEqual([
      "web/src/a.ts",
      "web/src/c.ts",
      "web/src/d.ts",
      "web/src/j.ts",
      // `export type * from` puts the keyword before the clause too, so it erases.
      "web/src/n.ts",
    ]);
  });
});

describe("mergeImports", () => {
  /**
   * The three legal states, spelled out. `ImportKind` is a union, not two free booleans, so
   * a helper taking `(typeOnly: boolean, erasable: boolean)` would not type-check here —
   * which is the point of the union: the illegal fourth pair has no way in, not even
   * through a test.
   */
  const ERASED: ImportKind = { typeOnly: true, erasable: true };
  const KEPT: ImportKind = { typeOnly: true, erasable: false };
  const CODE: ImportKind = { typeOnly: false, erasable: false };

  const ref = (specifier: string, kind: ImportKind): ImportRef => ({ specifier, ...kind });

  it("keeps one entry per specifier, in the order first met", () => {
    expect(
      mergeImports([ref("./b.ts", CODE), ref("./a.ts", ERASED), ref("./b.ts", ERASED)]),
    ).toEqual([ref("./b.ts", CODE), ref("./a.ts", ERASED)]);
  });

  it("merges the two flags separately, so one kept statement keeps the edge", () => {
    expect(mergeImports([ref("./a.ts", ERASED), ref("./a.ts", KEPT)])).toEqual([
      ref("./a.ts", KEPT),
    ]);
  });

  it("says nothing about an empty list", () => {
    expect(mergeImports([])).toEqual([]);
  });
});

/**
 * A cross-workspace import is written as a package name, so anything that wants to place
 * such an edge back in the tree — the module graph does — has to get the workspace name
 * back out of it. Only this repo's own workspaces count; everything else is a library.
 */
describe("packageWorkspace", () => {
  it("reads the workspace out of one of this project's own package names", () => {
    expect(packageWorkspace("@biu-cs-planner/core")).toBe("core");
    expect(packageWorkspace("@biu-cs-planner/server")).toBe("server");
  });

  it("lands a deep import in the workspace it came from", () => {
    // `@biu-cs-planner/core/thing` is still `core`, and the module graph draws it as one
    // arrow at that box rather than inventing a second.
    expect(packageWorkspace("@biu-cs-planner/core/thing")).toBe("core");
  });

  it("says nothing about a package outside this repo", () => {
    for (const pkg of ["zod", "hono", "react", "@types/node", "@hono/node-server", "typescript"]) {
      expect(packageWorkspace(pkg)).toBeUndefined();
    }
  });

  it("says nothing for the scope on its own", () => {
    // `@biu-cs-planner/` names no workspace, and an empty name would match no box while
    // still reading as a workspace to a caller checking only for `undefined`.
    expect(packageWorkspace("@biu-cs-planner/")).toBeUndefined();
    expect(packageWorkspace("@biu-cs-planner")).toBeUndefined();
  });
});

/**
 * A specifier says what it points at, and one rule answers for both consumers: `readModule`
 * sorts an import into `Module.imports` or `Module.packages` by it, and
 * `tools/pr-report/calls.ts` asks the same question of the specifier a *name* arrived on, to
 * find the module that declares it. Two readings of that rule were two places for it to
 * drift.
 */
describe("specifierTarget", () => {
  it("resolves a relative specifier against the module that writes it", () => {
    expect(specifierTarget("./dialect.ts", "core/src/shoham/import.ts")).toEqual({
      kind: "module",
      path: "core/src/shoham/dialect.ts",
    });
    expect(specifierTarget("../catalog/schema.ts", "core/src/shoham/import.ts")).toEqual({
      kind: "module",
      path: "core/src/catalog/schema.ts",
    });
  });

  it("reads a bare specifier as a package, this repo's own workspaces included", () => {
    expect(specifierTarget("@biu-cs-planner/core", "app/src/queries.ts")).toEqual({
      kind: "package",
      name: "@biu-cs-planner/core",
    });
    expect(specifierTarget("zod", "app/src/queries.ts")).toEqual({ kind: "package", name: "zod" });
  });

  it("reads a `node:` specifier as the platform, which is in no graph", () => {
    expect(specifierTarget("node:fs/promises", "app/src/workspace.fs.ts")).toEqual({
      kind: "builtin",
    });
  });
});

/**
 * Where a name comes from, as data rather than as the rendered `"(re-exported)"`.
 *
 * `tools/pr-report/calls.ts` resolves a call to the module that **declares** the function, so
 * a barrel is the one thing between a caller's import and that module. Before #86 it had no
 * way to tell a re-export from a declaration, and the call graph ended paths at whichever of
 * the two the alphabet handed it.
 */
describe("where an exported name comes from", () => {
  const exportsOf = (lines: readonly string[]) =>
    moduleFromSource("core/src/index.ts", lines).exports.map(
      (e) => `${e.name}:${e.from ? `${e.from.specifier}#${e.from.name}` : "(declared here)"}`,
    );

  it("records the module a local re-export comes from, repo-relative", () => {
    expect(exportsOf(['export { importRawCrawl } from "./shoham/import.ts";'])).toEqual([
      "importRawCrawl:core/src/shoham/import.ts#importRawCrawl",
    ]);
  });

  it("records the package name when a re-export comes from one", () => {
    expect(exportsOf(['export { thing } from "@biu-cs-planner/core";'])).toEqual([
      "thing:@biu-cs-planner/core#thing",
    ]);
  });

  it("records the name the other end knows, not the one this module exports", () => {
    // `export { a as b }` exports `b`, and `m.ts` has never heard of `b`. A consumer given the
    // module alone would go looking for a name that is not there and conclude nothing is.
    expect(exportsOf(['export { groupKey as key } from "./shoham/changes.ts";'])).toEqual([
      "key:core/src/shoham/changes.ts#groupKey",
    ]);
  });

  it("follows a from-less `export type { X }` to the type-only import that brought it in", () => {
    // The five names #124 counted. `importBindings` skipped every type-only binding, so these
    // came out with no `from` at all — and absent is the sentence "this module declares the
    // name", which is false. Harmless while nothing followed `from`; a mis-attribution the
    // moment `resolveReExports` did.
    expect(
      exportsOf([
        'import type { RawCrawlMeta } from "./shoham/raw-crawl.ts";',
        "export type { RawCrawlMeta };",
      ]),
    ).toEqual(["RawCrawlMeta:core/src/shoham/raw-crawl.ts#RawCrawlMeta"]);
  });

  it("follows the inline from-less `export { type X }` the same way", () => {
    // The other spelling of the keyword, and the other spelling of the import. One answer.
    expect(
      exportsOf([
        'import { type Variant } from "./state/schema.ts";',
        "export { type Variant };",
      ]),
    ).toEqual(["Variant:core/src/state/schema.ts#Variant"]);
  });

  it("records an origin for every from-less type export this repository actually writes", () => {
    // Measured against the tree rather than described: #124 counted five, in three files, and
    // a count in a ticket body is exactly the thing that goes stale. What is pinned is that
    // none of them claims to declare the name.
    const files = ["core/src/shoham/meta.ts", "core/src/shoham/details.ts", "core/src/shoham/import.ts"];
    const unattributed = files.flatMap((file) =>
      readModule(resolve(ROOT, file), ROOT)
        .exports.filter((e) => e.from === undefined && e.signature === RE_EXPORTED)
        .map((e) => `${file}#${e.name}`),
    );

    expect(unattributed).toEqual([]);
  });

  it("follows an `export { x }` with no clause to the import that brought `x` in", () => {
    // The module does not declare `join`; it imported it. "Absent means declared here" is the
    // sentence `from` makes, and this is the case that would have made it false — `surface.ts`
    // itself ends with `export { join }`.
    expect(
      exportsOf(['import { join } from "node:path";', "export { join };"]),
    ).toEqual(["join:node:path#join"]);
  });

  it("keeps a `node:` specifier as written, since no other field records one", () => {
    // The platform is in no graph, so this resolves to no module — which is the truth. Absent
    // would have read as "this module declares it".
    expect(exportsOf(['export { readFileSync } from "node:fs";'])).toEqual([
      "readFileSync:node:fs#readFileSync",
    ]);
  });

  it("says nothing for a name the module declares itself", () => {
    expect(
      exportsOf(["export function groupKey(of: string): string {", "  return of;", "}"]),
    ).toEqual(["groupKey:(declared here)"]);
  });

  it("says nothing for a name this module both declares and exports in a clause", () => {
    // `export { groupKey }` where `groupKey` is declared here: nothing to follow, and the
    // module is the answer.
    expect(
      exportsOf([
        "function groupKey(of: string): string {",
        "  return of;",
        "}",
        "export { groupKey };",
      ]),
    ).toEqual(["groupKey:(declared here)"]);
  });
});

/**
 * What a re-exported name *is*, which the report reads to decide whether to show it among
 * the shapes the data takes.
 *
 * Every name in a re-export clause used to be recorded as a `const`, whatever the `type`
 * keyword sitting in the same line said (#92). A workspace's `index.ts` is one long re-export
 * clause, so that was 83 of this repository's types described to a reviewer as values — 46 in
 * `core/src/index.ts` alone — in the report `CLAUDE.md` sends them to before the diff.
 *
 * The spellings below are the ones this repository writes, and two of the cases quote a line
 * of it verbatim: the mixed clause is `app/src/index.ts:2` and the clause with no `from` is
 * `core/src/shoham/meta.ts:4`. The rename is not written anywhere here, and is included
 * because #86 made the *export* side of a rename carry a name and nothing yet asked whether it
 * also carries a kind.
 */
describe("what kind a re-exported name is", () => {
  const kindsOf = (lines: readonly string[]) =>
    moduleFromSource("core/src/index.ts", lines).exports.map((e) => `${e.name}:${e.kind}`);

  it("records `export type { X } from` as a type", () => {
    expect(kindsOf(['export type { Variant } from "./state/schema.ts";'])).toEqual([
      "Variant:type",
    ]);
  });

  it("records the inline `export { type X } from` as a type too", () => {
    // The spelling `web`'s edge into `server` is forbidden to use — it leaves a specifier in
    // the emit (#59) — and it names exactly what the other spelling names.
    expect(kindsOf(['export { type ApiType } from "./api.ts";'])).toEqual(["ApiType:type"]);
  });

  it("still records a re-exported value as a value", () => {
    expect(kindsOf(['export { importRawCrawl } from "./shoham/import.ts";'])).toEqual([
      "importRawCrawl:const",
    ]);
  });

  it("splits a mixed clause into one value and one type", () => {
    // `app/src/index.ts:2`, verbatim. One statement, two answers, which is why the keyword is
    // read per binding rather than per clause.
    expect(kindsOf(['export { importCrawl, type ImportResult } from "./catalog.ts";'])).toEqual([
      "importCrawl:const",
      "ImportResult:type",
    ]);
  });

  it("reads the keyword before the clause as covering every binding in it", () => {
    expect(
      kindsOf(["export type {", "  GroupChange,", "  RawCrawl,", '} from "./shoham/import.ts";']),
    ).toEqual(["GroupChange:type", "RawCrawl:type"]);
  });

  it("keeps a type a type when the export renames it", () => {
    expect(kindsOf(['export { type RawCrawl as Crawl } from "./shoham/raw-crawl.ts";'])).toEqual([
      "Crawl:type",
    ]);
  });

  it("reads a clause with no `from` the same way, in both spellings", () => {
    // `core/src/shoham/meta.ts:4` is the first form: a type imported above and exported again,
    // with no specifier on the export statement to read. Written at that module's own path, so
    // the relative imports resolve where the real ones do rather than one folder up.
    expect(
      moduleFromSource("core/src/shoham/meta.ts", [
        'import type { RawCrawlMeta } from "./raw-crawl.ts";',
        'import type { Provenance } from "../catalog/schema.ts";',
        "export type { RawCrawlMeta };",
        "export { type Provenance };",
      ]).exports.map((e) => `${e.name}:${e.kind}`),
    ).toEqual(["RawCrawlMeta:type", "Provenance:type"]);
  });

  it("reads the pair the grammar allows and the checker does not", () => {
    // `export type { type X }` is **not** a syntax error, which is why the `||` and not an
    // assertion: a parse-only pass raises nothing on it, and `readModule` is parse-only.
    // TypeScript rejects it at TS2207, from the checker, so `npm run typecheck` is what keeps
    // it out of this repository — and if one ever got in, the answer is still `type`.
    const line = 'export type { type Variant } from "./state/schema.ts";';
    expect(
      ts.transpileModule(line, {
        compilerOptions: { verbatimModuleSyntax: true, allowImportingTsExtensions: true },
        reportDiagnostics: true,
      }).diagnostics,
    ).toEqual([]);
    expect(kindsOf([line])).toEqual(["Variant:type"]);
  });

  it("leaves the signature a placeholder, because the shape is in another module", () => {
    // Deliberate, and #92 says so out loud rather than silently: following `from` to the
    // declaration needs every module already read and the package-entry map, which live in
    // `collect.ts`. `ExportedSymbol.signature` carries the reasoning.
    expect(
      moduleFromSource("core/src/index.ts", [
        'export type { Variant } from "./state/schema.ts";',
        'export { importRawCrawl } from "./shoham/import.ts";',
      ]).exports.map((e) => `${e.name}:${e.signature}`),
    ).toEqual(["Variant:(re-exported)", "importRawCrawl:(re-exported)"]);
  });

  it("reads a declared alias, interface, class, function and const as itself", () => {
    // The declaration branch, which this change does not touch, and which always answered
    // correctly. Here so that the word the two branches now agree on is asserted on both
    // sides: nothing in this file asserted a declaration's `kind` before.
    expect(
      kindsOf([
        "export type Variant = { name: string };",
        "export interface Shape { side: number }",
        "export class Refused extends Error {}",
        "export function pick(of: string): string {",
        "  return of;",
        "}",
        "export const DEFAULT = 1;",
      ]),
    ).toEqual([
      "Variant:type",
      "Shape:type",
      "Refused:class",
      "pick:function",
      "DEFAULT:const",
    ]);
  });
});

/**
 * The second pass: what a re-exported name *is* and what shape it has, which is knowable only
 * once every module has been read.
 *
 * #92 left both as placeholders deliberately and said so — `signature` was `"(re-exported)"`
 * for every name a barrel carries, so the report told a reviewer that `core` exports
 * `recordPick` and nothing whatever about what it takes or returns, for the names in
 * `index.ts`, which is precisely where a reader goes to learn what a workspace offers. #124 is
 * that follow-up.
 */
describe("a re-exported name's declaration", () => {
  /** `name:kind:signature` for every export of the module at `path`, after the second pass. */
  const resolvedIn = (
    path: string,
    files: Readonly<Record<string, readonly string[]>>,
    entries: ReadonlyMap<string, string> = new Map(),
  ): string[] =>
    resolveReExports(modulesFromSources(files), entries)
      .filter((m) => m.path === path)
      .flatMap((m) => m.exports.map((e) => `${e.name}:${e.kind}:${e.signature}`));

  /** A function to be at the far end of a chain, and the signature it should arrive with. */
  const DECLARED = [
    "export function importRawCrawl(crawl: string, root: string): number {",
    "  return crawl.length + root.length;",
    "}",
  ];
  const SIGNATURE = "(crawl: string, root: string) => number";

  it("reads a re-exported function's signature off its declaration", () => {
    expect(
      resolvedIn("core/src/index.ts", {
        "core/src/index.ts": ['export { importRawCrawl } from "./shoham/import.ts";'],
        "core/src/shoham/import.ts": DECLARED,
      }),
    ).toEqual([`importRawCrawl:function:${SIGNATURE}`]);
  });

  it("records a re-exported function as a function, where it used to say `const`", () => {
    // The consequence #92 measured and left: the kind fix told a type from a value and stopped
    // there, so every re-exported function and class read `const`. The kind here comes from the
    // declaration, so it is whatever the declaration is.
    expect(
      resolvedIn("core/src/index.ts", {
        "core/src/index.ts": [
          'export { importRawCrawl } from "./shoham/import.ts";',
          'export { StateFileUnwritableError } from "./state/file.ts";',
          'export { DEFAULT_PORT } from "./config.ts";',
        ],
        "core/src/shoham/import.ts": DECLARED,
        "core/src/state/file.ts": ["export class StateFileUnwritableError extends Error {}"],
        "core/src/config.ts": ["export const DEFAULT_PORT = 4317;"],
      }),
    ).toEqual([
      `importRawCrawl:function:${SIGNATURE}`,
      "StateFileUnwritableError:class:class",
      "DEFAULT_PORT:const:",
    ]);
  });

  it("reads a re-exported type's shape, which is the whole of what the shapes fold prints", () => {
    expect(
      resolvedIn("core/src/index.ts", {
        "core/src/index.ts": [
          'export type { Variant } from "./state/schema.ts";',
          'export type { Workspace } from "./workspace.ts";',
        ],
        "core/src/state/schema.ts": ["export type Variant = { name: string; primary: boolean };"],
        "core/src/workspace.ts": ["export interface Workspace { root: string }"],
      }),
    ).toEqual([
      "Variant:type:{ name: string; primary: boolean }",
      "Workspace:type:interface",
    ]);
  });

  it("keeps a `type`-keyword re-export a type, whatever the declaration turns out to be", () => {
    // `export type { Refused }` re-exports the type side of a class and nothing else. Taking
    // `class` from the far end would mislabel what this module offers and would put the name
    // back among the call targets `collect.ts` filters types out of.
    expect(
      resolvedIn("core/src/index.ts", {
        "core/src/index.ts": [
          'export type { Refused } from "./state/file.ts";',
          'export { type Thrown } from "./state/file.ts";',
        ],
        "core/src/state/file.ts": [
          "export class Refused extends Error {}",
          "export class Thrown extends Error {}",
        ],
      }),
    ).toEqual(["Refused:type:class", "Thrown:type:class"]);
  });

  it("follows a rename, because the far module has never heard of the exported name", () => {
    // `export { a as b }` and the declaration is `a`. `ExportOrigin` carries the name beside the
    // specifier for exactly this, and a walk that took the module alone would find nothing.
    expect(
      resolvedIn("core/src/index.ts", {
        "core/src/index.ts": ['export { importRawCrawl as importCrawl } from "./shoham/import.ts";'],
        "core/src/shoham/import.ts": DECLARED,
      }),
    ).toEqual([`importCrawl:function:${SIGNATURE}`]);
  });

  it("follows a chain of barrels to the end of it", () => {
    expect(
      resolvedIn("core/src/index.ts", {
        "core/src/index.ts": ['export { importRawCrawl } from "./shoham/index.ts";'],
        "core/src/shoham/index.ts": ['export { importRawCrawl } from "./import.ts";'],
        "core/src/shoham/import.ts": DECLARED,
      }),
    ).toEqual([`importRawCrawl:function:${SIGNATURE}`]);
  });

  it("crosses a workspace by the package entry, as a call does", () => {
    // The map `collect.ts` reads out of each workspace's `package.json`. Without it a barrel
    // that re-exports another workspace's name is a dead end.
    expect(
      resolvedIn(
        "app/src/index.ts",
        {
          "app/src/index.ts": ['export { importRawCrawl } from "@biu-cs-planner/core";'],
          "core/src/index.ts": ['export { importRawCrawl } from "./shoham/import.ts";'],
          "core/src/shoham/import.ts": DECLARED,
        },
        new Map([["@biu-cs-planner/core", "core/src/index.ts"]]),
      ),
    ).toEqual([`importRawCrawl:function:${SIGNATURE}`]);
  });

  it("terminates on a re-export cycle, leaving the placeholder rather than hanging", () => {
    // `a.ts` re-exporting from `b.ts` and back. The `seen` guard is what makes this a gap in
    // the record instead of a stack overflow; the cycle itself is a defect and
    // `tools/pr-review/cycles.ts` is what reports one.
    const cycle = {
      "core/src/a.ts": ['export { thing } from "./b.ts";'],
      "core/src/b.ts": ['export { thing } from "./a.ts";'],
    };

    expect(resolvedIn("core/src/a.ts", cycle)).toEqual([`thing:const:${RE_EXPORTED}`]);
    expect(resolvedIn("core/src/b.ts", cycle)).toEqual([`thing:const:${RE_EXPORTED}`]);
  });

  it("terminates on a one-module cycle too, where a barrel re-exports from itself", () => {
    expect(
      resolvedIn("core/src/a.ts", {
        "core/src/a.ts": ['export { thing } from "./a.ts";'],
      }),
    ).toEqual([`thing:const:${RE_EXPORTED}`]);
  });

  it("keeps the placeholder where the chain leaves this repository", () => {
    // `node:path` and a third-party package are in no graph, so there is no declaration to
    // read. `surface.ts` itself ends with `export { join }`. Saying `(re-exported)` here is
    // the truth — a shape this report never read — rather than the claim #124 was about.
    expect(
      resolvedIn("core/src/index.ts", {
        "core/src/index.ts": [
          'export { join } from "node:path";',
          'export { z } from "zod";',
        ],
      }),
    ).toEqual([`join:const:${RE_EXPORTED}`, `z:const:${RE_EXPORTED}`]);
  });

  it("keeps the placeholder where the far module does not export the name", () => {
    // A barrel that re-exports a name the target stopped declaring. `calls.ts`'s `UNRESOLVED`
    // is the same situation seen from the call graph.
    expect(
      resolvedIn("core/src/index.ts", {
        "core/src/index.ts": ['export { gone } from "./shoham/import.ts";'],
        "core/src/shoham/import.ts": DECLARED,
      }),
    ).toEqual([`gone:const:${RE_EXPORTED}`]);
  });

  it("leaves a declared name exactly as it was read", () => {
    expect(
      resolvedIn("core/src/shoham/import.ts", {
        "core/src/index.ts": ['export { importRawCrawl } from "./shoham/import.ts";'],
        "core/src/shoham/import.ts": DECLARED,
      }),
    ).toEqual([`importRawCrawl:function:${SIGNATURE}`]);
  });

  it("mutates nothing it was given, so two readers of the report see one answer", () => {
    // `collect.ts` hands the result to the renderer and to the call graph. A pass that edited
    // its input in place would make what the second reader saw depend on the order they read.
    const read = modulesFromSources({
      "core/src/index.ts": ['export { importRawCrawl } from "./shoham/import.ts";'],
      "core/src/shoham/import.ts": DECLARED,
    });
    const before = JSON.stringify(read);

    resolveReExports(read, new Map());

    expect(JSON.stringify(read)).toBe(before);
  });

  it("keeps the re-export walk in one module of the report's own source", () => {
    // #124 asks for one barrel-follower in the codebase. It lives in `surface.ts` because
    // `calls.ts` already imports that module, so a follower kept in `calls.ts` and imported
    // back would be a cycle in the very module graph this report draws. A canary rather than a
    // proof: it catches the walk being copied back, not a second one written under a new name.
    const defining = ["calls.ts", "collect.ts", "render.ts", "surface.ts", "main.ts"].filter((f) =>
      /(?:function|const)\s+declaringModule\b/.test(
        readFileSync(resolve(import.meta.dirname, f), "utf8"),
      ),
    );

    expect(defining).toEqual(["surface.ts"]);
  });
});
