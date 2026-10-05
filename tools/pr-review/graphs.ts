import { SOURCE_DIRS } from "../pr-report/collect.ts";
import type { Report } from "../pr-report/render.ts";
import { callCycles, moduleCycles } from "./cycles.ts";
import { strayFollowers, type Source } from "./followers.ts";
import { forbiddenEdges } from "./layering.ts";
import type { Graphs } from "./render.ts";

/**
 * The four mechanical checks, as the one value the graph comment is rendered from.
 *
 * Here rather than inline in `main.ts`, because `main.ts` is a script that reads its environment
 * and talks to GitHub the moment it is imported, so nothing it wires can be tested. Pure, and
 * handed what `main.ts` reads: the graphs `tools/pr-report/collect.ts` derives from the four
 * workspaces, and the whole tree `readSources` walks — `strayFollowers` needs the second because
 * `collect` cannot see `tools/`, which is where the re-export walk lives (`./followers.ts`).
 */
export function graphsOf(
  derived: Pick<Report, "modules" | "edges" | "tests">,
  sources: readonly Source[],
): Graphs {
  return {
    moduleCycles: moduleCycles(derived.modules),
    callCycles: callCycles(derived.edges),
    forbidden: forbiddenEdges(derived.modules, derived.tests),
    followers: strayFollowers(sources),
    scope: SOURCE_DIRS,
  };
}
