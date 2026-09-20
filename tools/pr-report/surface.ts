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
 * The two questions about an import that are not "where does it point".
 *
 * `typeOnly` answers whether anything but knowledge of shapes arrives. `erasable` answers
 * whether the statement leaves anything behind for a bundler to resolve, and it is the
 * stricter of the two: every erasable import is type-only, and not every type-only import
 * is erasable.
 *
 * The gap between them is `verbatimModuleSyntax`, which `tsconfig.base.json` sets.
 * TypeScript then emits import statements as written rather than working out what
 * survives, and where the `type` keyword sits decides the outcome. Each form emits:
 *
 * | written                             | emitted                   | erasable |
 * | ----------------------------------- | ------------------------- | -------- |
 * | `import type { X } from "./m.ts"`   | *nothing*                 | yes      |
 * | `import type * as ns from "./m.ts"` | *nothing*                 | yes      |
 * | `export type { X } from "./m.ts"`   | *nothing*                 | yes      |
 * | `import { type X } from "./m.ts"`   | `import {} from "./m.ts"` | no       |
 * | `export { type X } from "./m.ts"`   | `export {} from "./m.ts"` | no       |
 *
 * So the keyword *before* the clause — `import type`, `export type` — erases the statement
 * whatever binding follows it, and the keyword *on a binding inside* the clause does not:
 * the specifier stays, a bundler must resolve it, and whatever the target imports at its
 * top comes along. The two spellings read as synonyms and are not.
 *
 * That table is not a claim to take on trust. `surface.test.ts` runs `ts.transpileModule`
 * over these five lines and asserts these outputs, so a comment that drifts from the
 * compiler fails the build rather than misleading the next reader. Three details it pins:
 *
 * - The specifier keeps its `.ts`, because this repo sets `allowImportingTsExtensions` and
 *   not `rewriteRelativeImportExtensions`.
 * - *Nothing* means nothing **from the statement**. A file left with no other export picks
 *   up a bare `export {};` module marker, which says nothing about the import that was
 *   erased — so the test keeps a second export in every case, to tell the two apart.
 * - This repo's own `tsc` has `noEmit`, so it never writes any of this: the emit that
 *   reaches a browser is the bundler's. What the table is really about is the *shape of
 *   the statement*, which is what a bundler reads too.
 */
export type ImportKind =
  /** `import type` / `export type` before the clause: nothing but types, nothing emitted. */
  | { typeOnly: true; erasable: true }
  /** The inline `{ type X }`: nothing but types, and the specifier stays in the emit. */
  | { typeOnly: true; erasable: false }
  /** Anything else: code can travel along it. */
  | { typeOnly: false; erasable: false };

/**
 * One import: where it points, and what travels along it.
 *
 * `typeOnly` tells a dependency that only constrains shapes apart from one that carries
 * code, which the module graph draws differently. `erasable` is what a rule asks for when
 * it needs the target kept out of a bundle rather than merely out of the importer's
 * vocabulary; the layering rule (`tools/pr-review/layering.ts`) uses both.
 *
 * **`erasable` implies `typeOnly`, and `ImportKind` is a union of three states rather than
 * two free booleans so that the fourth cannot be written down.** That is not tidiness:
 * `forbiddenEdges` decides a narrowed edge on `erasable` alone, so a hand-built
 * `{ typeOnly: false, erasable: true }` would walk a *value* import from `web` to `server`
 * straight past the check with no finding at all. Three named states, and the bad one is a
 * type error at every construction site — the test helpers included.
 *
 * All of it is read from the syntax, not from a type checker: a module that writes
 * `import { Thing } from "./x"` and uses `Thing` only in a type position is recorded as a
 * value import, because that is what it says. Erring that way is the safe direction — a
 * rule that only permits type-only or erasable edges then asks for the import to say so.
 */
