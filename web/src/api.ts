import { hc } from "hono/client";
import type { ApiType } from "@biu-cs-planner/server";
import { tokenKeeper, type TokenKeeper } from "./token.ts";

/**
 * The only way web reaches the domain. It knows the API contract and nothing else:
 * `ApiType` is a type-only import, so no `core` or `app` code is ever bundled here.
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
