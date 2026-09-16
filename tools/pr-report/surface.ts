import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * What a module exports and what it imports, read from the source rather than described
 * by hand. Everything here is derived: if the report and the code disagree, the report
 * is wrong and regenerating it fixes that.
 */
export type ExportedSymbol = {
  name: string;
  kind: "function" | "const" | "type" | "class";
  /** Rendered as written, e.g. "(crawl: RawCrawl, options: {...}) => {...}". */
  signature: string;
};

/**
 * One import, and whether anything of it can reach the running program.
 *
 * `typeOnly` is true when every binding the statement brings in is a type — written
 * `import type { X } from "…"`, `import { type X } from "…"`, or the same two forms of
 * `export … from`. It is what tells a dependency that only constrains shapes apart from
 * one that carries code, which the module graph draws differently and the layering rule
 * (`tools/pr-review/layering.ts`) is allowed to demand.
 *
 * It is read from the syntax, not from a type checker: a module that writes
 * `import { Thing } from "./x"` and uses `Thing` only in a type position is recorded as a
 * value import, because that is what it says. Erring that way is the safe direction — a
 * rule that only permits type-only edges then asks for the import to say so.
 */
export type ImportRef = {
  /** Repo-relative path for a local import, the package name for a bare one. */
  specifier: string;
  /** True when the statement brings in nothing but types. */
  typeOnly: boolean;
};

export type Module = {
  /** Repo-relative, e.g. "core/src/shoham/import.ts". */
  path: string;
  workspace: string;
  exports: ExportedSymbol[];
  /** Local modules this one imports, by repo-relative path. */
  imports: ImportRef[];
  /** Packages imported, e.g. "zod", "hono". */
  packages: ImportRef[];
};

/**
 * One entry per specifier, with a value import beating a type-only one.
 *
 * A module may name the same specifier twice — `import type { A } from "./x"` beside
 * `import { b } from "./x"` — and the graph has one arrow for the pair. What that arrow
 * has to answer is whether code can travel along it, so a single value import is enough
 * to make the edge a value edge.
 */
export function mergeImports(refs: readonly ImportRef[]): ImportRef[] {
  const merged = new Map<string, boolean>();
  for (const ref of refs) {
    merged.set(ref.specifier, (merged.get(ref.specifier) ?? true) && ref.typeOnly);
  }
  return [...merged].map(([specifier, typeOnly]) => ({ specifier, typeOnly }));
}

const text = (node: ts.Node | undefined, source: ts.SourceFile): string =>
  node ? node.getText(source).replace(/\s+/g, " ").trim() : "";

function signatureOf(node: ts.Node, source: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node)) {
    const params = node.parameters.map((p) => text(p, source)).join(", ");
    const returns = node.type ? text(node.type, source) : "void";
    return `(${params}) => ${returns}`;
  }
  if (ts.isTypeAliasDeclaration(node)) return text(node.type, source);
  if (ts.isVariableStatement(node)) {
    const d = node.declarationList.declarations[0];
    if (d?.type) return text(d.type, source);
    if (d?.initializer && ts.isArrowFunction(d.initializer)) {
      const params = d.initializer.parameters.map((p) => text(p, source)).join(", ");
      return `(${params}) => ${d.initializer.type ? text(d.initializer.type, source) : "…"}`;
    }
    return "";
  }
  return "";
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * Whether a named clause brings in nothing but types. Empty is not type-only: `import {}
 * from "./x"` and `export {} from "./x"` are run for their side effects, and a side
 * effect is code arriving.
 */
const everyBindingIsType = (
  elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[],
): boolean => elements.length > 0 && elements.every((el) => el.isTypeOnly);

/**
 * `import type { X }`, `import { type X }`, `import type * as ns` — all of them, and
 * nothing else. A default binding or a namespace binding is a value however the names
 * inside it are used, and a bare `import "./x"` is a side effect.
 *
 * The two spellings are not quite identical downstream. With `verbatimModuleSyntax` on,
 * which `tsconfig.base.json` sets, `import type { X } from "m"` disappears entirely while
 * `import { type X } from "m"` leaves `import "m"` behind, so the module is still
 * evaluated. Both are recorded type-only here because both carry only knowledge of
 * shapes, which is what the layering rule is about; a bundler pulling in a module for
 * its side effects is a build concern and #51 says so explicitly.
 */
export function importIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return false;
  return everyBindingIsType(bindings.elements);
}

/**
 * The same question for a re-export. `export type { X } from "./y"` and `export { type X
 * } from "./y"` carry only types; `export * from "./y"` carries whatever `./y` has.
 */
function reExportIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false;
  return everyBindingIsType(node.exportClause.elements);
}

export function readModule(absPath: string, root: string): Module {
  const source = ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const exports: ExportedSymbol[] = [];
  const imports: ImportRef[] = [];
  const packages: ImportRef[] = [];

  const addSpecifier = (spec: string, typeOnly: boolean) => {
    if (spec.startsWith(".")) {
      imports.push({ specifier: relative(root, resolve(dirname(absPath), spec)), typeOnly });
    } else if (!spec.startsWith("node:")) {
      packages.push({ specifier: spec, typeOnly });
    }
  };

  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addSpecifier(node.moduleSpecifier.text, importIsTypeOnly(node.importClause));
      continue;
    }
    // `export { x } from "./y"` re-exports: an edge, and the symbols travel with it
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addSpecifier(node.moduleSpecifier.text, reExportIsTypeOnly(node));
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          exports.push({ name: el.name.text, kind: "const", signature: "(re-exported)" });
        }
      }
      continue;
    }
    if (!isExported(node)) continue;

    if (ts.isFunctionDeclaration(node) && node.name) {
      exports.push({ name: node.name.text, kind: "function", signature: signatureOf(node, source) });
    } else if (ts.isTypeAliasDeclaration(node)) {
      exports.push({ name: node.name.text, kind: "type", signature: signatureOf(node, source) });
    } else if (ts.isInterfaceDeclaration(node)) {
      exports.push({ name: node.name.text, kind: "type", signature: "interface" });
    } else if (ts.isClassDeclaration(node) && node.name) {
      exports.push({ name: node.name.text, kind: "class", signature: "class" });
    } else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          exports.push({ name: d.name.text, kind: "const", signature: signatureOf(node, source) });
        }
      }
    }
  }

  const rel = relative(root, absPath);
  return {
    path: rel,
    workspace: rel.split("/")[0] ?? "",
    exports,
    imports: mergeImports(imports),
    packages: mergeImports(packages),
  };
}

export const moduleName = (path: string): string =>
  path.replace(/^[^/]+\/src\//, "").replace(/\.ts$/, "");

export { join };
