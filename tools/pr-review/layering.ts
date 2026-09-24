import type { ImportRef, Module } from "../pr-report/surface.ts";
import type { TestFile } from "../pr-report/tests.ts";

/**
 * Which way the dependencies point. The other mechanical check
 * (`tools/pr-review/cycles.ts`) proves the module graph is a DAG, and a DAG is not the
 * guardrail this project has: `web` importing `core` is a straight, acyclic, one-way edge
 * that breaks the layering rule without closing a loop.
 *
 * So the rule is stated here the way `CLAUDE.md` and `docs/design.md` state it — as a
 * direction, and for one edge as a direction, a kind and a spelling — and every edge
 * outside it is a finding. Nothing here re-reads the source: the modules come from
 * `tools/pr-report/collect.ts`, the same ones the report and the cycle check describe.
 */

/** The four workspaces the layering rule governs, in the order they may depend. */
export const WORKSPACES = ["core", "app", "server", "web"] as const;

/**
 * Not the Workspace of `CONTEXT.md` — that is a student's folder of Catalogs and State
 * Files, and `app` exports a `Workspace` type for it. This is the npm sense, the one
 * `package.json` and `docs/design.md` use, so the name says which.
 */
export type WorkspaceName = (typeof WORKSPACES)[number];

/**
 * One edge the rule allows, and on what terms.
 *
 * A bare workspace name allows any import of it. The object form narrows the edge to
 * imports that are **erased from the emit** — `import type { ApiType } from "…"` and
 * `export type { ApiType } from "…"` satisfy it; `import { serve }` does not, and neither
 * does the inline `import { type ApiType }`, which carries only types but leaves a
 * specifier behind for a bundler to resolve (see `ImportKind` in
 * `tools/pr-report/surface.ts` for what each spelling emits).
 *
 * **There is only one strength of narrowing, and it is this one.** An entry could have
 * carried a choice — types-only, or types-only-and-erasable — and deliberately does not.
 * The reason to narrow an edge below "may import" is that code must not travel along it,
 * and the inline spelling lets code travel: the module is still reached and whatever it
 * imports at its top comes with it. A knob with one setting is not a knob, and a knob with
 * a default would let a later author weaken the narrowing by leaving a field out. Should
 * an edge ever genuinely want the inline form, adding the choice then — with the reason
 * written down — is cheap; discovering that a silent default was wrong is not.
 *
 * So `erasable: true` is the whole of the object form, and `erasable` rather than
 * `typeOnly` is its name because that is the question it asks. It implies type-only: a
 * value import fails it too, with its own sentence (see `ForbiddenEdge["kind"]`).
 */
export type AllowedImport =
  | WorkspaceName
  | { readonly workspace: WorkspaceName; readonly erasable: true };

/** An allowed edge in one shape, whichever way the table wrote it. */
const terms = (
  allowed: AllowedImport,
): { workspace: WorkspaceName; erasable: boolean } =>
  typeof allowed === "string" ? { workspace: allowed, erasable: false } : allowed;

/**
 * One workspace's half of the rule: who it may import, and the sentence a reader gets
 * when something imports what it may not.
 */
export type Layer = {
  workspace: WorkspaceName;
  /**
   * The edges this workspace may have, a bare name each unless the edge is narrower than
   * the workspace. Every other workspace edge is forbidden.
   */
  mayImport: readonly AllowedImport[];
  /**
   * The rule in one sentence, quoted back beside any edge that breaks it — every kind of
   * edge, so it stays a statement of the rule and leaves the specific remedy to `explain`.
   * A `web → core` finding should not have to read a paragraph about import spelling.
   */
  rule: string;
};

