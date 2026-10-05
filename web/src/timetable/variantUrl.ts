/**
 * The open Variant tab, kept in the URL so a reload opens it again (#325; #281's user story 15).
 *
 * View state and nothing more: not a State File edit, and not a Device Preference — a second tab
 * or a bookmark opens the Variant its own URL names. The query carries the name and its position,
 * the position being what tells two Variants of one name apart (#322).
 *
 * **The Launch Token comes first.** `claimToken` in `../main.tsx` takes the token out of the
 * fragment before anything renders, and keeps the query as it was (`../token.ts`); this reads the
 * query only once the page mounts, and writes it with `replaceState`, keeping the path and any
 * fragment left, so neither can undo the other (ADR-0004).
 *
 * Every touch of the browser is wrapped: a URL that cannot be read or written leaves the page on
 * the primary, which is where a Semester opens anyway.
 */

/** What a URL can name: a Variant by name, and the position of the one meant among those of it. */
export type VariantInUrl = { name: string; position: number | undefined };

export type VariantUrlBrowser = {
  location: Pick<Location, "pathname" | "search" | "hash">;
  history: Pick<History, "replaceState">;
};

const NAME = "variant";
const POSITION = "position";

/** The Variant the URL names, or `undefined` for none — the primary. */
export function variantInUrl(browser: VariantUrlBrowser | undefined): VariantInUrl | undefined {
  try {
    if (browser === undefined) return undefined;
    const query = new URLSearchParams(browser.location.search);
    const name = query.get(NAME);
    if (name === null || name.trim() === "") return undefined;
    const position = Number(query.get(POSITION) ?? Number.NaN);
    return { name, position: Number.isInteger(position) && position >= 0 ? position : undefined };
  } catch {
    return undefined;
  }
}

/**
 * Puts the Variant shown into the URL, replacing the history entry rather than adding one: showing
 * a tab is not a place the back button should step through.
 */
export function keepVariantInUrl(browser: VariantUrlBrowser | undefined, shown: VariantInUrl): void {
  try {
    if (browser === undefined) return;
    const { pathname, search, hash } = browser.location;
    const query = new URLSearchParams(search);
    query.set(NAME, shown.name);
    if (shown.position === undefined) query.delete(POSITION);
    else query.set(POSITION, String(shown.position));
    const next = `?${query.toString()}`;
    if (next === search) return;
    browser.history.replaceState(null, "", `${pathname}${next}${hash}`);
  } catch {
    // a URL that cannot be written costs the reload its tab, and nothing else
  }
}
