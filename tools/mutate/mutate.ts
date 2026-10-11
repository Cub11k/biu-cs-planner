import { z } from "zod";

/**
 * Mutation checks from a spec (#364): the proof `orchestration.md` asks for — "delete the
 * implementation and watch it fail" — as one command, so every agent's result reads the same.
 *
 * A mutation is a file, a literal `from` and a literal `to`. Nothing here builds a pattern from
 * the spec (ADR-0007): `from` must occur exactly once in the file, compared as a string, so a
 * mutation cannot land somewhere its author did not look.
 *
 * Pure apart from the ports `main.ts` hands it.
 */

const mutationSchema = z.object({
  /** What the mutation breaks, as the table prints it. */
  name: z.string().min(1),
  /** Repo-relative path of the file to mutate. */
  file: z.string().min(1),
  from: z.string().min(1),
  to: z.string(),
  /** Test files that should catch it, as repo-relative paths; a failure elsewhere does not count. */
  tests: z.array(z.string().min(1)).min(1),
  /** Set when the author expects the tests not to notice, and says so; it then fails nothing. */
  expected: z.literal("survives").optional(),
});

export type Mutation = z.infer<typeof mutationSchema>;

const specSchema = z.object({ mutations: z.array(mutationSchema).min(1) });

/** A spec file's text as its mutations, or an error naming what is wrong with it. */
export function readSpec(text: string): Mutation[] {
  return specSchema.parse(JSON.parse(text)).mutations;
}

/** `source` with its one occurrence of `from` replaced by `to`. Throws on none or several. */
export function applyLiteral(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  if (at === -1) throw new Error(`not found: ${JSON.stringify(from)}`);
  if (source.indexOf(from, at + 1) !== -1) {
    throw new Error(`found more than once, so it does not say which: ${JSON.stringify(from)}`);
  }
  return source.slice(0, at) + to + source.slice(at + from.length);
}

/** What one run of a mutation's tests said. */
export type Verdict = { readonly caught: boolean; readonly failing?: string };

export type Outcome = Verdict & { readonly mutation: Mutation };

/** What `mutate` needs from the world: the files, and a way to run tests. */
export type Ports = {
  read(file: string): Promise<string>;
  write(file: string, text: string): Promise<void>;
  /** Puts the file back as it was read. */
  restore(file: string, original: string): Promise<void>;
  runTests(tests: readonly string[]): Promise<Verdict>;
};

/**
 * Applies each mutation, runs its tests and restores the file, in that order, one at a time.
 * The restore is in a `finally`: a run that throws still leaves the file as it was read.
 */
export async function mutate(mutations: readonly Mutation[], ports: Ports): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const mutation of mutations) {
    const original = await ports.read(mutation.file);
    const mutated = applyLiteral(original, mutation.from, mutation.to);
    try {
      await ports.write(mutation.file, mutated);
      outcomes.push({ mutation, ...(await ports.runTests(mutation.tests)) });
    } finally {
      await ports.restore(mutation.file, original);
    }
  }
  return outcomes;
}

/** The mutations that survived without the spec saying they would: each one fails the run. */
export const unexpectedSurvivors = (outcomes: readonly Outcome[]): Outcome[] =>
  outcomes.filter((outcome) => !outcome.caught && outcome.mutation.expected !== "survives");

/** One line per mutation: its name, caught or survived, and the first test that failed. */
export function table(outcomes: readonly Outcome[]): string {
  const rows = outcomes.map((outcome) => [
    outcome.mutation.name,
    outcome.caught
      ? "caught"
      : outcome.mutation.expected === "survives"
        ? "survived (expected)"
        : "SURVIVED",
    outcome.failing ?? "",
  ]);
  const header = ["mutation", "result", "failing test"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
