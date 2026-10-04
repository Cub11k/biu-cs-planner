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
  /**
   * What the name is, read from the syntax that declares or re-exports it.
   *
   * **A re-export answers this from the `type` keyword**, both spellings of it, so
   * `export type { Variant } from "./state/schema.ts"` and
   * `export { type ApiType } from "./api.ts"` are `type` exactly as a `type` alias and an
   * `interface` are. They were `const`, unconditionally, and since a barrel is where a
   * workspace says what it offers, that made 83 of this repository's types read as values in
   * the one artefact `CLAUDE.md` sends a reviewer to *before* the diff — 46 of them in
   * `core/src/index.ts` alone (#92).
   *
   * `const` is what `readModule` answers for every re-exported value, a function and a class
   * included, because telling those apart means reading the declaration in another module.
   * **`resolveReExports` is where that happens**, and after it a re-exported function reads
   * `function` and a re-exported class reads `class` (#124).
   *
   * `const` afterwards means one of two things, and the common one is simply that the name *is*
   * a const: all 19 of this repository's remaining `const` re-exports resolve to a real `const`
   * declaration — `core/src/index.ts`'s `catalogSchema`, `server/src/index.ts`'s
   * `DEFAULT_PORT`. The other is a chain that leaves this repository, a re-export of
   * `node:path`'s `join`, say, where there is no declaration to read; `signature` is what tells
   * the two apart, because only the second keeps `RE_EXPORTED`. There are none of those here
   * today. See `from`.
   */
  kind: "function" | "const" | "type" | "class";
  /**
   * Rendered as written, e.g. "(crawl: RawCrawl, options: {...}) => {...}".
   *
   * **A re-export has no declaration to read, so `readModule` writes `RE_EXPORTED` and
   * `resolveReExports` replaces it** with the signature of the module that declares the name.
   * The shape lives at the far end of the chain, so finding it needs every module already read
   * and the package-entry map that turns `@biu-cs-planner/core` into a path — neither of which
   * `readModule` has while it is looking at one file. That is why the work is a second pass
   * over `Module[]` rather than a branch in here, and why it follows the chain with
   * `declaringModule`, the same walk the call graph uses, rather than a second
   * barrel-follower (#92, #124).
   *
   * `RE_EXPORTED` is still what a reader sees where the chain ends outside this repository or
   * at a name the far module does not export. That is a placeholder for a shape this report
   * never read, which is a different sentence from the one #124 was filed about.
   */
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
  /**
   * The **end** of the re-export chain `from` is the first step of: the module that declares
   * the name, and the name it declares it under, which a rename along the way changes.
   *
   * Absent on a declaration — there is no chain — and absent on a re-export whose chain this
   * report could not walk to a declaration it read: one that leaves the repository
   * (`export { join } from "node:path"`), one that ends at a name the far module does not
   * export, and one that loops. Those are exactly the cases `signature` keeps `RE_EXPORTED`
   * for, so the two fields agree by construction rather than by a reader comparing them.
   *
   * **It is here so that no reader of the report has to follow the chain itself.** The shapes
   * fold lists one row per declared type and one pointer per barrel that carries it (#202),
   * and deciding which of the two a name is needs the far end of the chain. `render.ts` holds
   * no module map and no package entries, so without this field it would either grow a second
   * barrel-follower — the thing #124 put `declaringModule` in one place to prevent, and
   * `tools/pr-review/followers.ts` is the check that keeps it there — or sniff a rendered
   * string. `resolveReExports` has the answer in hand already and now writes it down.
   */
  declaredIn?: DeclarationSite;
};

/**
 * Where a name is declared: a repo-relative module path, and the name that module declares it
 * under.
 *
 * The end of a re-export chain, which `declaringModule` answers and `ExportedSymbol.declaredIn`
 * records. Deliberately **not** an `ExportOrigin`: that is *one step* of a chain and its
 * `specifier` may be a package name or a `node:` builtin, while this is always a module this
 * report read and holds a `Module` for.
 */
export type DeclarationSite = { path: string; name: string };

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
 * What `ExportedSymbol.signature` says while nothing has followed the re-export to its
 * declaration, and what it keeps saying where following it leads out of this repository.
 *
 * `readModule` writes it (once), and `resolveReExports` replaces it by *overwriting* rather
 * than by comparing against it: a resolved symbol takes the declaration's signature whatever
 * was there before, and an unresolved one keeps this because nothing wrote over it. So the
 * constant buys no branch — it buys the tests and this documentation naming the same string as
 * the one the code writes, instead of each spelling it out and drifting apart.
 */
export const RE_EXPORTED = "(re-exported)";

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

