import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
  /**
   * Where the name comes from, when this module is not where it is declared:
   * `export { importRawCrawl } from "./shoham/import.ts"` records
   * `core/src/shoham/import.ts` and the name `importRawCrawl`.
   *
   * **Absent means this module declares the name.** Three things could have made that
   * sentence false and each is handled rather than excused:
   *
   * - `export { x }` with no `from` clause re-exports whatever `x` is *here*, which may be a
   *   name the module imported — `export { join }` beside `import { join } from "node:path"`.
   *   The module's own import bindings are read, so `from` points where the import does.
   * - A re-export from a `node:` builtin keeps the specifier as written, because
   *   `Module.imports` and `Module.packages` record builtins nowhere and a consumer would
   *   otherwise read the silence as "declared here". It resolves to no module, which is the
   *   truth: the platform is not in this graph.
   * - `export { a as b } from "./m.ts"` exports `b` and `m.ts` knows it as `a`, so the name is
   *   carried beside the specifier. A module alone would send a consumer looking for `b` in a
   *   file that exports no such thing.
   *
   * It exists because `signature` said `"(re-exported)"` and nothing else did: a re-export
   * was legible to a reader and not to code. `tools/pr-report/calls.ts` resolves a call to
   * the module that *declares* the function, and a barrel is the one thing standing between
   * the caller's import and that module, so it needs this as data rather than as a rendered
   * string it would have to sniff.
   */
  from?: ExportOrigin;
};

/**
 * One step of a re-export, as a pair: the module or package the name comes from, and the name
 * it is known by *there*.
 *
 * Both halves, because either alone is the weaker key that #86 was about. `specifier` follows
 * `ImportRef.specifier`'s convention — a repo-relative path for a module, the package name for
 * a bare import — with `node:` specifiers kept as written, which that field never holds.
 */
export type ExportOrigin = { specifier: string; name: string };

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

/** What a specifier names: a module in this repo, a package, or a Node builtin. */
export type SpecifierTarget =
  /** A file in this repo, by repo-relative path. */
  | { kind: "module"; path: string }
  /** A package by name, this repo's own workspaces included: `@biu-cs-planner/core`, `zod`. */
  | { kind: "package"; name: string }
  /** `node:fs`. In no graph: the platform is not part of this repo's shape. */
  | { kind: "builtin" };

/**
 * One rule, in one place, because two consumers ask it. `readModule` sorts an import into
 * `Module.imports` or `Module.packages` by the answer, and `tools/pr-report/calls.ts` asks the
 * same question of the specifier a *name* arrived on, to find the module that declares it.
 *
 * Answered from the text alone: a leading `.` is a file, `node:` is the platform, anything
 * else is a package. No file system is consulted, so a relative specifier that points nowhere
 * is still a `module` and the caller simply finds no module by that path.
 *
 * Repo-relative in, repo-relative out — `fromModule` is the importing module's own path, so a
 * `"../catalog/schema.ts"` written in `core/src/shoham/import.ts` comes back as
 * `core/src/catalog/schema.ts`.
 */
export function specifierTarget(specifier: string, fromModule: string): SpecifierTarget {
  if (specifier.startsWith(".")) {
    return { kind: "module", path: join(dirname(fromModule), specifier) };
  }
  if (specifier.startsWith("node:")) return { kind: "builtin" };
  return { kind: "package", name: specifier };
}

/**
 * The specifier as `ImportRef.specifier` and `ExportOrigin.specifier` spell it: a repo-relative
 * path for a module, the name for a package, and a `node:` specifier as written — which
 * `ImportRef` never holds, and which `ExportOrigin` holds so that a re-export from the platform
 * is not mistaken for a declaration.
 */
const specifierRef = (specifier: string, fromModule: string): string => {
  const target = specifierTarget(specifier, fromModule);
  return target.kind === "module" ? target.path : target.kind === "package" ? target.name : specifier;
};

/** A name an import statement binds, and what it stands for at the other end. */
export type ImportBinding = { specifier: string; imported: string };

