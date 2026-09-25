import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { importKind, mergeImports, type ImportRef } from "./surface.ts";

/**
 * The test titles, read out of the test files. Written as behaviour ("warns when a
 * detail record matches no Offering"), they read as a specification, which is the
 * point: the list below is what the code is claimed to do, and it was not written
 * by summarising anything.
 */
export type TestCase = {
  title: string;
  suite: string[];
  /**
   * How many tests the run collects for this one entry.
   *
   * One for an ordinary `it`. A parameterised `it.each(table)` runs once per row, and an
   * entry inside a `describe.each(table)` runs once per row of *that* table, so the number
   * is the product of every table around it. It exists because the count the report printed
   * under `Tests` was a count of entries, and an entry is not a test: nine files in this repo
   * parameterise a suite, and on the tree this field was added to, that total was **93
   * short** of what `npm test` ran (#140).
   */
  tests: number;
  /**
   * True when a table this entry is parameterised by could not be read from the source, so
   * `tests` counts that table as one row and the real number is at least this.
   *
   * Reported rather than smoothed over. A table built at runtime is the case the counting
   * approach in #140 cannot answer, and the choice there is between a number that is quietly
   * wrong and a number that says where it stops. The report says where it stops.
   */
  atLeast: boolean;
};

export type TestFile = {
  path: string;
  cases: TestCase[];
  /**
   * Local modules this test file imports: what it is a test *of*. What each import
   * carries is recorded here for the same reason it is on a module — the layering rule
   * judges a test file too, and a test may legitimately reach for a type where it may not
   * reach for a value, and must spell that reach the erasable way where the rule says so.
   */
  targets: ImportRef[];
};

/** Tests a set of files accounts for, and how much of that is a floor rather than a count. */
export type TestTotals = {
  /** Tests summed over every entry: the number a reader should take as "tests". */
  tests: number;
  /** Entries whose table could not be read. Where this is not zero, `tests` is a floor. */
  atLeast: number;
};

/**
 * The count the report prints, in one place rather than re-derived per section.
 *
 * `cases.length` is the wrong sum and was the defect: it counts entries. This sums what each
 * entry runs, and carries the number of entries it could not be sure about beside it, so no
 * caller can take the total without having been handed the caveat too.
 */
export function totalTests(files: readonly TestFile[]): TestTotals {
  let tests = 0;
  let atLeast = 0;
  for (const file of files) {
    for (const entry of file.cases) {
      tests += entry.tests;
      if (entry.atLeast) atLeast += 1;
    }
  }
  return { tests, atLeast };
}

const TEST_FNS = new Set(["it", "test"]);

/**
 * What a call is a call to, when it is a call to `it`, `test` or `describe`.
 *
 * Every modifier vitest offers is reached through one of two shapes: a property
 * (`it.only`, `describe.skip`) or a **call** on a property, which returns the function to
 * invoke (`it.each(table)(…)`, `it.skipIf(condition)(…)`). The second shape is why the count
 * was short by more than the `.each` tables: to the previous reading of this, the callee of
 * `it.skipIf(c)("title", fn)` was a call expression rather than an identifier, so the whole
 * entry was invisible — five tests in `server/src/token.test.ts` alone, not one of them
 * parameterised.
 */
type Invocation = {
  /** `it`, `test` or `describe`. */
  fn: string;
  /** What `.each` was handed, where the chain holds one, so its rows can be counted. */
  each?: ts.Expression;
  /**
   * True where the chain is parameterised in a way this reading does not count rows for: the
   * tagged-template table, `it.each` followed by a template. Marked rather than dropped, so
   * the entry comes out as a floor instead of coming out as one test.
   */
  eachUncounted?: boolean;
};

/** The name a modifier call is made through: `each` in `it.each(table)`, `""` for anything else. */
function modifierName(callee: ts.Expression): string {
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
}

/** The callee, unwrapped through properties and modifier calls to the function it names. */
function invocationOf(expression: ts.Expression): Invocation | undefined {
  if (ts.isIdentifier(expression)) return { fn: expression.text };

  // `it.only`, `describe.skip`, `it.concurrent` — a modifier that takes no arguments.
  if (ts.isPropertyAccessExpression(expression)) return invocationOf(expression.expression);

  // `it.each(table)`, `it.skipIf(condition)`, `it.concurrent.each(table)` — the modifier is
  // called, and what it returns is what gets the title. Only `each` changes the count.
  if (ts.isCallExpression(expression)) {
    const base = invocationOf(expression.expression);
    if (!base) return undefined;
    if (modifierName(expression.expression) !== "each") return base;
    const [table] = expression.arguments;
    // `.each()` with nothing in it is a table this reading cannot see either, and it is
    // marked as such rather than read as an entry that was never parameterised at all.
    return table ? { ...base, each: table } : { ...base, eachUncounted: true };
  }

  // A table written as a tagged template. Its rows are not counted here.
  if (ts.isTaggedTemplateExpression(expression)) {
    const base = invocationOf(expression.tag);
    if (!base) return undefined;
    return modifierName(expression.tag) === "each" ? { ...base, eachUncounted: true } : base;
  }

  return undefined;
}