/**
 * Whether one binding of an export clause names a type — the question `ExportedSymbol.kind`
 * asks of a re-export, and the one thing it needs that the clause alone does not answer.
 *
 * Two places the keyword can sit and one meaning between them. `export type { X }` puts it
 * before the clause, where it covers every binding that follows; `export { type X }` puts it
 * on the binding, where it covers that one. #59 is about how sharply those two differ in what
 * they *emit* — `ImportKind` has the table — and they do not differ at all in what they
 * **name**, which is what `kind` is about. So this reads either spelling as a type, and the
 * mixed clause `export { importCrawl, type ImportResult } from "./catalog.ts"` (real, at
 * `app/src/index.ts:2`) records one value and one type.
 *
 * **Reading the keyword is enough only because a type re-export has to carry one.**
 * `tsconfig.base.json` sets `verbatimModuleSyntax` and `isolatedModules`, and either one alone
 * makes `export { SomeType } from "./m.ts"` an error — TS1205, "requires using `export type`".
 * Drop both and that line compiles again and lands here as a `const`, with nothing to warn
 * anybody. So what makes reading the keyword exhaustive is a compiler option, not the syntax.
 *
 * The two keywords cannot contradict each other in a repository that typechecks — but not
 * because the grammar forbids the pair. `export type { type X } from "./m.ts"` **parses
 * cleanly**; TypeScript rejects it from the checker, at TS2207, and `readModule` runs no
 * checker (`ts.createSourceFile` and nothing else). So it is `npm run typecheck` that keeps
 * such a line out of this repository, and the `||` below that answers `type` if one ever gets
 * in. `surface.test.ts` pins both halves, because the file this sits in made a point of not
 * asking a reader to take a compiler claim on trust.
 *
 * Deliberately per-binding rather than per-clause, unlike `reExportKind`: an edge in the
 * module graph is one answer for the whole statement, and an exported symbol is one answer
 * per name.
 */
const isTypeExport = (node: ts.ExportDeclaration, el: ts.ExportSpecifier): boolean =>
  node.isTypeOnly || el.isTypeOnly;

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
 * Which bindings `importBindings` reads.
 *
 * `"values"` is what a *call* is resolved against: a type cannot be called, so a type-only
 * clause or binding is not a candidate, and reading one would be an invitation to draw an edge
 * to it. `"names"` is what an *export clause* is resolved against, where the question is only
 * where a name came from, and a type came from somewhere exactly as a value did.
 *
 * Two readings rather than one because the narrower one is load-bearing: `calls.ts` states in
 * its own documentation that type-only bindings are skipped, and `"values"` is the default so
 * that the reading a new caller gets is the one that cannot invent a call edge.
 */
export type ImportBindingScope = "values" | "names";

/**
 * The names a module's import statements bind, each with the specifier it arrived on and the
 * name it has there.
 *
 * `Module.imports` answers "what does this module import" with one entry per specifier, which
 * is what a module graph needs and not what a *name* needs. Two consumers need the name:
 * `tools/pr-report/calls.ts` resolves a call by it, and `readModule` itself needs it for an
 * `export { x }` that re-exports something this module imported.
 *
 * A default and a namespace binding are skipped under either scope — `ns.foo()` is a property
 * access rather than an identifier, and a default import names nothing at the other end that
 * `readModule` records. Neither form is written anywhere in this repo's four workspaces.
 *
 * **Whether a type-only binding is read is the caller's question, and `scope` is where it is
 * asked.** Skipping one unconditionally is what made a from-less `export type { X }` record no
 * origin at all: `core/src/shoham/meta.ts` writes `import type { RawCrawlMeta }` and then
 * `export type { RawCrawlMeta };`, and with no binding to follow the symbol came out with no
 * `from` — which `ExportedSymbol.from` reads as "this module declares the name" (#124). Five
 * names in this repository said that falsely, and each would have resolved to the wrong module
 * the moment anything followed `from` to find a declaration. `resolveReExports` is that
 * anything.
 */
export function importBindings(
  source: ts.SourceFile,
  scope: ImportBindingScope = "values",
): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const valuesOnly = scope === "values";
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    // `import type { … }` erases entirely: nothing it names exists at run time.
    if (valuesOnly && node.importClause?.isTypeOnly) continue;
    const named = node.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (valuesOnly && el.isTypeOnly) continue;
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
  //
  // `"names"`, not the default: a from-less export clause asks where a name came from, and
  // `export type { RawCrawlMeta };` beside `import type { RawCrawlMeta }` is the case the
  // default reading cannot answer. See `ImportBindingScope`.
  const bindings = importBindings(source, "names");
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
            kind: isTypeExport(node, el) ? "type" : "const",
            signature: RE_EXPORTED,
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