/**
 * The names a module's import statements bind, each with the specifier it arrived on and the
 * name it has there.
 *
 * `Module.imports` answers "what does this module import" with one entry per specifier, which
 * is what a module graph needs and not what a *name* needs. Two consumers need the name:
 * `tools/pr-report/calls.ts` resolves a call by it, and `readModule` itself needs it for an
 * `export { x }` that re-exports something this module imported.
 *
 * Only what exists at run time and can be named: a type-only clause or binding is skipped, and
 * so are a default and a namespace binding — `ns.foo()` is a property access rather than an
 * identifier, and a default import names nothing at the other end that `readModule` records.
 * Neither form is written anywhere in this repo's four workspaces.
 */
export function importBindings(source: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    // `import type { … }` erases entirely: nothing it names exists at run time.
    if (node.importClause?.isTypeOnly) continue;
    const named = node.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (el.isTypeOnly) continue;
      bindings.set(el.name.text, {
        specifier: node.moduleSpecifier.text,
        imported: (el.propertyName ?? el.name).text,
      });
    }
  }
  return bindings;
}

export function readModule(absPath: string, root: string): Module {
  const source = ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const rel = relative(root, absPath);
  // Read before the statement loop rather than during it: `export { x }` may be written above
  // the `import { x }` it re-exports, and the answer must not depend on which comes first.
  const bindings = importBindings(source);
  const exports: ExportedSymbol[] = [];
  const imports: ImportRef[] = [];
  const packages: ImportRef[] = [];

  const addSpecifier = (spec: string, kind: ImportKind) => {
    const target = specifierTarget(spec, rel);
    if (target.kind === "module") imports.push({ specifier: target.path, ...kind });
    else if (target.kind === "package") packages.push({ specifier: target.name, ...kind });
  };

  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addSpecifier(node.moduleSpecifier.text, importKind(node.importClause));
      continue;
    }
    // `export { x } from "./y"` re-exports: an edge, and the symbols travel with it
    if (ts.isExportDeclaration(node)) {
      const spec =
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined;
      if (spec !== undefined) addSpecifier(spec, reExportKind(node));
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          // `export { a as b }` exports `b`; `a` is the name at the other end, whether the
          // other end is the `from` clause or one of this module's own imports.
          const local = (el.propertyName ?? el.name).text;
          const bound = spec === undefined ? bindings.get(local) : undefined;
          const from: ExportOrigin | undefined =
            spec !== undefined
              ? { specifier: specifierRef(spec, rel), name: local }
              : bound
                ? { specifier: specifierRef(bound.specifier, rel), name: bound.imported }
                : undefined;
          exports.push({
            name: el.name.text,
            kind: "const",
            signature: "(re-exported)",
            ...(from === undefined ? {} : { from }),
          });
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

/**
 * The npm scope this project's own workspaces are published under. A bare specifier that
 * starts with it names one of them; `zod`, `hono`, `react` and `@types/node` do not.
 */
const SCOPE = "@biu-cs-planner/";

/**
 * The workspace a bare specifier refers to, or `undefined` if it names something outside
 * this repo.
 *
 * `readModule` records a cross-workspace import under the name the source writes —
 * `@biu-cs-planner/core`, never `core/src/index.ts` — because that is what the statement
 * says and because the package boundary is the thing the layering rule is about. A
 * consumer that wants to place such an edge back in the tree needs the workspace name
 * back, and this is where that mapping lives for `tools/pr-report`. It sits beside
 * `moduleName` for the same reason: both turn a specifier into the label a reader
 * recognises.
 *
 * A deep import, `@biu-cs-planner/core/thing`, still lands in `core`. Whether this project
 * actually *has* a workspace by that name is the caller's question, not this function's —
 * the module graph answers it by checking the name against the workspaces it drew a box
 * for, so a stale `@biu-cs-planner/tools` gets no arrow rather than an invented node.
 */
export function packageWorkspace(specifier: string): string | undefined {
  if (!specifier.startsWith(SCOPE)) return undefined;
  return specifier.slice(SCOPE.length).split("/")[0] || undefined;
}

export { join };
