import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";
import {
  importBindings,
  packageWorkspace,
  specifierTarget,
  type ExportOrigin,
  type SpecifierTarget,
} from "./surface.ts";

/**
 * Which of the project's own functions call which.
 *
 * **A call is resolved through the calling module's own imports.** `foo()` means whatever
 * `foo` the module in hand imported, so the edge is found by reading the import statement
 * that binds the name and then following it to the module that *declares* it. Nothing is
 * keyed by bare function name, and nothing depends on the order the files are read in.
 *
 * It was, and that is why this file looks the way it does. A repo-wide `Map<name, module>`
 * resolved every call to whichever module exported that name **last**, so `groupKey` —
 * exported by `core/src/shoham/changes.ts` and, with a different signature and a different
 * meaning, by `web/src/timetable/week.ts` — put three edges from `core` into `web` in every
 * pull request report (#86). `core` calls nothing in `web` and could not: `web` is a leaf
 * that nothing imports. A reviewer is told to read that report *before* the diff, so the
 * graph was confidently drawing the most serious architectural violation this codebase
 * could hold, in the artefact meant to be trustworthy because it is mechanical. The
 * direction was an accident of the alphabet, too: read `core` last and the same bug drew
 * `web` calling into `core`, which is the absolute prohibition.
 *
 * Two modules exporting one name is legal and always was — nothing in the language stops it
 * — so the fix is not to detect the collision but to stop asking a question that has no
 * answer. The name alone never identified a function; the pair (module, name) does, and the
 * caller's import statement is where the module comes from.
 *
 * What this reads, and what it cannot:
 *
 * - **Named imports**, aliases included: `import { a as b } from "./m.ts"` binds `b` to
 *   `./m.ts`'s `a`, and a call to `b()` draws an edge to `m.ts#a`. An alias on the *export*
 *   side — `export { a as b } from "./m.ts"` — travels the same way, because
 *   `ExportedSymbol.from` carries the name as well as the module.
 * - **A barrel is followed to the declaration.** `import { createApi } from "./index.ts"`
 *   lands on `server/src/api.ts`, because `index.ts` re-exports the name rather than
 *   declaring it. A node here is a function where it is written, so a path through the code
 *   stays connected across a re-export instead of ending at a file that holds no code.
 * - **A cross-workspace call lands inside the other workspace**, by way of that package's
 *   entry module, which `collect.ts` reads from the workspace's `package.json`.
 * - **Type-only bindings are skipped.** A type cannot be called, so neither `import type { X }`
 *   nor the inline `import { type X }` binds anything here.
 * - **A namespace or default import is not read.** `importBindings` reads named imports only:
 *   `ns.foo()` is a property access rather than an identifier, and a default import names
 *   nothing at the other end, since `readModule` records no default export. This repo's four
 *   workspaces write neither form.
 * - **`export * from "./x.ts"` names nothing**, so `readModule` records no name for it and a
 *   call reached only through a star barrel is unresolved. There is no such re-export here.
 * - **A local shadow is invisible.** A `const groupKey = …` inside a function body hides an
 *   import for the length of that body, and seeing that needs a type checker rather than a
 *   syntax tree. Two modules exporting one name is the case this repo actually contains; a
 *   shadowed import is one it does not.
 */
export type CallEdge = { from: string; to: string };

/**
 * The `to` ref of a call that is this project's own and could not be placed in a module.
 *
 * Drawn rather than dropped. An edge quietly deleted is the same failure as an edge
 * confidently misdrawn — the report's silence reads as "there is nothing here" — so a call
 * whose callee this repo owns and whose module could not be found becomes a node saying
 * exactly that. There are none in this repository today. Among the ways one could appear: a
 * barrel that stops exporting a name someone still imports, a workspace imported as a package
 * with no `exports` entry to reach it by, a deep import (`@biu-cs-planner/core/thing`, which
 * `CallTargets.entries` is not keyed by), a star barrel, and a re-export loop.
 *
 * One node per name, not per call site: an unresolved node names a **question**, not a
 * function, so two modules that each lose the same name share it. That is the one place a
 * bare name is still a key here, and it is a key to "we could not say", which is the same
 * answer either way.
 *
 * This is **not** every call that fails to resolve. A call to a name the module does not
 * import at all is not an unresolved cross-module call: it is a function declared in the
 * same module, a parameter, or a language builtin like `Number`. This graph has only ever
 * held calls that leave the module they are written in — `tools/pr-review/cycles.ts` says so
 * and counts on it — so those are outside its definition rather than lost from it. A call
 * into a third-party package is outside it for the same reason, and the report says so:
 * "Library calls are left out." So is a call into a scoped name this repository does not
 * actually have a workspace for, which #83 ruled on for the module graph: no invented node.
 */
