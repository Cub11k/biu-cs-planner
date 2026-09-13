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

export type Module = {
  /** Repo-relative, e.g. "core/src/shoham/import.ts". */
  path: string;
  workspace: string;
  exports: ExportedSymbol[];
  /** Repo-relative paths of local modules this one imports. */
  imports: string[];
  /** Package names imported, e.g. "zod", "hono". */
  packages: string[];
};

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

export function readModule(absPath: string, root: string): Module {
  const source = ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const exports: ExportedSymbol[] = [];
  const imports: string[] = [];
  const packages: string[] = [];

  const addSpecifier = (spec: string) => {
    if (spec.startsWith(".")) {
      imports.push(relative(root, resolve(dirname(absPath), spec)));
    } else if (!spec.startsWith("node:")) {
      packages.push(spec);
    }
  };

  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addSpecifier(node.moduleSpecifier.text);
      continue;
    }
    // `export { x } from "./y"` re-exports: an edge, and the symbols travel with it
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addSpecifier(node.moduleSpecifier.text);
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
    imports: [...new Set(imports)],
    packages: [...new Set(packages)],
  };
}

export const moduleName = (path: string): string =>
  path.replace(/^[^/]+\/src\//, "").replace(/\.ts$/, "");

export { join };
