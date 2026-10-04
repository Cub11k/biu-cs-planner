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
 * It takes the read as a thunk rather than the answer, so the typed client's own union of
 * body types flows through untouched: `readBody(() => answer.json())` has exactly the type
 * `answer.json()` had.
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
 * One of it, for the five sites that each wrote their own (#208) — the four `read` functions in
 * `settings.ts`, `history.ts`, `timetable/picks.ts` and `timetable/offerings.ts`, and the poll
 * closure in `changes.ts`. The status is widened to `number` at every one of them deliberately:
 * the guard answers before the route does, so 401 is not among the answers the contract knows
 * about, and nothing in `ApiType` will ever narrow a comparison against it.
 *
 * **Nothing in `body.test.ts` pins this number, and nothing there could.** A test beside it can
 * only restate the declaration — `expect(UNAUTHORIZED).toBe(401)`, or the same literal wrapped
 * in a `Response`, which adds an assertion that the platform keeps its own status and none about
 * this code. What pins it is the five sites' own tests: each has a case that answers 401 and
 * expects `unauthorized`, and setting this to 403 fails 17 of them across seven files. A test
 * claiming otherwise was written here and removed (#209's reviewer).
 */
export const UNAUTHORIZED = 401;