/**
 * One module's exported names, each mapped to where the name comes from: `null` when the
 * module declares it, and an `ExportOrigin` — a specifier *and* the name at the other end —
 * when it re-exports it.
 */
export type ExportedNames = ReadonlyMap<string, ExportOrigin | null>;

/**
 * What a re-export chain is followed against: every module read, and the module a bare import
 * of one of this repo's own packages reaches.
 *
 * Every key identifies exactly one thing — a module by its path, a package by its name — and
 * **nothing is keyed by a name**, which is #86's fix and the reason `declaringModule` can be
 * trusted by two callers at once. `CallTargets` is this plus the workspaces a call needs, and
 * satisfies it structurally.
 */
export type ModuleOrigins = {
  /**
   * Every module read, by repo-relative path.
   *
   * **How full each module's name map is, is the caller's question rather than this type's**,
   * and the two callers answer it differently: `resolveReExports` puts every export in, because
   * a type has a shape to go and read, while `collect.ts`'s `exportedNames` keeps only what is
   * not a type, because a type is not a callee. So the same walk stops dead at a type name for
   * the call graph and follows it for the surface pass, which is what each of them wants.
   */
  modules: ReadonlyMap<string, ExportedNames>;
  /**
   * Package name to the module a bare import of it reaches, from the manifest's `exports`.
   * A workspace whose manifest gives no single entry — `web`'s gives none at all — is absent.
   */
  entries: ReadonlyMap<string, string>;
};

/**
 * The module that declares a name, reached from a specifier and following re-exports, with the
 * name that module knows it by — which a rename along the way changes.
 *
 * A module path is looked up before a package name, and the two cannot collide: a path names
 * a file inside a workspace and a package name never does.
 *
 * `seen` ends a re-export loop — `a.ts` re-exporting a name from `b.ts` and back — with no
 * answer rather than with no return. Such a loop is a defect and
 * `tools/pr-review/cycles.ts` is what reports one; this function's job is only to not hang.
 *
 * **The one barrel-follower in this codebase**, and it lives here rather than in `calls.ts`
 * because two things follow a chain now: the call graph, to find the function a call lands on,
 * and `resolveReExports`, to find the declaration a signature is read from. `calls.ts` already
 * imports this module, so a follower kept there and imported back would be a cycle in the very
 * module graph this report draws (#124).
 */
export function declaringModule(
  ref: string,
  name: string,
  origins: ModuleOrigins,
  seen: Set<string>,
): DeclarationSite | undefined {
  const path = origins.modules.has(ref) ? ref : origins.entries.get(ref);
  if (path === undefined) return undefined;

  const key = `${path}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  const names = origins.modules.get(path);
  if (!names || !names.has(name)) return undefined;

  const origin = names.get(name) ?? null;
  return origin === null
    ? { path, name }
    : declaringModule(origin.specifier, origin.name, origins, seen);
}

/**
 * The second pass: every re-exported name given the `kind` and the `signature` of the
 * declaration it stands for.
 *
 * `readModule` holds one file at a time and cannot answer this — the shape is in the module the
 * name comes from, and reaching it needs every module already read and the package entries that
 * turn `@biu-cs-planner/core` into a path. So this runs over the whole of `Module[]`, which is
 * what `collect.ts` has, and follows each `from` with `declaringModule` to the module that
 * declares the name.
 *
 * What it deliberately leaves alone:
 *
 * - **A name whose chain leaves this repository.** `export { join } from "node:path"` and a
 *   re-export of a third-party name resolve to no module, so the symbol keeps `RE_EXPORTED`
 *   and `const`. The report then says it read no shape for the name, which is true.
 * - **A chain that loops.** `declaringModule`'s `seen` set returns no answer, and no answer
 *   leaves the placeholder — a defect in the source shows up as a gap here and as a finding in
 *   `tools/pr-review/cycles.ts`, which is what a cycle is reported by.
 * - **`from` itself.** Where a name came from stays recorded as the one step it is; this fills
 *   in what is at the end of the steps — the shape, the kind, and in `declaredIn` the module
 *   the walk ended at — and the call graph still walks them one at a time.
 * - **A `type` keyword on the clause.** Written of a class — `export type { Refused } from
 *   "./file.ts"`, which no workspace here writes today; `app/src/index.ts:55` re-exports
 *   `StateFileChangedError` as a value — the clause re-exports the type side of it and nothing
 *   else. So the clause is what decides what *this* module offers and the declaration only
 *   decides what shape it has. Taking `class`
 *   from the far end would both mislabel the name and put it back among the call targets
 *   `collect.ts` filters types out of — a re-export that a value import could never reach,
 *   recorded as one a call could land on.
 *
 * Pure: new `Module` objects, new `exports` arrays, nothing mutated. `collect.ts` hands the
 * result to the renderer *and* to the call graph, so a pass that edited its input in place
 * would decide by reading order what the second reader saw.
 */
export function resolveReExports(
  modules: readonly Module[],
  entries: ReadonlyMap<string, string>,
): Module[] {
  const origins: ModuleOrigins = {
    modules: new Map(
      modules.map((m) => [m.path, new Map(m.exports.map((e) => [e.name, e.from ?? null]))]),
    ),
    entries,
  };
  // Only what a module declares, keyed by the pair that identifies it. A re-export is never an
  // answer here: `declaringModule` returns the end of the chain, and the end of a chain is a
  // declaration by definition.
  const declared = new Map<string, ExportedSymbol>();
  for (const m of modules) {
    for (const e of m.exports) if (e.from === undefined) declared.set(`${m.path}#${e.name}`, e);
  }

  return modules.map((m) => ({
    ...m,
    exports: m.exports.map((e) => {
      if (e.from === undefined) return e;
      const owner = declaringModule(e.from.specifier, e.from.name, origins, new Set());
      const decl = owner && declared.get(`${owner.path}#${owner.name}`);
      if (!decl) return e;
      // The clause's own `type` keyword wins over the declaration's kind, and only over that.
      // `declaredIn` is the `owner` this pass already had to compute, written down rather than
      // thrown away: it is set on exactly the symbols whose `signature` stops being
      // `RE_EXPORTED`, so "the chain was walked" is one fact with one field (#202).
      return {
        ...e,
        kind: e.kind === "type" ? "type" : decl.kind,
        signature: decl.signature,
        declaredIn: owner,
      };
    }),
  }));
}

