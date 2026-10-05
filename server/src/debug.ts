import { StateFileChangedError, WorkspaceRefusedError, type Workspace } from "@biu-cs-planner/app";

/**
 * The `--debug` log: the only log this app keeps (#165, ruled 2026-10-04).
 *
 * **The rule, in full, so the next reader does not have to reopen it:**
 *
 *   - **Off by default.** Nothing is logged unless the student starts the server with `--debug`.
 *     A planner that prints while it is used buries the one line the terminal is for, the launch
 *     URL, and a refusal already reaches the student as a named answer on screen.
 *   - **Destination: stderr**, of the terminal the server was started from. Never a file: a file in
 *     the Workspace would be data the app writes into the folder ADR-0003 says holds the student's
 *     documents, and a file anywhere else is one more thing to find and clean up.
 *   - **What it says:** for every `WorkspaceRefusedError` the Workspace port raises — each one a
 *     use case in `app` then catches and turns into a reason — its reason code, the errno, and its
 *     `cause` chain, which is where the adapter keeps the filesystem's own error. Not the external-
 *     edit guard's `StateFileChangedError`: it is a refusal too, but it has no errno and no cause,
 *     and the page already says everything about it there is to say. Nor the two refusals `app`
 *     makes without the port throwing: a revision a read hands back in no format the port has, and
 *     one a save hands back (`save-revision-unreadable`), both in `app/src/edit.ts`. Nothing was
 *     thrown for this wrapper to see, and neither has a cause to print. **The absolute Workspace
 *     path may appear**, because the log is opt-in and goes to the student's own terminal.
 *   - **What may never appear, in any mode: the launch token.** No refusal is about the token file,
 *     which lives outside the Workspace, so none should carry it — and every line is scrubbed of it
 *     anyway before it is written, so that staying true does not depend on every adapter.
 *   - **And every other error the port throws** (#357), `StateFileChangedError` still excepted:
 *     its name and message, the errno and the `cause` chain, scrubbed the same way. Since #324
 *     and #344 a read made after a landed save catches *any* failure — a refusal or not — and answers with the new revision and a marker
 *     instead of a 500, so a disk failing under the Catalog or `requirements/` after an edit was
 *     silent even under `--debug`, though it is what a student reporting "my edit seemed to fail"
 *     needs seen. Logged at the port, so it is every such throw rather than only the ones `app`
 *     then swallows: one that becomes a 500 is logged too, which costs a line and hides nothing.
 *     An error raised inside `app` without the port throwing is not seen here, as above.
 *   - **The page never sees any of it.** The answer on screen is unchanged; a `cause` is for this
 *     log and never for a response (ADR-0002).
 *
 * Logged at the port rather than at each `catch` in `app`, so a use case added later is covered
 * without remembering to be, and `app` stays free of a logging dependency.
 */
export type DebugLog = (line: string) => void;

/** How deep a `cause` chain is followed. A refusal wraps at most one more today (`BackupRefusedError`). */
const CAUSE_DEPTH = 5;

/** A value's own field, read so that a getter that throws costs the field and not the log line. */
function field(value: unknown, name: string): unknown {
  try {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;
  } catch {
    return undefined;
  }
}

/** One error in words: its name and message when it is an Error, and its string form otherwise. */
function said(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  } catch {
    return "(unprintable)";
  }
}

/** The first errno along an error's `cause` chain, and every `cause` below the error, in words. */
function chainOf(error: unknown): { errno: string | undefined; chain: string[] } {
  const chain: string[] = [];
  let errno: string | undefined;
  let at: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH && at !== undefined; depth += 1) {
    const code = field(at, "code");
    if (errno === undefined && typeof code === "string") errno = code;
    at = field(at, "cause");
    if (at !== undefined) chain.push(said(at));
  }
  return { errno, chain };
}

/** A line with its errno and cause chain appended, and the token scrubbed out last, whatever put it there. */
function finished(head: string, error: unknown, token: string): string {
  const { errno, chain } = chainOf(error);
  const line = `${head} errno=${errno ?? "none"}` + (chain.length === 0 ? "" : ` cause: ${chain.join(" <- ")}`);
  return token === "" ? line : line.split(token).join("[launch token]");
}

/**
 * The line for one refusal: the operation, the reason code, the first errno along the chain, and
 * every `cause` below the refusal. The token is scrubbed out last, whatever put it there.
 */
export function refusalLine(operation: string, error: WorkspaceRefusedError, token: string): string {
  const reason = field(field(error, "refusal"), "reason");
  return finished(
    `biu-cs-planner debug: ${operation} refused (${typeof reason === "string" ? reason : "no reason code"})`,
    error,
    token,
  );
}

/**
 * The line for any other error the port threw (#357): the operation, the error itself in words,
 * then the errno and cause chain as a refusal's line has them. Scrubbed of the token the same way —
 * a message is the likeliest place for a stray value to turn up.
 */
export function failureLine(operation: string, error: unknown, token: string): string {
  return finished(`biu-cs-planner debug: ${operation} failed (${said(error)})`, error, token);
}

/**
 * The Workspace, with every error it raises written to `log` on the way out and then rethrown
 * unchanged, so what every caller catches — and so what the page is answered — is exactly what it
 * would have been without `--debug`. A refusal gets `refusalLine`, anything else `failureLine`:
 * since #324 and #344 a read after a landed save catches either kind, so neither was ever sure to
 * reach the student on its own (#357).
 *
 * **A Proxy over the adapter rather than an object listing the port's methods**, the shape the
 * hostile-adapter test in `./api.test.ts` already uses and for its reason: a method added to the
 * port later is logged here too without anyone remembering to add it. It is a decorator and never
 * a writer: every save still arrives from `editStateFile` and reaches the adapter with the same
 * arguments, and its answer comes back unchanged. `tools/ci/state-file-writer.ts` cannot see inside
 * a Proxy trap at all, so that is kept true by review and by the pass-through test in
 * `./debug.test.ts`, not by the scanner.
 *
 * **Synchronous methods stay synchronous.** Every port method returns a Promise today; one added
 * later that does not is called and answered as it is, with its throw logged the same way, rather
 * than being turned into a Promise by this wrapper.
 */
export function loggingWorkspace(workspace: Workspace, log: DebugLog, token: string): Workspace {
  return new Proxy(workspace, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      const logged = (error: unknown): never => {
        // the external-edit guard's answer is the page's to say, and was never a failure (above)
        if (error instanceof StateFileChangedError) throw error;
        const operation = String(property);
        log(
          error instanceof WorkspaceRefusedError
            ? refusalLine(operation, error, token)
            : failureLine(operation, error, token),
        );
        throw error;
      };
      return (...args: unknown[]): unknown => {
        let answer: unknown;
        try {
          answer = (method as (...args: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          return logged(error);
        }
        return answer instanceof Promise ? answer.catch(logged) : answer;
      };
    },
  });
}