export const UNRESOLVED = "(unresolved)";

/**
 * One module's exported names, each mapped to where the name comes from: `null` when the
 * module declares it, and an `ExportOrigin` — a specifier *and* the name at the other end —
 * when it re-exports it.
 */
export type ExportedNames = ReadonlyMap<string, ExportOrigin | null>;

/**
 * Everything a call is resolved against. Every key here identifies exactly one thing: a module
 * by its path, a package by its name, a workspace by its name. **Nothing is keyed by a
 * function name**, which is the whole of the fix — a function name identifies nothing, so no
 * writer can take another's entry and no reading order can change an answer.
 */
export type CallTargets = {
  /** Every module read, by repo-relative path. */
  modules: ReadonlyMap<string, ExportedNames>;
  /**
   * Package name to the module a bare import of it reaches, from the manifest's `exports`.
   * A workspace whose manifest gives no single entry — `web`'s gives none at all — is absent.
   */
  entries: ReadonlyMap<string, string>;
  /**
   * The workspaces actually read, so a scoped name with no workspace behind it can be told
   * from one with. `@biu-cs-planner/tools` is not a workspace this report walks, and #83 ruled
   * for the module graph that such a name gets no node invented for it; the same holds here.
   */
  workspaces: ReadonlySet<string>;
};

/**
 * The ref a call resolves against — `ImportRef.specifier`'s spelling — or nothing when the
 * callee is not this repository's to place: a third-party package, the platform, or a scoped
 * name belonging to no workspace read.
 */
const ourRef = (target: SpecifierTarget, workspaces: ReadonlySet<string>): string | undefined => {
  if (target.kind === "module") return target.path;
  if (target.kind === "builtin") return undefined;
  const workspace = packageWorkspace(target.name);
  return workspace !== undefined && workspaces.has(workspace) ? target.name : undefined;
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
 */
function declaringModule(
  ref: string,
  name: string,
  targets: CallTargets,
  seen: Set<string>,
): { path: string; name: string } | undefined {
  const path = targets.modules.has(ref) ? ref : targets.entries.get(ref);
  if (path === undefined) return undefined;

  const key = `${path}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  const names = targets.modules.get(path);
  if (!names || !names.has(name)) return undefined;

  const origin = names.get(name) ?? null;
  return origin === null
    ? { path, name }
    : declaringModule(origin.specifier, origin.name, targets, seen);
}

export function readCalls(absPath: string, root: string, targets: CallTargets): CallEdge[] {
  const source = ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const self = relative(root, absPath);
  const bindings = importBindings(source);
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
      // No binding for the name: a function declared in this module, a parameter, or a
      // language builtin. None of those is a call that leaves the module. No ref either: the
      // callee is a library's or the platform's, and this graph holds neither.
      const binding = bindings.get(node.expression.text);
      const ref = binding && ourRef(specifierTarget(binding.specifier, self), targets.workspaces);
      if (binding && ref !== undefined) {
        const owner = declaringModule(ref, binding.imported, targets, new Set());
        // A barrel can lead back to the module the call is written in. That is still not a
        // call that leaves it, so it is still not an edge.
        if (owner?.path !== self) {
          const from = scope.length ? scope[scope.length - 1]! : "(module)";
          const to = owner ? `${owner.path}#${owner.name}` : `${UNRESOLVED}#${binding.imported}`;
          edges.push({ from: `${self}#${from}`, to });
        }
      }
    }

    node.forEachChild(walk);
    if (pushed) scope.pop();
  };

  walk(source);
  return edges;
}
