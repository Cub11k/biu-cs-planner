/**
 * Light and dark, and the student's explicit choice between them.
 *
 * `index.css` holds the palette and does the work: with no `data-theme` on `<html>` the
 * operating system decides, `data-theme="dark"` redefines the tokens outside the media
 * query, and `data-theme="light"` is the value the media query is guarded against. This
 * module is only the choice — reading it, remembering it, stamping it on the document, and
 * following it when another tab changes it (docs/design.md, "Light and dark"; #114, #146).
 *
 * **The scheme is a Device Preference, so it is kept in the browser's store and not in the
 * State File.** Where that line is drawn, why, what it costs when the CLI lands on another
 * port and why that cost is acceptable are all
 * [ADR-0014](../../docs/adr/0014-where-a-preference-is-kept.md). This comment does not
 * restate the argument: two full copies of a rule are two things to keep in step, which is
 * the drift that ADR was written to end (#142).
 *
 * What a reader of *this* module needs from that decision is the shape it leaves here. The
 * value sits under `SCHEME_STORAGE_KEY` in `localStorage`, per browser and per origin.
 * Nothing reads it as a value beyond the control that sets it: it becomes an attribute on
 * `<html>` and the stylesheet does the rest. And every way of not knowing it — no key, an
 * unrecognised one, a store that throws, no browser at all — is the one `"system"` state
 * rather than a third palette, which is what makes losing the value cost a click.
 *
 * Three places read that store, and they have to agree. The blocking stamp in
 * `web/index.html` runs before the first paint, `main.tsx` narrows the same key before
 * React mounts, and `watchScheme` below re-reads it when another tab writes. `asSchemeChoice`
 * stays the single place a value from outside becomes a choice: the inline stamp keeps that
 * true by narrowing nothing at all, and `scheme.test.ts` fails if it starts to.
 *
 * Everything here takes the browser and the element as arguments rather than reaching for
 * `window` or `document`, which is what lets it be tested without either.
 */
/** The two schemes `index.css` has palettes for. */
export const SCHEMES = ["light", "dark"] as const;

export type Scheme = (typeof SCHEMES)[number];

/**
 * What a student can have chosen. `"system"` is the absence of a choice rather than a
 * third palette: it is what a browser that has never been told arrives as, and choosing it
 * again is how a student hands the decision back to the operating system.
 */
export type SchemeChoice = Scheme | "system";

export const SCHEME_CHOICES = ["system", ...SCHEMES] as const satisfies readonly SchemeChoice[];

export const SCHEME_STORAGE_KEY = "biu-cs-planner.scheme";

/** The attribute `index.css` keys off, on `<html>`. */
export const SCHEME_ATTRIBUTE = "data-theme";

