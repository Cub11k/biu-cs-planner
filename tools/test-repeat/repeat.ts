/**
 * Repeated runs of one test file (#364), the search `orchestration.md` asks for before a browser
 * test around an async answer is reported: many runs, under CPU load, with exact counts and the
 * first failure kept to look at.
 *
 * Pure apart from the `runOnce` and `keep` that `main.ts` hands it.
 */

export type Options = { readonly file: string; readonly times: number; readonly load: boolean };

/** `<test file> [--times N] [--load]`, in any order. Throws on anything else. */
export function parseArgs(argv: readonly string[]): Options {
  let file: string | undefined;
  let times = 20;
  let load = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--load") load = true;
    else if (arg === "--times") {
      times = Number(argv[(i += 1)]);
      if (!Number.isInteger(times) || times < 1) throw new Error("--times takes a whole number above 0");
    } else if (arg !== undefined && !arg.startsWith("-") && file === undefined) file = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (file === undefined) throw new Error("usage: npm run test:repeat -- <test file> [--times N] [--load]");
  return { file, times, load };
}

/** One run's result: whether every test passed, and what it printed. */
export type Attempt = { readonly passed: boolean; readonly output: string; readonly failed: readonly string[] };

export type Tally = {
  readonly passed: number;
  readonly failed: number;
  /** Each failing test's full name, with how many runs it failed in. */
  readonly failures: Readonly<Record<string, number>>;
};

/** Runs `runOnce` `times` times, handing the first failing run to `keep`. */
export async function repeat(
  times: number,
  runOnce: (index: number) => Promise<Attempt>,
  keep: (attempt: Attempt, index: number) => Promise<void>,
): Promise<Tally> {
  let passed = 0;
  let failed = 0;
  const failures: Record<string, number> = {};
  for (let index = 1; index <= times; index += 1) {
    const attempt = await runOnce(index);
    if (attempt.passed) {
      passed += 1;
      continue;
    }
    failed += 1;
    if (failed === 1) await keep(attempt, index);
    for (const name of attempt.failed) failures[name] = (failures[name] ?? 0) + 1;
  }
  return { passed, failed, failures };
}

/**
 * The failure screenshots a run's output names, as the reporter prints them under a failure:
 * `  - .vitest/attachments/failure-screenshots/<file>/<test>.png`. Read from the output rather
 * than from the folder, because Vitest leaves an unchanged screenshot's file as it was, so the
 * folder cannot say which of its files this run wrote.
 */
export const screenshotsIn = (output: string): string[] =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && line.includes("/failure-screenshots/") && line.endsWith(".png"))
    .map((line) => line.slice(2));
