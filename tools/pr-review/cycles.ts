import type { CallEdge } from "../pr-report/calls.ts";
import type { Module } from "../pr-report/surface.ts";

/**
 * The mechanical half of the review: the dependency graphs must be directed acyclic
 * graphs. Nothing here is a judgement call, and nothing here re-reads the source — both
 * graphs come from `tools/pr-report`, so the review and the report cannot describe
 * different code.
 */

/** A cycle, written as the path through it: the first node repeated at the end. */
export type Cycle = readonly string[];

/** A cycle in the call graph, with the modules its functions live in. */
export type CallCycle = {
  path: Cycle;
  /** Repo-relative module paths the cycle passes through, in the order it meets them. */
  modules: readonly string[];
};

/**
 * Rotates a cycle so the alphabetically first node leads, so the same loop found from
 * two different starting points is recognised as one cycle.
 */
function canonical(cycle: Cycle): string {
  const ring = cycle.slice(0, -1);
  let lowest = 0;
  for (let i = 1; i < ring.length; i++) {
    if (ring[i]! < ring[lowest]!) lowest = i;
  }
  return [...ring.slice(lowest), ...ring.slice(0, lowest)].join(" → ");
}

/**
 * Every cycle a depth-first search meets, each as a path through it. One cycle per back
 * edge rather than every distinct loop in the graph — enumerating all of them is
 * exponential, and a reader only needs one path to see what closed the loop.
 *
 * Nodes and their edges are visited in sorted order, so the same graph always produces
 * the same list in the same order.
 */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): Cycle[] {
  const finished = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: Cycle[] = [];
  const seen = new Set<string>();

  const visit = (node: string): void => {
    stack.push(node);
    onStack.add(node);
    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (onStack.has(next)) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = canonical(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          found.push(cycle);
        }
      } else if (!finished.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    onStack.delete(node);
    finished.add(node);
  };

  for (const node of [...graph.keys()].sort()) {
    if (!finished.has(node)) visit(node);
  }
  return found;
}

/**
 * Cycles among the modules, as repo-relative paths. A module graph cycle is a finding
 * every time: it is how the layering rules (`core → app → server`, with `web` reaching
 * only the API) fail in practice, so a back edge is a broken guardrail.
 */
export function moduleCycles(modules: readonly Module[]): Cycle[] {
  const known = new Set(modules.map((m) => m.path));
  const graph = new Map<string, readonly string[]>();
  for (const m of modules) {
    graph.set(
      m.path,
      m.imports.filter((dep) => known.has(dep)),
    );
  }
  return findCycles(graph);
}

const moduleOf = (ref: string): string => ref.split("#")[0] ?? ref;

/**
 * Cycles among the functions, reported apart from the module ones because they are not
 * all defects — recursion is legitimate. What matters is which modules a loop crosses,
 * so each cycle carries them.
 *
 * The call graph records only calls that leave the module they are written in (see
 * `tools/pr-report/calls.ts`), so recursion that stays inside one file never appears
 * here and every cycle below crosses a module boundary.
 */
export function callCycles(edges: readonly CallEdge[]): CallCycle[] {
  const graph = new Map<string, string[]>();
  for (const e of edges) {
    graph.set(e.from, [...(graph.get(e.from) ?? []), e.to]);
    if (!graph.has(e.to)) graph.set(e.to, []);
  }

  return findCycles(graph).map((path) => {
    // Each module named once, in the order the cycle first reaches it. A loop that
    // leaves a module and comes back — `import → details → import → details → import`
    // — spans two modules, and listing four would have the reader counting wrong.
    const modules: string[] = [];
    for (const ref of path) {
      const mod = moduleOf(ref);
      if (!modules.includes(mod)) modules.push(mod);
    }
    return { path, modules };
  });
}
