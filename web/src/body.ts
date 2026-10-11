/**
 * One answer, as this page can read it **before** the contract's types apply: whether its body
 * was JSON at all, and the one status the contract does not describe.
 *
 * ---
 *
 * **Why these two live here and not in `./api.ts` (#208).** `api.ts` is the client: it builds
 * `hc<ApiType>`, wires the launch token in, and reaches `window` through `tokenKeeper` — and it
 * builds the client as it loads, so importing anything out of it imports all of that. Neither
 * thing below needs any of it. `readBody` is a function over a thunk and never sees a client, a
 * token or a URL; `UNAUTHORIZED` is a number.
 *
 * The move is not tidying. Of the five modules that read an answer, `timetable/picks.ts` and
 * `timetable/offerings.ts` wanted nothing from `api.ts` but the reader, and dragged the module
 * that touches `window` into their import graph to get it. With both here, neither reaches it at
 * all: `offerings.ts` keeps only `import type { createApiClient }`, which `verbatimModuleSyntax`
 * erases, and `picks.ts` has no edge to it left. What still reaches `api.ts` are the three modules
 * that send requests and the two that need the token — `App.tsx` for `hasLaunchToken` and
 * `main.tsx` for `claimToken`, which are the client's own business and not a body's.
 *
 * `UNAUTHORIZED` is here rather than left in `api.ts` because of the sentence all five sites had
 * written above their own copy of it: *the guard answers before the route does, so its status is
 * not one of the route's*. That is a fact about an **answer** which the contract cannot type —
 * which is what `AnswerBody` is as well. One module for what is true of a `Response` before the
 * contract's types reach it; `api.ts` stays the module about making a request.
 *
 * The file name is #208's suggestion and the body is the part that needs guarding, so it is kept.
 *
 * **`askApi` is here for the same reason (#382).** Every reader in `web` was one copy of one
 * skeleton — send inside a `try`, widen the status for the guard's 401, read the body through
 * `readBody` — and every bug that skeleton produced was one copy getting a step wrong (#171,
 * #206, #230). Those three steps are about an answer before the contract's types reach it, which
 * is what this module is; what is left in each reader is its two callbacks.
 *
 * **Where the shape guard lives (#275).** There is no general schema check in `web`: it imports
 * neither `core` nor `app`, and the answers come from our own typed server. But a served answer
 * that lacks a list its render loops over is an answer this page cannot read, not one to pass on:
 * each reader's `served` callback checks the fields it hands on without a `?? []` default, and
 * returns `undefined` when one is missing, which `askApi` makes `unreadable-answer`. So the
 * guard is in the reader, one field at a time, and the sentence is the one that path already says.
 */

/**
 * A body that was read, or an answer this page could not read at all.
 *
 * **An object is all `readable: true` promises**, not the shape a route answers with: `{}` is
 * readable, and a caller reading a field off it gets `undefined` rather than an exception.
 *
 * **`readable: true` means a JSON object**, and nothing less (#230). Every route this page calls
 * answers with one, and every caller reads a field straight off it — `body.label`,
 * `"warnings" in body` — outside any `try`. So a body that is JSON and not an object is an
 * answer this page cannot read, exactly as one that is not JSON at all: `null` used to come back
 * `readable: true`, and each of those reads then threw on it, the rejection was swallowed, and
 * the student was told nothing — the silence #206 closed, reached by another input.
 *
 * `readable: false` is an **answer** and not a crash, which is the whole of #171. In
 * development `web/vite.config.ts` proxies `/api` to the server, and Vite answers with an
 * HTML 500 page when the target refuses the connection — so "the server is not running"
 * arrives as a response with an unparseable body rather than as a failed request. An
 * unmatched `/api/...` path is hono's plain-text 404 (`server/src/ui.ts`), and a bundle
 * newer than the server it is talking to produces exactly that.
 */
export type AnswerBody<T> = { readable: true; body: T } | { readable: false };

/**
 * Reads one answer's body, turning a body that is not JSON into an answer rather than a
 * rejected promise.
 *
 * Here rather than in each module that fetches, because three copies of it had already been
 * written by hand and two of them were wrong: `web/src/settings.ts` read the body inside a
 * `try` after #115's reviewer found the hole, and `timetable/picks.ts` and
 * `timetable/offerings.ts` still read theirs outside one — so a Pick, a Pick removal and an
 * Offerings read rejected with the student told nothing at all (#171). `web/src/history.ts`
 * was not in that census and read both of its bodies outside the catch for the same reason
 * (#206).
 *
 * It takes the read as a thunk rather than the answer, so it never sees a client or a status.
 * Its one production caller is `askApi` below, which reads every body as `unknown` and hands it
 * to the callback that claims its shape.
 */
