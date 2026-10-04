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
 * React mounts, and `watchScheme` below re-reads it when another tab writes (#146).
 * `asSchemeChoice` stays the single place a value from outside becomes a choice: the inline
 * stamp keeps that true by narrowing nothing at all, and `scheme.test.ts` fails if it
 * starts to.
 *
 * **This module owns the attribute, and every stamp carries what the store says now.** The
 * three writers are `main.tsx` once at startup, `watchScheme` on an event it answers by
 * re-reading, and `chooseScheme` at the moment it writes the store itself. No component
 * stamps, so no stamp can carry a value read during an earlier render — which is what #168
 * was: `SchemeControl`'s mount effect applied the choice its `useState` initialiser had read,
 * and a choice arriving from another tab in the window between that render and its commit was
 * applied by the watcher and then overwritten with the older one. A component asks the store
 * and shows the answer, and `scheme.test.ts` fails if one calls `applyScheme` again.
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
 * A student choosing, in this tab: remembered and stamped, in that order, from one place.
 *
 * This exists because **the browser tells the tab that wrote the value nothing.** No
 * `storage` event is delivered to the writer, so `watchScheme` — which answers every change
 * made anywhere else — cannot be what applies a choice made here. Something in the writing
 * tab has to, and the question #168 asked is what that something is allowed to be.
 *
 * It is this function and not a component's effect, because recording and stamping are then
 * one step and the value stamped is the one being recorded. An effect is a second step, run
 * later, with whatever its render captured: that is how a choice arriving in between came to
 * be overwritten. The invariant the module header states is kept here by there being nothing
 * for a caller to get wrong — no caller holds a choice long enough for it to go stale,
 * because it writes the store with the same value in the same breath.
 *
 * `rememberScheme` swallows a store that refuses, so a blocked store still leaves this page
 * in the chosen scheme and only the next load forgets.
 */
export function chooseScheme(
  browser: SchemeBrowser,
  element: SchemeElement,
  choice: SchemeChoice,
): void {
  rememberScheme(browser, choice);
  applyScheme(element, choice);
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

/**
 * This page's store, or the empty one when there is no store to be had.
 *
 * **`typeof` is not what makes this safe, and on its own it is not enough.** It suppresses a
 * `ReferenceError` for an *undeclared* name, which is the Node case — no `localStorage` in the
 * process at all. But `localStorage` is a declared property of a browser's global object, so
 * `typeof localStorage` *invokes the getter*, and in a browser with site data blocked that
 * getter throws. Without the `try` the throw escapes into whatever called this; `main.tsx`
 * calls it twice at module top level, before `createRoot`, so what escaped was the whole
 * module and the student got a blank page (#146, criterion 3).
 *
 * `token.ts`'s `storedToken` has always had this right — the read is inside its `try`, "that
 * is a browser with no token, not a crash" — and this is the same rule for the same reason:
 * every way of not having a store is the one no-choice state, never an exception.
 */
export function schemeStore(): SchemeBrowser {
  try {
    return typeof localStorage === "undefined" ? NOTHING_REMEMBERED : { localStorage };
  } catch {
    // site data blocked: the getter itself throws, which is still just a browser with no choice
    return NOTHING_REMEMBERED;
  }
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
  return onSchemeChanged(watching, browser, (choice) => applyScheme(element, choice));
}

/**
 * The same event, handed to something that is not the document.
 *
 * `watchScheme` covers the page, which is what a student is looking at, and it is all
 * `main.tsx` needs. A control showing the choice *as a word* is the other consumer, and
 * `SchemeControl` is it: `onSchemeChanged(window, schemeStore(), setChoice)` is what keeps its
 * `<select>` on the scheme the document is actually in after another tab chose (#168). Before
 * that it read the store once as it mounted, so the page around it went dark under a drop-down
 * still saying "light" — and re-picking the option already shown fires no `change` event,
 * which made that the one value its student could not re-assert.
 *
 * It stays separate from `watchScheme` so that the component needs no adapter standing in for
 * an element it is not, and so that a subscriber which only *shows* the choice cannot stamp
 * it: what this hands over is a `SchemeChoice` and not a document.
 *
 * Both go through the same guard and the same re-read, so two subscribers cannot end up with
 * two answers, and the tab that wrote the value is told nothing by either.
 */
export function onSchemeChanged(
  watching: SchemeChangeTarget,
  browser: SchemeBrowser,
  changed: (choice: SchemeChoice) => void,
): () => void {
  const follow = (event: SchemeChange): void => {
    if (event.key !== null && event.key !== SCHEME_STORAGE_KEY) return;
    changed(storedScheme(browser));
  };
  watching.addEventListener("storage", follow);
  return () => watching.removeEventListener("storage", follow);
}