/**
 * The allowed edges, as data, in one place — read it against "Architecture" in
 * `docs/design.md` and "Code guardrails" in `CLAUDE.md`, which now state the narrowing on
 * `web → server` too, so the three say the same thing. This file stays the one the job
 * enforces; if it and the prose ever disagree again, the prose is the stale one and #59 is
 * the ticket that says why the narrowing is there at all.
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
    // The narrowest entry in the table, and the only one that reads the kind of import.
    // `web/src/api.ts` writes `import type { ApiType } from "@biu-cs-planner/server"` and
    // nothing else of `server` is meant to be known here — nor, since the entry asks for
    // the erasable spelling, to be left in the emit for a bundler to resolve. What each
    // spelling emits is in `ImportKind` in `tools/pr-report/surface.ts`. See #51, #59.
    workspace: "web",
    mayImport: [{ workspace: "server", erasable: true }],
    rule:
      "`web` knows only the HTTP API contract, which it learns from `server`'s exported " +
      "`ApiType`, so it may import types from `server` and nothing else — never a value " +
      "from `server`, only in the spelling that erases, and never `core` or `app` at all",
  },
];

/**
 * The whole rule as one sentence, generated from the table rather than written out
 * beside it. The clean-state line in the pull request comment used to restate it in
 * prose, which would have kept telling readers `web` knows only the API contract long
 * after someone edited `LAYERS` to say otherwise.
 */
export const summarise = (): string =>
  LAYERS.map((layer) => {
    if (layer.mayImport.length === 0) return `\`${layer.workspace}\` imports none of the others`;
    const allowed = layer.mayImport
      .map(terms)
      .map((t) => `\`${t.workspace}\`${t.erasable ? " for types only, written `import type`" : ""}`)
      .join(" and ");
    return `\`${layer.workspace}\` imports ${allowed}`;
  }).join(", ");

/**
 * Keyed by plain string rather than by `WorkspaceName`, so a path segment or a package
 * name read out of the source can be looked up directly without being asserted into the
 * type first.
 */
const BY_NAME: ReadonlyMap<string, Layer> = new Map(
  LAYERS.map((layer) => [layer.workspace, layer]),
);

/** The workspace a name refers to, if this project has one by that name. */
const workspaceNamed = (name: string): WorkspaceName | undefined =>
  BY_NAME.get(name)?.workspace;

/** An import that points somewhere the layering rule does not allow. */
export type ForbiddenEdge = {
  /** Repo-relative path of the file that writes the import. */
  from: string;
  /** The workspace that file belongs to. */
  fromWorkspace: WorkspaceName;
  /**
   * What it imports: the repo-relative path when the import was written as a relative
   * one, the package name when it was written as `@biu-cs-planner/…`.
   */
  imported: string;
  /** The workspace the import lands in. */
  toWorkspace: WorkspaceName;
  /**
   * Which part of the rule the edge breaks, and so which sentence a reader needs.
   *
   * - `"direction"` — the rule allows no edge from this workspace to that one at all.
   * - `"value"` — the rule narrows this edge to types, and this import carries code.
   * - `"spelling"` — the import carries only types, but in the inline `{ type X }` form,
   *   which `verbatimModuleSyntax` leaves in the emit. The knowledge is allowed; the
   *   statement surviving is not. The fix is one keyword and nothing else, which is why
   *   this is its own kind rather than another `"value"`.
   */
  kind: "direction" | "value" | "spelling";
  /** The rule this edge breaks, as one sentence. */
  rule: string;
};

/** The workspace a repo-relative module path lives in, if it lives in one at all. */
const workspaceOfPath = (path: string): WorkspaceName | undefined =>
  workspaceNamed(path.split("/")[0] ?? "");

/**
 * The workspace a bare package specifier names. Only this project's own workspaces
 * count: `zod`, `hono` and `react` say nothing about layering, and a scoped name that is
 * not one of the four (`@biu-cs-planner/tools`, say) is not a layer either.
 */
