/**
 * The launch token, on the browser's side of ADR-0004.
 *
 * The CLI prints `http://localhost:<port>/#t=<token>`. A fragment is never sent to a
 * server, so the token reaches no access log on the way in — but it does stay in the
 * address bar and in browser history, so the page keeps it and takes it out of the URL
 * at once. From then on it rides in `Authorization` on every request (./api.ts).
 *
 * `localStorage` is per origin, and an origin includes the port, so the planner's token
 * is not readable by whatever else the student runs on localhost.
 *
 * Everything here takes the browser as an argument rather than reaching for `window`,
 * which is what lets it be tested without one.
 */
export type TokenBrowser = {
  location: Pick<Location, "hash" | "pathname" | "search">;
  localStorage: Pick<Storage, "getItem" | "setItem">;
  history: Pick<History, "replaceState">;
};

export const TOKEN_STORAGE_KEY = "biu-cs-planner.token";

/** The fragment parameter the CLI writes; see `launchUrl` in server/src/token.ts. */
const FRAGMENT_KEY = "t";

/**
 * What the server generates: 32 random bytes as base64url. Checked here so that a link
 * someone else sends cannot put arbitrary text into an `Authorization` header, and so
 * that a truncated or mangled URL is ignored rather than replacing a working token.
 *
 * The same expression is in server/src/token.ts, because `web` may not import server
 * code (CLAUDE.md, "Code guardrails"). Neither copy may be widened alone: a token the
 * server generates and this refuses would leave the page unable to talk to it, so
 * server/src/token.test.ts checks a generated token against this expression too.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

/**
 * The token to use from now on: the one this URL delivered, or the one already stored.
 *
 * A delivered token is stored and removed from the URL, leaving the address bar holding
 * exactly what the student should bookmark.
 */
export function claimLaunchToken(browser: TokenBrowser): string | undefined {
  const fragment = new URLSearchParams(browser.location.hash.replace(/^#/, ""));
  const offered = fragment.get(FRAGMENT_KEY);

  if (offered === null || !TOKEN_PATTERN.test(offered)) return storedToken(browser);

  remember(browser, offered);

  // `replaceState`, not `pushState`: the URL carrying the token should not become an
  // entry the back button can return to.
  fragment.delete(FRAGMENT_KEY);
  const rest = fragment.toString();
  const { pathname, search } = browser.location;
  browser.history.replaceState(null, "", `${pathname}${search}${rest === "" ? "" : `#${rest}`}`);

  return offered;
}

/** The token kept from an earlier launch, which is what makes a bookmark keep working. */
export function storedToken(browser: TokenBrowser): string | undefined {
  let stored: string | null;
  try {
    stored = browser.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // storage can be switched off entirely; that is a browser with no token, not a crash
    return undefined;
  }
  return stored !== null && TOKEN_PATTERN.test(stored) ? stored : undefined;
}

function remember(browser: TokenBrowser, token: string): void {
  try {
    browser.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // the token is still returned, so this load works; only the bookmark will not
  }
}

/**
 * The token for the life of this page.
 *
 * A browser with storage switched off — private mode, or storage disabled outright —
 * cannot keep the token between loads, but it can still use the one this URL delivered.
 * Holding it here is what makes that browser work for the session instead of sending
 * every request unauthenticated.
 */
export type TokenKeeper = {
  /** Called once as the app starts, before the first request. */
  claim: () => string | undefined;
  /** The token to send now: the stored one, or the one this load claimed. */
  current: () => string | undefined;
};

export function tokenKeeper(browser: TokenBrowser): TokenKeeper {
  let claimed: string | undefined;

  return {
    claim: () => (claimed = claimLaunchToken(browser)),
    current: () => storedToken(browser) ?? claimed,
  };
}
