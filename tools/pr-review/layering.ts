import type { Module } from "../pr-report/surface.ts";
import type { TestFile } from "../pr-report/tests.ts";

/**
 * Which way the dependencies point. The other mechanical check
 * (`tools/pr-review/cycles.ts`) proves the module graph is a DAG, and a DAG is not the
 * guardrail this project has: `web` importing `core` is a straight, acyclic, one-way edge
 * that breaks the layering rule without closing a loop.
 *
 * So the rule is stated here the way `CLAUDE.md` and `docs/design.md` state it — as a
 * direction — and every edge outside it is a finding. Nothing here re-reads the source:
 * the modules come from `tools/pr-report/collect.ts`, the same ones the report and the
 * cycle check describe.
 */

/** The four workspaces the layering rule governs, in the order they may depend. */
export const WORKSPACES = ["core", "app", "server", "web"] as const;

export type Workspace = (typeof WORKSPACES)[number];

/**
 * One workspace's half of the rule: who it may import, and the sentence a reader gets
 * when something imports what it may not.
 */
export type Layer = {
  workspace: Workspace;
  /** The workspaces this one may import. Every other workspace edge is forbidden. */
  mayImport: readonly Workspace[];
  /** The rule in one sentence, quoted back beside any edge that breaks it. */
  rule: string;
};

/**
 * The allowed edges, as data, in one place — read it against "Architecture" in
 * `docs/design.md` and "Code guardrails" in `CLAUDE.md` and the two should say the same
 * thing.
 *
 * "Nothing imports `web`" is not written as its own line because it does not need to be:
 * no layer below lists `web`, so every edge into `web` is already outside the set.
 */
export const LAYERS: readonly Layer[] = [
  {
    workspace: "core",
    mayImport: [],
    rule: "`core` is pure domain, so it imports nothing from `app`, `server` or `web`",
  },
  {
    workspace: "app",
    mayImport: ["core"],
    rule:
      "`app` is the use cases over `core`, so it may import `core` and nothing from " +
      "`server` or `web`",
  },
  {
    workspace: "server",
    mayImport: ["core", "app"],
    rule:
      "`server` exposes `app` over HTTP, so it may import `app` and `core` but nothing " +
      "from `web`",
  },
  {
    workspace: "web",
    mayImport: ["server"],
    rule:
      "`web` knows only the HTTP API contract, which it learns from `server`'s exported " +
      "`ApiType`, so it may never import `core` or `app`",
  },
];

/**
 * The whole rule as one sentence, generated from the table rather than written out
 * beside it. The clean-state line in the pull request comment used to restate it in
 * prose, which would have kept telling readers `web` knows only the API contract long
 * after someone edited `LAYERS` to say otherwise.
 */