function workspaceOfPackage(specifier: string): WorkspaceName | undefined {
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
 * **A type-only import is still an import, unless an entry says otherwise.** The rule is
 * about what a workspace is allowed to *know*: a `web` module holding `import type { Plan }
 * from "@biu-cs-planner/core"` is coupled to `core`'s shapes and will break when they
 * change, however little of it reaches the browser. So a forbidden edge is forbidden in
 * either form, and only an entry that narrows the edge treats the two apart.
 *
 * One entry does. `web → server` exists for exactly one line — `import type { ApiType }` in
 * `web/src/api.ts`, the contract arriving, which is the typed client `CLAUDE.md` asks for —
 * and saying so in the table is what keeps the edge as narrow as the reason for it. A value
 * import from `web` to `server` is now a finding rather than a broken build discovered
 * later (#51).
 *
 * **And the narrowed edge asks for the erasable spelling, not merely a type-only one.**
 * `import type { X }` is erased outright; the inline `import { type X }` leaves a specifier
 * behind under `verbatimModuleSyntax`, so `server/src/index.ts` is still reached and
 * `workspace.fs.ts` → `node:fs/promises` comes with it. The two lines read as synonyms, so
 * #51's check — which asked only "does this carry types?" — would have passed the dangerous
 * one, and #59 was filed by its author rather than left to be found. A narrowed edge now
 * guards both halves at once: what `web` may know, and what a bundler can follow.
 *
 * That makes this a review-time reading of the source, not a build-time guarantee; the
 * other guard on the same failure is `web/package.json`, where `@biu-cs-planner/server` is
 * a *devDependency*.
 *
 * Both flags are read from the syntax by `tools/pr-report/surface.ts`, not from a type
 * checker, so an import that *could* have been written `import type` but was not is a
 * value import here. That is the safe direction to err in: the fix is to write what was
 * meant.
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
    imported: ImportRef,
    to: WorkspaceName | undefined,
  ): void => {
    // Anything outside the four — `tools/`, say — is not governed by this rule at all.
    const layer = BY_NAME.get(workspace);
    if (!layer || to === undefined || to === layer.workspace) return;
    const allowed = layer.mayImport.map(terms).find((t) => t.workspace === to);
    // A wide entry allows the edge outright; a narrowed one allows only the erased form.
    if (allowed && (!allowed.erasable || imported.erasable)) return;
    found.push({
      from,
      fromWorkspace: layer.workspace,
      imported: imported.specifier,
      toWorkspace: to,
      kind: !allowed ? "direction" : imported.typeOnly ? "spelling" : "value",
      rule: layer.rule,
    });
  };

  for (const module of modules) {
    for (const imported of module.imports) {
      judge(module.path, module.workspace, imported, workspaceOfPath(imported.specifier));
    }
    for (const imported of module.packages) {
      judge(module.path, module.workspace, imported, workspaceOfPackage(imported.specifier));
    }
  }

  for (const test of tests) {
    const workspace = test.path.split("/")[0] ?? "";
    for (const imported of test.targets) {
      judge(test.path, workspace, imported, workspaceOfPath(imported.specifier));
    }
  }

  return found.sort(
    (a, b) => a.from.localeCompare(b.from) || a.imported.localeCompare(b.imported),
  );
}

/**
 * One forbidden edge as a sentence: who imports what, and which rule that breaks. A
 * reader should never have to work out why an edge nobody listed is wrong — nor, when the
 * edge itself is allowed, why writing `import type` would have been enough. The spelling
 * sentence names the fix in the exact words that fix it, because "this import carries only
 * types and is still wrong" is the one finding here nobody would guess the remedy for. It
 * says "takes types from" rather than "imports": a `ForbiddenEdge` does not record whether
 * the statement was an `import` or an `export … from`, and both reach this branch.
 */
export const explain = (edge: ForbiddenEdge): string => {
  if (edge.kind === "spelling") {
    return (
      `\`${edge.from}\` takes types from \`${edge.imported}\` with the \`type\` keyword inside ` +
      `the clause, which \`verbatimModuleSyntax\` leaves in the emit as a specifier a bundler ` +
      `must resolve; write \`import type { … } from\` (or \`export type { … } from\`) instead, ` +
      `which is erased — ${edge.rule}.`
    );
  }
  if (edge.kind === "value") {
    return (
      `\`${edge.from}\` imports a value from \`${edge.imported}\`; \`${edge.fromWorkspace}\` may ` +
      `import only types from \`${edge.toWorkspace}\` — ${edge.rule}.`
    );
  }
  return (
    `\`${edge.from}\` imports \`${edge.imported}\`; \`${edge.fromWorkspace}\` may not import ` +
    `\`${edge.toWorkspace}\` — ${edge.rule}.`
  );
};