export type ImportRef = ImportKind & {
  /** Repo-relative path for a local import, the package name for a bare one. */
  specifier: string;
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

/** Nothing but types, and no specifier left in the emit either. */
const ERASED: ImportKind = { typeOnly: true, erasable: true };

/** Types only, but the specifier stays: the inline `type` keyword. */
const KEPT: ImportKind = { typeOnly: true, erasable: false };

/** Code can travel along it. */
const CODE: ImportKind = { typeOnly: false, erasable: false };

/**
 * A pair of booleans as one of the three legal states. `erasable` without `typeOnly` is not
 * a state this project has, so it resolves to `CODE` — the safe answer, and the one that
 * makes a narrowed edge fail rather than silently pass.
 */
const kindOf = (typeOnly: boolean, erasable: boolean): ImportKind =>
  !typeOnly ? CODE : erasable ? ERASED : KEPT;

/**
 * One entry per specifier, with the weaker statement winning on both counts.
 *
 * A module may name the same specifier twice — `import type { A } from "./x"` beside
 * `import { b } from "./x"` — and the graph has one arrow for the pair. What that arrow
 * has to answer is whether code can travel along it, so a single value import is enough
 * to make the edge a value edge.
 *
 * `erasable` merges the same way and separately, because the pair `import type { A }` and
 * `export { type A } from` is type-only twice over and still leaves a specifier in the
 * emit. An edge is erasable only when every statement naming it is.
 */
export function mergeImports(refs: readonly ImportRef[]): ImportRef[] {
  const merged = new Map<string, ImportKind>();
  for (const ref of refs) {
    const seen = merged.get(ref.specifier);
    merged.set(
      ref.specifier,
      // Both flags AND together, and `kindOf` puts the pair back into one of the three
      // legal states. Legal inputs cannot produce the illegal pair — `erasable` implies
      // `typeOnly` on each side, so it implies it on the conjunction — but `kindOf` is
      // what says so to the compiler rather than an assertion.
      kindOf(
        (seen?.typeOnly ?? true) && ref.typeOnly,
        (seen?.erasable ?? true) && ref.erasable,
      ),
    );
  }
  return [...merged].map(([specifier, kind]) => ({ specifier, ...kind }));
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
 * What an import statement carries and what it leaves behind.
 *
 * `import type` before the clause covers whatever follows it — a default binding, a
 * namespace, a named list — and is the one import form TypeScript erases outright, so it
 * is type-only *and* erasable. `type` on every element inside a named list says the same
 * thing about the bindings and nothing about the emit: type-only, not erasable. See
 * `ImportKind` for the table this was read off.
 *
 * Everything else is code: a default or namespace binding without the keyword, however
 * the names inside it are used, and a bare `import "./x"`, which is a side effect.
 */
export function importKind(clause: ts.ImportClause | undefined): ImportKind {
  if (!clause) return CODE;
  if (clause.isTypeOnly) return ERASED;
  if (clause.name) return CODE;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return CODE;
  return everyBindingIsType(bindings.elements) ? KEPT : CODE;
}

/**
 * The same question for a re-export, answered by the same rule, because the two forms
 * differ in exactly the same way: `export type { X } from "./y"` emits `export {};` and
 * loses the specifier, `export { type X } from "./y"` emits `export {} from "./y.js"` and
 * keeps it. `export * from "./y"` carries whatever `./y` has.
 */
function reExportKind(node: ts.ExportDeclaration): ImportKind {
  if (node.isTypeOnly) return ERASED;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return CODE;
  return everyBindingIsType(node.exportClause.elements) ? KEPT : CODE;
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

  const addSpecifier = (spec: string, kind: ImportKind) => {
    if (spec.startsWith(".")) {
      imports.push({ specifier: relative(root, resolve(dirname(absPath), spec)), ...kind });
    } else if (!spec.startsWith("node:")) {
      packages.push({ specifier: spec, ...kind });
    }
  };

  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addSpecifier(node.moduleSpecifier.text, importKind(node.importClause));
      continue;
    }
    // `export { x } from "./y"` re-exports: an edge, and the symbols travel with it
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addSpecifier(node.moduleSpecifier.text, reExportKind(node));
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
