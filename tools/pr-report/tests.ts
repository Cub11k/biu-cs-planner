import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { importIsTypeOnly, mergeImports, type ImportRef } from "./surface.ts";

/**
 * The test titles, read out of the test files. Written as behaviour ("warns when a
 * detail record matches no Offering"), they read as a specification, which is the
 * point: the list below is what the code is claimed to do, and it was not written
 * by summarising anything.
 */
export type TestCase = { title: string; suite: string[] };

export type TestFile = {
  path: string;
  cases: TestCase[];
  /**
   * Local modules this test file imports: what it is a test *of*. Type-only-ness is
   * recorded here for the same reason it is on a module — the layering rule judges a
   * test file too, and a test may legitimately reach for a type where it may not reach
   * for a value.
   */
  targets: ImportRef[];
};

const TEST_FNS = new Set(["it", "test"]);

export function readTestFile(absPath: string, root: string): TestFile {
  const source = ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const cases: TestCase[] = [];
  const targets: ImportRef[] = [];
  const suite: string[] = [];

  const titleOf = (call: ts.CallExpression): string | undefined => {
    const [first] = call.arguments;
    if (!first) return undefined;
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
    return undefined;
  };

  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith(".")) {
        targets.push({
          specifier: relative(root, resolve(dirname(absPath), spec)),
          typeOnly: importIsTypeOnly(node.importClause),
        });
      }
    }

    if (ts.isCallExpression(node)) {
      // `it.each(...)`, `describe.skip(...)` and friends still name the function first
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression
        : node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : "";

      if (name === "describe") {
        const title = titleOf(node);
        if (title !== undefined) {
          suite.push(title);
          node.forEachChild(walk);
          suite.pop();
          return;
        }
      }
      if (TEST_FNS.has(name)) {
        const title = titleOf(node);
        if (title !== undefined) cases.push({ title, suite: [...suite] });
      }
    }
    node.forEachChild(walk);
  };

  walk(source);
  return { path: relative(root, absPath), cases, targets: mergeImports(targets) };
}