export const summarise = (): string =>
  LAYERS.map((layer) =>
    layer.mayImport.length === 0
      ? `\`${layer.workspace}\` imports none of the others`
      : `\`${layer.workspace}\` imports ${layer.mayImport.map((w) => `\`${w}\``).join(" and ")}`,
  ).join(", ");

/**
 * Keyed by name rather than by `Workspace`, so a path segment or a package name read out
 * of the source can be looked up directly without being asserted into the type first.
 */
const BY_NAME: ReadonlyMap<string, Layer> = new Map(
  LAYERS.map((layer) => [layer.workspace, layer]),
);

/** The workspace a name refers to, if this project has one by that name. */
const workspaceNamed = (name: string): Workspace | undefined => BY_NAME.get(name)?.workspace;

/** An import that points somewhere the layering rule does not allow. */
export type ForbiddenEdge = {
  /** Repo-relative path of the file that writes the import. */
  from: string;
  /** The workspace that file belongs to. */
  fromWorkspace: Workspace;
  /**
   * What it imports: the repo-relative path when the import was written as a relative
   * one, the package name when it was written as `@biu-cs-planner/…`.
   */
  imported: string;
  /** The workspace the import lands in. */
  toWorkspace: Workspace;
  /** The rule this edge breaks, as one sentence. */
  rule: string;
};

/** The workspace a repo-relative module path lives in, if it lives in one at all. */
const workspaceOfPath = (path: string): Workspace | undefined =>
  workspaceNamed(path.split("/")[0] ?? "");

/**
 * The workspace a bare package specifier names. Only this project's own workspaces
 * count: `zod`, `hono` and `react` say nothing about layering, and a scoped name that is
 * not one of the four (`@biu-cs-planner/tools`, say) is not a layer either.
 */
function workspaceOfPackage(specifier: string): Workspace | undefined {
  if (!specifier.startsWith("@biu-cs-planner/")) return undefined;
  // A deep import, `@biu-cs-planner/core/thing`, still lands in `core`.
  const name = specifier.slice("@biu-cs-planner/".length).split("/")[0] ?? "";
  return workspaceNamed(name);
}

/**
 * Every workspace edge the rule does not allow, sorted so the same tree always produces
 * the same list. Test files are judged too, and separately, because `collect` keeps them
 * out of `modules` — a `web` test reaching into `core` is the same broken guardrail as a
 * `web` module doing it, and it would otherwise pass unseen.
 *
 * **Type-only imports count exactly as much as value ones.** The rule is about what a
 * workspace is allowed to *know*, not about what survives into a bundle: a `web` module
 * holding `import type { Plan } from "@biu-cs-planner/core"` is coupled to `core`'s
 * shapes and will break when they change, however little of it reaches the browser. That
 * is also why `web → server` is in the allowed set above — `import type { ApiType }` in
 * `web/src/api.ts` is the contract arriving, and it is deliberate, reviewed and named in
 * `docs/design.md`. Treating every import alike means that import keeps passing and a
 * type-only `web → core` still fails, which is the pair of answers the rule wants.
 *
 * The cost is that `web → server` is open in *both* directions of that trade: nothing here
 * stops `web` importing a runtime function out of `server` and pulling `node:fs` into the
 * browser bundle. Narrowing the edge to type-only imports would need `surface.ts` to record
 * which imports are type-only, which is a change to `tools/pr-report` and a ticket of its
 * own. Until then the narrower guard is `web/package.json`, where `@biu-cs-planner/server`
 * is a *devDependency* — nothing of it is meant to ship.
 *
 * Edges that leave the four workspaces altogether — an import of `tools/`, of `zod`, of
 * `node:fs` — are not judged here. This check is about the direction between workspaces
 * and nothing else; see "Not in this ticket" on #33.
 *
 * What it sees is what `tools/pr-report` records, and no more. Two blind spots come with
 * that, and both are the price of deriving the graphs once rather than three times:
 *
 * - Only the static `import` and `export … from` statements at the top of a file are
 *   recorded, so a dynamic `await import("…")` and an inline `import("…").Thing` type are
 *   in no graph at all — invisible to the report, to the cycle check and to this alike.
 * - A test file's *package* imports are not recorded — `tests.ts` keeps only the relative
 *   ones, because what it is really after is what each test is a test **of**. So
 *   `web/src/x.test.ts` reaching `../../core/src/y.ts` is caught and the same file writing
 *   `@biu-cs-planner/core` is not.
 */
export function forbiddenEdges(
  modules: readonly Module[],
  tests: readonly TestFile[],
): ForbiddenEdge[] {
  const found: ForbiddenEdge[] = [];

  const judge = (
    from: string,
    workspace: string,
    imported: string,
    to: Workspace | undefined,
  ): void => {
    // Anything outside the four — `tools/`, say — is not governed by this rule at all.
    const layer = BY_NAME.get(workspace);
    if (!layer || to === undefined || to === layer.workspace) return;
    if (layer.mayImport.includes(to)) return;
    found.push({
      from,
      fromWorkspace: layer.workspace,
      imported,
      toWorkspace: to,
      rule: layer.rule,
    });
  };

  for (const module of modules) {
    for (const imported of module.imports) {
      judge(module.path, module.workspace, imported, workspaceOfPath(imported));
    }
    for (const imported of module.packages) {
      judge(module.path, module.workspace, imported, workspaceOfPackage(imported));
    }
  }

  for (const test of tests) {
    const workspace = test.path.split("/")[0] ?? "";
    for (const imported of test.targets) {
      judge(test.path, workspace, imported, workspaceOfPath(imported));
    }
  }

  return found.sort(
    (a, b) => a.from.localeCompare(b.from) || a.imported.localeCompare(b.imported),
  );
}

/**
 * One forbidden edge as a sentence: who imports what, and which rule that breaks. A
 * reader should never have to work out why an edge nobody listed is wrong.
 */
export const explain = (edge: ForbiddenEdge): string =>
  `\`${edge.from}\` imports \`${edge.imported}\`; \`${edge.fromWorkspace}\` may not import ` +
  `\`${edge.toWorkspace}\` — ${edge.rule}.`;
