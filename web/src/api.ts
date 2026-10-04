import { hc } from "hono/client";
import type { ApiType } from "@biu-cs-planner/server";
import { tokenKeeper, type TokenKeeper } from "./token.ts";

/**
 * The only way web reaches the domain. It knows the API contract and nothing else:
 * `ApiType` arrives as `import type`, which `verbatimModuleSyntax` erases outright, so no
 * `server`, `app` or `core` code is ever bundled here.
 *
 * That spelling is the guardrail, not a style choice. The inline `import { type ApiType }`
 * carries exactly the same type and emits `import {} from "@biu-cs-planner/server"`, a
 * specifier the bundler resolves — reaching `server/src/index.ts`, `workspace.fs.ts` and
 * `node:fs/promises`. `tools/pr-review/layering.ts` fails the inline form for that reason
 * (#59); "type-only" alone was never the promise.
 *
 * Same-origin in production; in development Vite proxies /api to the server, which is
 * also on loopback, so the Host and Origin checks hold in both (docs/design.md).
 */
export function createApiClient(readToken: () => string | undefined, fetchImpl?: typeof fetch) {
  return hc<ApiType>("/", {
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    // a function, not an object: the token arrives from the URL fragment after this
    // client is built, and every request reads whatever is current when it is sent
    headers: () => {
      const token = readToken();
      return token === undefined ? {} : { Authorization: `Bearer ${token}` };
    },
  });
}

/**
 * A body that was read, or an answer this page could not read at all.
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
 * Offerings read rejected with the student told nothing at all (#171).
 *
 * It takes the read as a thunk rather than the answer, so the typed client's own union of
 * body types flows through untouched: `readBody(() => answer.json())` has exactly the type
 * `answer.json()` had.
 */
export async function readBody<T>(read: () => Promise<T>): Promise<AnswerBody<T>> {
  try {
    return { readable: true, body: await read() };
  } catch {
    return { readable: false };
  }
}

/**
 * `window` is touched only when a request is actually sent or the token claimed, never
 * as this module loads — which is what lets the client be built without a browser.
 */
let keeper: TokenKeeper | undefined;
const tokens = (): TokenKeeper => (keeper ??= tokenKeeper(window));

/** The client the app uses. */
export const api = createApiClient(() => tokens().current());

/**
 * Called once as the app starts: takes the launch token out of the URL and keeps it.
 * Re-exported here so a component never has to know where the token comes from.
 */
export const claimToken = (): string | undefined => tokens().claim();

/**
 * Whether this page is holding a launch token at all.
 *
 * **A retired token and no token are different states** and the page could not tell them
 * apart: every request 401s either way, and the one sentence it had said "this page has no
 * launch token" — which is false for a tab that was authenticated when
 * `biu-cs-planner rotate-token` ran, and sends a student looking for a token they can see is
 * present (#126).
 *
 * The 401 cannot carry the difference: the server refuses a wrong token and a missing one
 * identically and must, because saying which would tell a caller whether it had guessed a
 * real token. So it is answered here, from the page's own side, and it is read from the same
 * store every request reads its token from rather than from anything remembered at load — a
 * tab on the same port picks up a fresh token as soon as the new address is opened in that
 * browser (ADR-0004), and a snapshot taken at load would go on claiming the old state.
 *
 * The sentence it chooses does say *this page's* token was refused, which is safe because
 * `claimLaunchToken` runs before the first request goes out (`main.tsx`): a page that is holding
 * a token now was holding it when the refusal was answered. What is deliberately not claimed is
 * that the token was **rotated** — the server refuses a token it never issued the same way, and
 * a second app on the port would too.
 */
export const hasLaunchToken = (): boolean => tokens().current() !== undefined;
