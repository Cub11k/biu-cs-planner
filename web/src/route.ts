import { useCallback, useEffect, useState } from "react";

/**
 * Which screen is open, carried in the URL's **path** (#294): `/` is the Timetable, `/progress`
 * the Progress screen. A reload or a bookmark returns to it, and the browser's back and forward
 * buttons move between screens, because each move is a history entry.
 *
 * **The path and not the fragment**, because the fragment is the Launch Token's (ADR-0004): the
 * launcher prints `http://localhost:<port>/#t=<token>`, and `claimLaunchToken` in `./token.ts`
 * takes the token out of it before anything renders. A hash router would have to share that
 * fragment with it, and a route rewriting the hash before the token was read would lose the
 * token. The path is never touched by the token's claim — `replaceState` there keeps the pathname —
 * and the server already answers any extensionless path with the single page (`serveBuiltUi` in
 * `server/src/ui.ts`), so no server change is needed and none is made.
 *
 * No router dependency: one path per screen, a `pushState` to move and a `popstate` to follow back
 * and forward is the whole of what is needed, and a library would be a runtime dependency for it
 * (`docs/design.md`, "Supply chain").
 */

/** The part of `window` this needs, so a test can hand it a stand-in. */
export type LocationBrowser = {
  location: Pick<Location, "pathname">;
  history: Pick<History, "pushState">;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
};

/**
 * The path the page is on, and how to move to another. Moving pushes a history entry, so back
 * returns; moving to the path already open does nothing, so a second click on the open screen's
 * link is not an entry back has to step over.
 */
export function useLocationPath(browser?: LocationBrowser): [string, (path: string) => void] {
  // No window at all is a render to a string (`renderToStaticMarkup` in the node tests), which has
  // no URL and no history: it is drawn at the landing path and nothing can move it.
  const source = browser ?? (typeof window === "undefined" ? undefined : window);
  const [path, setPath] = useState(() => source?.location.pathname ?? "/");

  useEffect(() => {
    if (source === undefined) return;
    const follow = (): void => setPath(source.location.pathname);
    source.addEventListener("popstate", follow);
    return () => source.removeEventListener("popstate", follow);
  }, [source]);

  const go = useCallback(
    (to: string): void => {
      if (source === undefined || source.location.pathname === to) return;
      source.history.pushState(null, "", to);
      setPath(to);
    },
    [source],
  );

  return [path, go];
}

/**
 * Which of the screens a path opens: the one whose path it is, and the first — the landing
 * screen — for any other path, so an old bookmark or a mistyped address still lands somewhere
 * rather than on nothing. The URL is left as it is: rewriting it is not this function's to do.
 */
export function screenFor<T extends { path: string }>(screens: readonly T[], path: string): T | undefined {
  return screens.find((screen) => screen.path === path) ?? screens[0];
}
