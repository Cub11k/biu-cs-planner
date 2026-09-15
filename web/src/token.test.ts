import { expect, it } from "vitest";
import {
  TOKEN_STORAGE_KEY,
  claimLaunchToken,
  storedToken,
  tokenKeeper,
  type TokenBrowser,
} from "./token.ts";

const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

/** As much of a browser as the token needs: a URL, a store and a way to rewrite the URL. */
function fakeBrowser(url: string, stored?: string) {
  const parsed = new URL(url, "http://localhost:8900");
  const items = new Map<string, string>();
  if (stored !== undefined) items.set(TOKEN_STORAGE_KEY, stored);
  const rewritten: string[] = [];

  const browser: TokenBrowser = {
    location: { hash: parsed.hash, pathname: parsed.pathname, search: parsed.search },
    localStorage: {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        items.set(key, value);
      },
    },
    history: {
      replaceState: (_data, _unused, url) => {
        rewritten.push(String(url));
      },
    },
  };
  return { browser, items, rewritten };
}

it("takes the token out of the fragment and keeps it", () => {
  const { browser, items } = fakeBrowser(`/#t=${TOKEN}`);

  expect(claimLaunchToken(browser)).toBe(TOKEN);
  expect(items.get(TOKEN_STORAGE_KEY)).toBe(TOKEN);
});

it("takes the token out of the URL, so it does not linger in browser history", () => {
  const { browser, rewritten } = fakeBrowser(`/#t=${TOKEN}`);

  claimLaunchToken(browser);

  expect(rewritten).toEqual(["/"]);
  expect(rewritten[0]).not.toContain(TOKEN);
});

it("keeps the path and query the student arrived on", () => {
  const { browser, rewritten } = fakeBrowser(`/timetable?year=2027#t=${TOKEN}`);

  claimLaunchToken(browser);

  expect(rewritten).toEqual(["/timetable?year=2027"]);
});

it("keeps the rest of the fragment, and only drops the token", () => {
  const { browser, rewritten } = fakeBrowser(`/#view=week&t=${TOKEN}`);

  expect(claimLaunchToken(browser)).toBe(TOKEN);
  expect(rewritten).toEqual(["/#view=week"]);
});

it("leaves a bookmarked URL alone and answers with the token it already has", () => {
  const { browser, rewritten } = fakeBrowser("/", TOKEN);

  expect(claimLaunchToken(browser)).toBe(TOKEN);
  // nothing to remove, so nothing is rewritten and no history entry is touched
  expect(rewritten).toEqual([]);
});

it("replaces the stored token when a newer launch URL brings a different one", () => {
  const older = "b2xkZXItdG9rZW4tZnJvbS1hbi1lYXJsaWVyLWluc3RhbGxhdGlvbi14";
  const { browser, items } = fakeBrowser(`/#t=${TOKEN}`, older);

  expect(claimLaunchToken(browser)).toBe(TOKEN);
  expect(items.get(TOKEN_STORAGE_KEY)).toBe(TOKEN);
});

it("ignores a fragment that is not a token, rather than storing rubbish", () => {
  for (const hash of ["#t=", "#t=short", "#t=has spaces", "#t=<script>", "#other=1", ""]) {
    const { browser, items, rewritten } = fakeBrowser(`/${hash}`, TOKEN);

    expect(claimLaunchToken(browser), hash).toBe(TOKEN);
    expect(items.get(TOKEN_STORAGE_KEY), hash).toBe(TOKEN);
    expect(rewritten, hash).toEqual([]);
  }
});

it("has no token before one is claimed", () => {
  const { browser } = fakeBrowser("/");

  expect(storedToken(browser)).toBeUndefined();
  expect(claimLaunchToken(browser)).toBeUndefined();
});

it("reads back the token it stored, which is how every later request finds it", () => {
  const { browser, items } = fakeBrowser(`/#t=${TOKEN}`);

  claimLaunchToken(browser);

  expect(storedToken({ ...browser, localStorage: readOnly(items) })).toBe(TOKEN);
});

it("treats a store it may not use as having no token, rather than failing to load", () => {
  const { browser } = fakeBrowser(`/#t=${TOKEN}`);
  const blocked: TokenBrowser = { ...browser, localStorage: refusingStorage() };

  expect(storedToken(blocked)).toBeUndefined();
  expect(() => claimLaunchToken(blocked)).not.toThrow();
});

function readOnly(items: Map<string, string>): TokenBrowser["localStorage"] {
  return { getItem: (key) => items.get(key) ?? null, setItem: () => {} };
}

it("keeps sending the token for this load when storage is switched off", () => {
  // the page cannot remember the token for next time, but refusing to use the one it
  // was just handed would mean every request this session goes out unauthenticated
  const { browser } = fakeBrowser(`/#t=${TOKEN}`);
  const keeper = tokenKeeper({ ...browser, localStorage: refusingStorage() });

  expect(keeper.current()).toBeUndefined();
  expect(keeper.claim()).toBe(TOKEN);
  expect(keeper.current()).toBe(TOKEN);
});

it("sends the stored token on a load that claims nothing, which is what a bookmark does", () => {
  const { browser } = fakeBrowser("/", TOKEN);
  const keeper = tokenKeeper(browser);

  expect(keeper.current()).toBe(TOKEN);
});

it("has nothing to send before a token has ever arrived", () => {
  const { browser } = fakeBrowser("/");
  const keeper = tokenKeeper(browser);

  expect(keeper.claim()).toBeUndefined();
  expect(keeper.current()).toBeUndefined();
});

function refusingStorage(): TokenBrowser["localStorage"] {
  return {
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {
      throw new Error("storage disabled");
    },
  };
}
