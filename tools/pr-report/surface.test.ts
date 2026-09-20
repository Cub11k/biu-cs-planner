import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  mergeImports,
  packageWorkspace,
  readModule,
  type ImportKind,
  type ImportRef,
} from "./surface.ts";

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