export type SchemeBrowser = {
  localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

/** Whichever end of the document the stamp goes on; `<html>` in the app. */
export type SchemeElement = Pick<Element, "setAttribute" | "removeAttribute">;

/**
 * Whether a stored string is a choice this app makes.
 *
 * Storage is data from outside the program, so it is checked against the two names rather
 * than trusted — the value becomes an attribute selector's subject, and an attribute of
 * whatever a page happened to find in storage is not something `index.css` has a palette
 * for (ADR-0007: data is interpreted, never executed).
 */
export function isScheme(value: unknown): value is Scheme {
  return typeof value === "string" && (SCHEMES as readonly string[]).includes(value);
}

/**
 * The choice this browser remembers, or `"system"` for a browser that has never been told.
 *
 * Anything unrecognised is `"system"` as well: a key some other build wrote, or a value
 * hand-edited in devtools, means the operating system decides — the safe answer, because
 * it is the one every student had before this existed.
 */
export function storedScheme(browser: SchemeBrowser): SchemeChoice {
  let stored: string | null;
  try {
    stored = browser.localStorage.getItem(SCHEME_STORAGE_KEY);
  } catch {
    // storage can be switched off entirely; that is a browser with no choice, not a crash
    return "system";
  }
  return asSchemeChoice(stored);
}

/**
 * Remembers the choice, for the next load on this origin.
 *
 * `"system"` **removes** the key rather than storing the word: a browser holding no key
 * and a browser holding "system" have to behave identically, and one of those two states
 * is the one every other browser is already in. Storing the word would leave two
 * spellings of the same thing for `storedScheme` to keep agreeing about.
 */
export function rememberScheme(browser: SchemeBrowser, choice: SchemeChoice): void {
  try {
    if (choice === "system") browser.localStorage.removeItem(SCHEME_STORAGE_KEY);
    else browser.localStorage.setItem(SCHEME_STORAGE_KEY, choice);
  } catch {
    // the scheme still applies to this page; only the next load will not remember it
  }
}

/**
 * Stamps the choice on the document, which is the whole of how it takes effect.
 *
 * Removing the attribute rather than setting it to "system" for the same reason
 * `rememberScheme` removes the key: `index.css` describes no-choice as the absence of the
 * attribute, and the media query's guard is spelled against `"light"` alone.
 */
export function applyScheme(element: SchemeElement, choice: SchemeChoice): void {
  if (choice === "system") element.removeAttribute(SCHEME_ATTRIBUTE);
  else element.setAttribute(SCHEME_ATTRIBUTE, choice);
}

/**
 * The choice a string names, or `"system"` for a string that names none.
 *
 * The one place a value from outside — storage, or the value a `<select>` hands back —
 * becomes a choice, so there is one answer to "what if it is not one of the three" rather
 * than one per caller.
 */
export function asSchemeChoice(value: unknown): SchemeChoice {
  if (value === "system") return "system";
  return isScheme(value) ? value : "system";
}

/**
 * A store that holds nothing, for where there is no browser to hold one.
 *
 * `renderToStaticMarkup` renders these components in Node, with no `localStorage` in the
 * process at all (`timetable/render.test.ts`), and a component that reached for one as it
 * rendered would turn that into a crash. Having no browser and having a browser that was
 * never told are the same answer, so this gives them the same code path rather than a
 * `typeof` check at each call site.
 */
const NOTHING_REMEMBERED: SchemeBrowser = {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};

/** This page's store, or the empty one when the code is not running in a page. */
export function schemeStore(): SchemeBrowser {
  return typeof localStorage === "undefined" ? NOTHING_REMEMBERED : { localStorage };
}

/**
 * What a `storage` event has to say for this module to care.
 *
 * `key` alone, and narrowed to that one field so a test can deliver an event without a DOM
 * for the same reason every other function here takes its browser as an argument.
 */
export type SchemeChange = Pick<StorageEvent, "key">;

/** Where a `storage` event arrives: `window` in the app, an iframe's window in a test. */
export type SchemeChangeTarget = {
  addEventListener(type: "storage", listener: (event: SchemeChange) => void): void;
  removeEventListener(type: "storage", listener: (event: SchemeChange) => void): void;
};

/**
 * Follows the choice when another tab changes it, and returns the way to stop.
 *
 * Two tabs on one Workspace are in scope for this project (ADR-0013, and #90's guard exists
 * because of it), and every tab on an origin shares the one store this choice lives in. A
 * `storage` event is the browser saying it changed. Without this, a second open tab keeps
 * the scheme it loaded with until it is reloaded (#146).
 *
 * **The event does not fire in the tab that wrote the value.** That is its defined
 * behaviour rather than a quirk to work around, and it is what makes the writing tab safe:
 * that tab applies its own choice once, through the control, and is never told about it. So
 * there is no double-apply to suppress and no echo to filter — the two halves do not
 * overlap at all.
 *
 * `newValue` is deliberately ignored and the store is read again instead. That keeps
 * `storedScheme` the only reader of the key and `asSchemeChoice` the only narrowing; it
 * makes the handler idempotent, so a second event for the same value stamps the same
 * attribute; and it makes a spurious event harmless, which matters because `storage` also
 * fires for `sessionStorage` — an event carrying this key from some other area still ends
 * in the answer `localStorage` gives. A `key` of `null` is `localStorage.clear()`, which
 * changed every key including this one.
 *
 * A store cleared, blocked or switched off since the page loaded reads as `"system"` down
 * the same path a browser that was never told takes, so an event leaves a working page in
 * the operating system's scheme rather than a throw inside a listener.
 */
export function watchScheme(
  watching: SchemeChangeTarget,
  browser: SchemeBrowser,
  element: SchemeElement,
): () => void {
  const follow = (event: SchemeChange): void => {
    if (event.key !== null && event.key !== SCHEME_STORAGE_KEY) return;
    applyScheme(element, storedScheme(browser));
  };
  watching.addEventListener("storage", follow);
  return () => watching.removeEventListener("storage", follow);
}
