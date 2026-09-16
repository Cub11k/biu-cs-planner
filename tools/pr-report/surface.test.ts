import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeImports, readModule, type ImportRef } from "./surface.ts";

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

/** Every import the module records, local and package alike, as `specifier:type|value`. */
const kinds = (lines: readonly string[]): string[] => {
  const module = moduleFromSource("web/src/subject.ts", lines);
  return [...module.imports, ...module.packages].map(
    (ref) => `${ref.specifier}:${ref.typeOnly ? "type" : "value"}`,
  );
};

describe("whether an import carries only types", () => {
  it("reads `import type { X }` as type-only", () => {
    expect(kinds(['import type { ApiType } from "@biu-cs-planner/server";'])).toEqual([
      "@biu-cs-planner/server:type",
    ]);
  });

  it("reads the inline `import { type X }` form as type-only too", () => {
    // Same meaning, different spelling. Missing it would make the narrower rule depend on
    // which of two equivalent lines an author happened to write.
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

describe("mergeImports", () => {
  const ref = (specifier: string, typeOnly: boolean): ImportRef => ({ specifier, typeOnly });

  it("keeps one entry per specifier, in the order first met", () => {
    expect(mergeImports([ref("./b.ts", false), ref("./a.ts", true), ref("./b.ts", true)])).toEqual([
      ref("./b.ts", false),
      ref("./a.ts", true),
    ]);
  });

  it("says nothing about an empty list", () => {
    expect(mergeImports([])).toEqual([]);
  });
});