/**
 * The name a *section* of the report calls a module: the workspace, then the path inside it,
 * and the workspace alone for its entry point.
 *
 * **It has to tell two modules with the same basename apart, and that is the whole of #125.**
 * Every workspace's entry point is `src/index.ts`, so stripping the workspace off reduced
 * `core/src/index.ts`, `app/src/index.ts` and `server/src/index.ts` to the one word `index` —
 * and once #101 gave those sections real content the report carried three folds headed
 * `**index**` with nothing but sort order to tell them apart. A reader looking for what `app`
 * exposes had to count.
 *
 * So: `core/src/index.ts` is `core`, `core/src/shoham/import.ts` is `core/shoham/import`, and
 * a path with no `src/` segment — `tools/pr-report/render.ts` — comes through as
 * `tools/pr-report/render`, unchanged. The mapping drops the `src/` segment and a root `index`,
 * and nothing else, so no two of the paths this report walks share an answer.
 *
 * **No `tools/` path reaches here today**, and the case is kept against the day one does.
 * `TEST_ONLY_DIRS` brings `tools/` in for its test titles alone (#123) — `collect.ts` says
 * those directories get no module in either graph and no row in the coverage table, and the
 * titles fold prints the full `file.path` — so nothing currently runs such a path through this
 * function. The amendment on #125 asked for the case to be checked anyway, because a future
 * section that does would otherwise inherit the collapse across five roots instead of four.
 *
 * `.tsx` keeps its extension here, as it always did: `web/src/App.tsx` is `web/App.tsx`.
 * Stripping it would collapse a `scheme.ts` and a `scheme.tsx` in one folder into one name,
 * which is the defect this function exists to not have.
 *
 * `graphLabel` is the other spelling, for the one caller that has the workspace in hand
 * already.
 */
export const moduleName = (path: string): string => {
  const bare = path.replace(/\.ts$/, "");
  const inWorkspace = /^([^/]+)\/src\/(.*)$/.exec(bare);
  const workspace = inWorkspace?.[1];
  const rest = inWorkspace?.[2];
  if (workspace === undefined || rest === undefined) return bare;
  return rest === "index" ? workspace : `${workspace}/${rest}`;
};

/**
 * The name a *graph node* calls a module: the path inside its workspace, and nothing of the
 * workspace itself.
 *
 * Diverged from `moduleName` deliberately, and this is the caller #125 said to check: the
 * module map draws every node inside a `subgraph` labelled with the workspace, so the
 * workspace is already on the screen beside the node and repeating it would read as
 * `core` inside a box called `core`. Shortness is what a flowchart label is judged on, and
 * ambiguity is what the box already answers.
 *
 * Every other caller — a fold heading, a coverage row, a call-graph node, none of which sits
 * inside a workspace box — takes `moduleName`.
 */
export const graphLabel = (path: string): string =>
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