/** `as const`, a `satisfies` and a pair of brackets, none of which is the table itself. */
function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** Every top-level `const` in a file, by the name it is bound to. */
function topLevelBindings(source: ts.SourceFile): Map<string, ts.Expression> {
  const bound = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        bound.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return bound;
}

/** Which file each name a module imports by name comes from, for relative imports only. */
function importedFrom(source: ts.SourceFile, absPath: string): Map<string, string> {
  const from = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    // Relative only. A table from a package is a table in somebody else's tree, and reaching
    // for one would make this count depend on what happens to be installed.
    if (!spec.startsWith(".")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      from.set(element.name.text, resolve(dirname(absPath), spec));
    }
  }
  return from;
}

/**
 * How many rows a table holds, where the source says, and `undefined` where it does not.
 *
 * Three shapes are read, because those are the three this repository writes:
 *
 * - the array written at the call site, `it.each([…])`, `as const` and all;
 * - a `const` in the same file, which is how the long tables are kept readable —
 *   `app/src/workspace.test.ts` keeps 16 accepted names and 26 refused ones that way;
 * - a `const` **one relative import away**, which is how `LANGUAGES` reaches the two
 *   `describe.each(LANGUAGES)` suites in `web` from `web/src/i18n/strings.ts`.
 *
 * One hop, and no further: the file it lands in is read for its own top-level `const`s and
 * not for another import to follow. A chain of re-exports comes out `undefined`, which the
 * report prints as a floor. The limit is deliberate — an unbounded walk would make the count
 * depend on how far a reading happened to get, and a floor that says so is worth more than a
 * number nobody can place.
 *
 * A spread inside the array (`[...rest, ["x"]]`) comes out `undefined` too: the element count
 * is not the row count there. Nothing is evaluated to find a length — this reads source, and
 * a table is data to interpret rather than to execute (ADR-0007).
 */
function rowsOf(table: ts.Expression, source: ts.SourceFile, absPath: string): number | undefined {
  const rowsIn = (expression: ts.Expression): number | undefined => {
    const node = unwrap(expression);
    if (!ts.isArrayLiteralExpression(node)) return undefined;
    return node.elements.some(ts.isSpreadElement) ? undefined : node.elements.length;
  };

  const node = unwrap(table);
  const atCallSite = rowsIn(node);
  if (atCallSite !== undefined) return atCallSite;
  if (!ts.isIdentifier(node)) return undefined;

  const local = topLevelBindings(source).get(node.text);
  if (local) {
    const rows = rowsIn(local);
    if (rows !== undefined) return rows;
  }

  const fromFile = importedFrom(source, absPath).get(node.text);
  if (fromFile === undefined) return undefined;
  let imported: ts.SourceFile;
  try {
    imported = ts.createSourceFile(
      fromFile,
      readFileSync(fromFile, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
  } catch {
    return undefined;
  }
  const bound = topLevelBindings(imported).get(node.text);
  return bound === undefined ? undefined : rowsIn(bound);
}

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
  // How many times the enclosing `describe`s run their bodies, and whether any of their
  // tables went unread. Both are restored around each `describe`, the way `suite` is.
  let repeat = 1;
  let repeatAtLeast = false;

  const titleOf = (call: ts.CallExpression): string | undefined => {
    const [first] = call.arguments;
    if (!first) return undefined;
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
    return undefined;
  };

  /** A table's rows, and whether the entry has to be reported as a floor. */
  const tableOf = (invocation: Invocation): { rows: number; atLeast: boolean } => {
    if (invocation.eachUncounted) return { rows: 1, atLeast: true };
    if (!invocation.each) return { rows: 1, atLeast: false };
    const rows = rowsOf(invocation.each, source, absPath);
    return rows === undefined ? { rows: 1, atLeast: true } : { rows, atLeast: false };
  };

  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith(".")) {
        targets.push({
          specifier: relative(root, resolve(dirname(absPath), spec)),
          ...importKind(node.importClause),
        });
      }
    }

    if (ts.isCallExpression(node)) {
      const invocation = invocationOf(node.expression);
      // The title is what makes this the entry rather than the modifier call inside it:
      // `it.each(TABLE)` is a call on `it` as well, and its first argument is the table.
      const title = invocation ? titleOf(node) : undefined;

      if (invocation && title !== undefined) {
        const table = tableOf(invocation);
        if (invocation.fn === "describe") {
          const outerRepeat = repeat;
          const outerAtLeast = repeatAtLeast;
          suite.push(title);
          repeat = outerRepeat * table.rows;
          repeatAtLeast = outerAtLeast || table.atLeast;
          node.forEachChild(walk);
          suite.pop();
          repeat = outerRepeat;
          repeatAtLeast = outerAtLeast;
          return;
        }
        if (TEST_FNS.has(invocation.fn)) {
          cases.push({
            title,
            suite: [...suite],
            tests: repeat * table.rows,
            atLeast: repeatAtLeast || table.atLeast,
          });
        }
      }
    }
    node.forEachChild(walk);
  };

  walk(source);
  return { path: relative(root, absPath), cases, targets: mergeImports(targets) };
}
