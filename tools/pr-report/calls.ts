import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";

/**
 * Which of the project's own functions call which. Derived by matching call
 * expressions against the set of names the project exports, so it shows the paths
 * through our code and ignores library calls.
 *
 * It is a name match, not a resolved one: two different modules exporting the same
 * name would be conflated. Nothing here does, and the report says so rather than
 * pretending to a precision it lacks.
 */
export type CallEdge = { from: string; to: string };

export function readCalls(
  absPath: string,
  root: string,
  known: Map<string, string>,
): CallEdge[] {
  const source = ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const self = relative(root, absPath);
  const edges: CallEdge[] = [];

  // the enclosing named function, so an edge starts somewhere meaningful
  const scope: string[] = [];

  const walk = (node: ts.Node): void => {
    let pushed = false;
    if (ts.isFunctionDeclaration(node) && node.name) {
      scope.push(node.name.text);
      pushed = true;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      scope.push(node.name.text);
      pushed = true;
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      const owner = known.get(callee);
      if (owner && owner !== self) {
        const from = scope.length ? scope[scope.length - 1]! : "(module)";
        edges.push({ from: `${self}#${from}`, to: `${owner}#${callee}` });
      }
    }

    node.forEachChild(walk);
    if (pushed) scope.pop();
  };

  walk(source);
  return edges;
}