export async function readBody<T>(read: () => Promise<T>): Promise<AnswerBody<T>> {
  let body: T;
  try {
    body = await read();
  } catch {
    return { readable: false };
  }
  // `null`, a number, a string, a boolean or an array: JSON, and still not a body any caller
  // can read a field off (#230). Refused here, once, rather than guarded at every call site.
  return isObject(body) ? { readable: true, body } : { readable: false };
}

/** A JSON object: not `null`, not an array, and not a primitive. */
const isObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The launch token guard's refusal (ADR-0004).
 *
 * One of it, for the five sites that each wrote their own (#208). Two read it now: `askApi`
 * below, which every reader goes through (#382), and the poll closure in `changes.ts`. The status
 * is widened to `number` at both deliberately:
 * the guard answers before the route does, so 401 is not among the answers the contract knows
 * about, and nothing in `ApiType` will ever narrow a comparison against it.
 *
 * **Nothing in `body.test.ts` pins this number, and nothing there could.** A test beside it can
 * only restate the declaration — `expect(UNAUTHORIZED).toBe(401)`, or the same literal wrapped
 * in a `Response`, which adds an assertion that the platform keeps its own status and none about
 * this code. What pins it is `askApi`'s own 401 case in `body.test.ts` and the readers' tests
 * that answer 401 and expect `unauthorized`. A test
 * claiming otherwise was written here and removed (#209's reviewer).
 */
export const UNAUTHORIZED = 401;

/** The three answers no route writes: the request never arrived, the guard refused it, or its body could not be read. */
export type Transport = { kind: "unauthorized" } | { kind: "unreadable-answer" } | { kind: "unreachable" };

/** What a reader makes of a body: a refusal in its area's own shape, and a served body. */
export type AnswerReaders<R, Refused, Served> = {
  /** A refusal's body, and its status for the two readers that tell one 409 from another. */
  refused: (body: Refused, status: number) => R;
  /** A served body, normalised; `undefined` when it lacks a field the render needs (#275). */
  served: (body: Served) => R | undefined;
};

/**
 * Sends one request and reads its answer, owning the three outcomes every reader shares (#382).
 *
 * The answer is read **outside** the catch: only the request failing is the server not being
 * there. An answer this page then cannot read is a contract problem, and calling it
 * "unreachable" would send the student to look at a server that answered them.
 *
 * The status is widened to `number` deliberately: the launch token guard answers before the route
 * does, so 401 is not among the answers the contract knows about (`UNAUTHORIZED`).
 *
 * The bodies are cast to the callbacks' types and nothing more: `readBody` promises an object and
 * no shape, and each `served` checks the one field it loops over.
 */
export async function askApi<R, Refused, Served>(
  send: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  readers: AnswerReaders<R, Refused, Served>,
): Promise<R | Transport> {
  let answer: Awaited<ReturnType<typeof send>>;
  try {
    answer = await send();
  } catch {
    return { kind: "unreachable" };
  }
  const status: number = answer.status;
  if (status === UNAUTHORIZED) return { kind: "unauthorized" };
  const read = await readBody(() => answer.json());
  if (!read.readable) return { kind: "unreadable-answer" };
  if (!answer.ok) return readers.refused(read.body as Refused, status);
  return readers.served(read.body as Served) ?? { kind: "unreadable-answer" };
}

/**
 * A read whose every failure is the same news — *not had* — as the reads a screen draws by and
 * never acts through: the value `served` makes of the body, or `undefined` for a refusal, the
 * guard, no server, a body that could not be read, or one `served` could not use.
 */
export async function askFor<T, Served>(
  send: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  served: (body: Served) => T | undefined,
): Promise<T | undefined> {
  const answer = await askApi<{ kind: "had"; value: T } | undefined, unknown, Served>(send, {
    refused: () => undefined,
    served: (body) => {
      const value = served(body);
      return value === undefined ? undefined : { kind: "had", value };
    },
  });
  return answer?.kind === "had" ? answer.value : undefined;
}
