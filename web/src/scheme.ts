/**
 * Light and dark, and the student's explicit choice between them.
 *
 * `index.css` holds the palette and does the work: with no `data-theme` on `<html>` the
 * operating system decides, `data-theme="dark"` redefines the tokens outside the media
 * query, and `data-theme="light"` is the value the media query is guarded against. This
 * module is only the choice — reading it, remembering it, and stamping it on the document
 * (docs/design.md, "Light and dark"; #114).
 *
 * **The choice is kept in `localStorage`, per browser and per origin, and not in the State
 * File.** A scheme is a property of the desk the student is sitting at, not of their
 * degree plan: the same plan opened on a phone in the sun and a desktop at night wants
 * different answers, so a State File that carried one would be wrong on the second device
 * rather than merely unhelpful. `docs/design.md`'s Workspace screen also lists a State File's
 * settings as language and Exam spacing, so putting a scheme there would be a design change rather
 * than the implementation of one, and it would drag in the save path, the external-edit
 * guard (#90) and ADR-0013's `settings excluded` undo rule for a preference no domain
 * check ever reads.
 *
 * The cost is real and it is the one `token.ts:9` already names: an origin includes the
 * port, and the CLI moves to the next free port when 8900 is taken. So a student whose run
 * lands on 8901 sees the scheme follow their operating system again, and one click on the
 * control puts it back for that port. That degrades to exactly today's behaviour rather
 * than to a wrong one, which is why it is an acceptable cost and a `localStorage` that
 * held, say, a Variant would not be.
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
