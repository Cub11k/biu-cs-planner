import type { Module } from "../pr-report/surface.ts";

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
    rule: "`app` is the use cases over `core`, so it may import `core` and nothing from `server` or `web`",
  },
  {
    workspace: "server",
    mayImport: ["core", "app"],
    rule: "`server` exposes `app` over HTTP, so it may import `app` and `core` but nothing from `web`",
  },
  {
    workspace: "web",
    mayImport: ["server"],
    rule:
      "`web` knows only the HTTP API contract, which it learns from `server`'s exported " +
      "`ApiType`, so it may never import `core` or `app`",
  },
];

const BY_WORKSPACE = new Map(LAYERS.map((layer) => [layer.workspace, layer]));

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

const isWorkspace = (name: string): name is Workspace =>
  (WORKSPACES as readonly string[]).includes(name);

/** The workspace a repo-relative module path lives in, if it lives in one at all. */
function workspaceOfPath(path: string): Workspace | undefined {
  const first = path.split("/")[0] ?? "";
  return isWorkspace(first) ? first : undefined;
}

/**
 * The workspace a bare package specifier names. Only this project's own workspaces
 * count: `zod`, `hono` and `react` say nothing about layering, and a scoped name that is
 * not one of the four (`@biu-cs-planner/tools`, say) is not a layer either.
 */
function workspaceOfPackage(specifier: string): Workspace | undefined {
  const name = specifier.startsWith("@biu-cs-planner/")
    ? specifier.slice("@biu-cs-planner/".length)
    : "";
  // A deep import, `@biu-cs-planner/core/thing`, still lands in `core`.
  const first = name.split("/")[0] ?? "";
  return isWorkspace(first) ? first : undefined;
}

/**
 * Every workspace edge the rule does not allow, sorted so the same tree always produces
 * the same list.
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
 * Edges that leave the four workspaces altogether — an import of `tools/`, of `zod`, of
 * `node:fs` — are not judged here. This check is about the direction between workspaces
 * and nothing else; see "Not in this ticket" on #33.
 */
export function forbiddenEdges(modules: readonly Module[]): ForbiddenEdge[] {
  const found: ForbiddenEdge[] = [];

  for (const module of modules) {
    const layer = BY_WORKSPACE.get(module.workspace as Workspace);
    if (!layer) continue;

    const check = (imported: string, to: Workspace | undefined): void => {
      if (to === undefined || to === layer.workspace) return;
      if (layer.mayImport.includes(to)) return;
      found.push({
        from: module.path,
        fromWorkspace: layer.workspace,
        imported,
        toWorkspace: to,
        rule: layer.rule,
      });
    };

    for (const imported of module.imports) check(imported, workspaceOfPath(imported));
    for (const imported of module.packages) check(imported, workspaceOfPackage(imported));
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
