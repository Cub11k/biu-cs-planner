/**
 * The choice itself: reading it, remembering it, and stamping it on an element.
 *
 * Every function here takes the browser or the element as an argument, so this needs no
 * browser at all. Whether the *stylesheet* then does the right thing with the stamp is a
 * question only a cascade can answer, and `scheme.browser.test.tsx` asks it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  SCHEME_ATTRIBUTE,
  SCHEME_CHOICES,
  SCHEME_STORAGE_KEY,
  applyScheme,
  asSchemeChoice,
  isScheme,
  onSchemeChanged,
  rememberScheme,
  schemeStore,
  storedScheme,
  watchScheme,
  type SchemeBrowser,
  type SchemeChange,
  type SchemeChangeTarget,
  type SchemeChoice,
  type SchemeElement,
} from "./scheme.ts";

/** A `localStorage` that can also be asked to fail, which is a browser in private mode. */
function storage(initial?: Record<string, string>, throws = false) {
  const held = new Map(Object.entries(initial ?? {}));
  const browser: SchemeBrowser = {
    localStorage: {
      getItem: (key) => {
        if (throws) throw new Error("storage is off");
        return held.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (throws) throw new Error("storage is off");
        held.set(key, value);
      },
      removeItem: (key) => {
        if (throws) throw new Error("storage is off");
        held.delete(key);
      },
    },
  };
  return { browser, held };
}

/**
 * An element that only records what was done to it, in order.
 *
 * The order matters for the watcher: "stamped the same value twice" and "stamped it then
 * took it off again" leave the same attributes behind and are not the same behaviour.
 */
function element() {
  const attributes = new Map<string, string>();
  const done: string[] = [];
  const stamp: SchemeElement = {
    setAttribute: (name, value) => {
      done.push(`set ${name}=${value}`);
      attributes.set(name, value);
    },
    removeAttribute: (name) => {
      done.push(`remove ${name}`);
      attributes.delete(name);
    },
  };
  return { stamp, attributes, done };
}

/**
 * A window a `storage` event can be delivered to, the way another tab's write delivers one.
 *
 * The event carries only its `key` here, which is all `watchScheme` is allowed to read: the
 * rest of a real `StorageEvent` exists, and a handler that used `newValue` would pass a test
 * that handed it one. This helper cannot hand it one.
 */
function tab() {
  const listeners = new Set<(event: SchemeChange) => void>();
  const watching: SchemeChangeTarget = {
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  return {
    watching,
    listening: () => listeners.size,
    /** Another tab wrote; the browser says which key changed, or `null` for a `clear()`. */
    changed: (key: string | null) => {
      for (const listener of [...listeners]) listener({ key });
    },
  };
}

it("offers the two schemes plus handing the decision back", () => {
  expect([...SCHEME_CHOICES]).toEqual(["system", "light", "dark"]);
});

it("reads back the choice it remembered", () => {
  const { browser } = storage();

  rememberScheme(browser, "dark");
  expect(storedScheme(browser)).toBe("dark");

  rememberScheme(browser, "light");
  expect(storedScheme(browser)).toBe("light");
});

it("has no choice until one is made, so the operating system decides", () => {
  expect(storedScheme(storage().browser)).toBe("system");
});

it("forgets the key rather than storing the word for system", () => {
  // A browser holding "system" and a browser holding nothing have to behave alike, and
  // every browser that has never been told is in the second state. One spelling, not two.
  const { browser, held } = storage();

  rememberScheme(browser, "dark");
  expect(held.get(SCHEME_STORAGE_KEY)).toBe("dark");

  rememberScheme(browser, "system");
  expect(held.has(SCHEME_STORAGE_KEY)).toBe(false);
  expect(storedScheme(browser)).toBe("system");
});

it("takes a stored value it does not recognise as no choice", () => {
  // Storage is data from outside the program: another build's key, or a value typed into
  // devtools. It never becomes an attribute value unchecked (ADR-0007).
  for (const junk of ["", "System", "solarized", "{}", "DARK"]) {
    expect(storedScheme(storage({ [SCHEME_STORAGE_KEY]: junk }).browser)).toBe("system");
  }
});

it("treats storage being switched off as no choice rather than as a crash", () => {
  const { browser } = storage({ [SCHEME_STORAGE_KEY]: "dark" }, true);

  expect(storedScheme(browser)).toBe("system");
  // …and the write is swallowed too: this page still gets the scheme, only the next load
  // will not remember it.
  expect(() => rememberScheme(browser, "dark")).not.toThrow();
});

it("names the two schemes and nothing else", () => {
  expect(isScheme("light")).toBe(true);
  expect(isScheme("dark")).toBe(true);
  for (const other of ["system", "", "Dark", 0, null, undefined, {}]) {
    expect(isScheme(other)).toBe(false);
  }
});

it("narrows anything else to system", () => {
  expect(asSchemeChoice("system")).toBe("system");
  expect(asSchemeChoice("light")).toBe("light");
  expect(asSchemeChoice("dark")).toBe("dark");
  for (const other of ["solarized", "", null, undefined, 7, ["dark"]]) {
    expect(asSchemeChoice(other)).toBe("system");
  }
});

it("stamps a chosen scheme on the element", () => {
  for (const choice of ["light", "dark"] satisfies SchemeChoice[]) {
    const { stamp, attributes } = element();
    applyScheme(stamp, choice);
    expect(attributes.get(SCHEME_ATTRIBUTE)).toBe(choice);
  }
});

it("removes the stamp for system, because no attribute is what no choice means", () => {
  // `index.css` spells no-choice as the absence of the attribute — the media query's guard
  // is written against "light" alone — so a stray `data-theme="system"` would leave the
  // page following the machine while claiming a choice had been recorded.
  const { stamp, attributes } = element();

  applyScheme(stamp, "dark");
  applyScheme(stamp, "system");

  expect(attributes.has(SCHEME_ATTRIBUTE)).toBe(false);
});

it("finds no remembered choice where there is no browser at all", () => {
  // This test runs in Node, which is also where `renderToStaticMarkup` renders the screen.
  // A store that is not there has to read as a choice nobody made, and writing to it has to
  // be allowed to do nothing.
  expect(storedScheme(schemeStore())).toBe("system");
  expect(() => rememberScheme(schemeStore(), "dark")).not.toThrow();
  expect(storedScheme(schemeStore())).toBe("system");
});

/**
 * Another tab's choice reaching this one (#146).
 *
 * What cannot be asked here is the half the browser owns: that a `storage` event is *not*
 * delivered to the tab that wrote the value, which is what makes the writing tab safe from
 * double-applying its own choice. There is no faking that — a fake that did not deliver the
 * event would be asserting its own politeness. `scheme.browser.test.tsx` writes in one
 * document and watches another, where the browser decides who hears about it.
 */
it("follows another tab's choice without being told what it was", () => {
  const { browser, held } = storage();
  const { stamp, attributes } = element();
  const other = tab();
  watchScheme(other.watching, browser, stamp);

  // Another tab chose dark: the store now holds it, and the browser says the key changed.
  held.set(SCHEME_STORAGE_KEY, "dark");
  other.changed(SCHEME_STORAGE_KEY);
  expect(attributes.get(SCHEME_ATTRIBUTE)).toBe("dark");

  held.set(SCHEME_STORAGE_KEY, "light");
  other.changed(SCHEME_STORAGE_KEY);
  expect(attributes.get(SCHEME_ATTRIBUTE)).toBe("light");

  // …and handing the decision back is the key going away, which is what `rememberScheme`
  // does for "system". The third state has to arrive through the event too.
  held.delete(SCHEME_STORAGE_KEY);
  other.changed(SCHEME_STORAGE_KEY);
  expect(attributes.has(SCHEME_ATTRIBUTE)).toBe(false);
});

it("does nothing until the browser says something changed", () => {
  // Registering is not applying. The tab that already stamped `<html>` as it loaded must not
  // be re-stamped by the act of starting to listen, and a tab whose store disagrees with its
  // document is not this watcher's business until an event says so.
  const { browser } = storage({ [SCHEME_STORAGE_KEY]: "dark" });
  const { stamp, done } = element();

  watchScheme(tab().watching, browser, stamp);

  expect(done).toEqual([]);
});

it("ignores a change to some other key", () => {
  // Every key on the origin arrives here: the Launch Token (ADR-0004), and whatever a later
  // Device Preference adds. Without the guard the token being claimed would re-stamp the
  // document, which is how a page ends up flickering for a reason nobody can find.
  const { browser, held } = storage();
  const { stamp, attributes, done } = element();
  const other = tab();
  watchScheme(other.watching, browser, stamp);

  held.set(SCHEME_STORAGE_KEY, "dark");
  other.changed("biu-cs-planner.token");

  expect(done).toEqual([]);
  expect(attributes.has(SCHEME_ATTRIBUTE)).toBe(false);
});

it("takes a cleared store as a change to this key, because it is one", () => {
  // `localStorage.clear()` reports `key: null` — every key changed at once. A watcher that
  // only matched its own name would leave the page dark with nothing in the store to say so.
  const { browser, held } = storage({ [SCHEME_STORAGE_KEY]: "dark" });
  const { stamp, attributes } = element();
  const other = tab();
  watchScheme(other.watching, browser, stamp);

  other.changed(SCHEME_STORAGE_KEY);
  expect(attributes.get(SCHEME_ATTRIBUTE)).toBe("dark");

  held.clear();
  other.changed(null);
  expect(attributes.has(SCHEME_ATTRIBUTE)).toBe(false);
});

it("reads the store back rather than trusting the event, so it cannot be told a lie", () => {
  // The event this watcher gets carries no value at all, and it still lands on the truth.
  // That is what keeps `storedScheme` the only reader of the key and `asSchemeChoice` the
  // only narrowing — and it makes a spurious event harmless, which matters because a
  // `storage` event also fires for `sessionStorage`.
  const { browser, held } = storage({ [SCHEME_STORAGE_KEY]: "solarized" });
  const { stamp, attributes } = element();
  const other = tab();
  watchScheme(other.watching, browser, stamp);

  other.changed(SCHEME_STORAGE_KEY);
  expect(attributes.has(SCHEME_ATTRIBUTE)).toBe(false);

  held.set(SCHEME_STORAGE_KEY, "dark");
  other.changed(SCHEME_STORAGE_KEY);
  expect(attributes.get(SCHEME_ATTRIBUTE)).toBe("dark");
});

it("re-stamps the same value rather than toggling, so a repeated event is harmless", () => {
  const { browser, held } = storage();
  const { stamp, done } = element();
  const other = tab();
  watchScheme(other.watching, browser, stamp);

  held.set(SCHEME_STORAGE_KEY, "dark");
  other.changed(SCHEME_STORAGE_KEY);
  other.changed(SCHEME_STORAGE_KEY);

  expect(done).toEqual([`set ${SCHEME_ATTRIBUTE}=dark`, `set ${SCHEME_ATTRIBUTE}=dark`]);
});

it("leaves a working page when the store stopped answering after the page loaded", () => {
  // A store can be cleared, blocked or switched off between the load and the event. That is
  // the same "never told" as a browser with no key, so the page goes back to the operating
  // system's scheme instead of throwing inside a listener and leaving the old one stamped.
  const { browser } = storage({ [SCHEME_STORAGE_KEY]: "dark" }, true);
  const { stamp, attributes } = element();
  const other = tab();
  watchScheme(other.watching, browser, stamp);

  applyScheme(stamp, "dark");
  expect(() => other.changed(SCHEME_STORAGE_KEY)).not.toThrow();
  expect(attributes.has(SCHEME_ATTRIBUTE)).toBe(false);
});

it("hands the same answer to something that is not the document", () => {
  // What a control showing the choice as a word subscribes to, so that its `<select>` follows
  // another tab instead of staying on the value it mounted with. Same guard, same re-read: two
  // subscribers to one event cannot end up with two answers.
  const { browser, held } = storage();
  const seen: SchemeChoice[] = [];
  const other = tab();
  const stop = onSchemeChanged(other.watching, browser, (choice) => void seen.push(choice));

  held.set(SCHEME_STORAGE_KEY, "dark");
  other.changed(SCHEME_STORAGE_KEY);
  held.delete(SCHEME_STORAGE_KEY);
  other.changed(null);
  other.changed("biu-cs-planner.token");
  stop();
  held.set(SCHEME_STORAGE_KEY, "light");
  other.changed(SCHEME_STORAGE_KEY);

  expect(seen).toEqual(["dark", "system"]);
});

it("stops listening when it is told to", () => {
  const { browser, held } = storage();
  const { stamp, done } = element();
  const other = tab();

  const stop = watchScheme(other.watching, browser, stamp);
  expect(other.listening()).toBe(1);

  stop();
  expect(other.listening()).toBe(0);

  held.set(SCHEME_STORAGE_KEY, "dark");
  other.changed(SCHEME_STORAGE_KEY);
  expect(done).toEqual([]);
});

/**
 * The blocking stamp in `web/index.html`, which is the only part of this feature that is not
 * in `web/src/` and the only part a module cannot reach (#146).
 *
 * Read as source, because what is being checked is that it is *not* a second copy of
 * `asSchemeChoice`. Whether it produces the right palette is a browser's question and
 * `scheme.browser.test.tsx` asks it; whether the rule has been duplicated is a question
 * about the text, and the same shape as the `var(--dark-` guard below: a rule only a
 * comment states is a rule until someone is in a hurry.
 */
const ENTRY_DOCUMENT = fileURLToPath(new URL("../index.html", import.meta.url));

/**
 * A source file with its comments taken out, so a scan reads code and not prose.
 *
 * Without this every assertion below is satisfied by a *mention*: `toContain("watchScheme(")`
 * would pass on a call that had been commented out, and the forbidden-name scan would fail on
 * a comment that merely said the word. Both of those are the wrong answer, and the second one
 * is why the stamp's own comment has to be written around the words it is about.
 *
 * Strings are not parsed, so a `//` inside one would cut the line short. Nothing in the two
 * files scanned here has one, and a scan that went wrong that way would fail rather than pass
 * quietly — it only ever removes text.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

/** Every `<script>` in a document that has no `src`, with its attributes and where it sits. */
function inlineScripts(html: string): { attributes: string; body: string; at: number }[] {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .map((found) => ({
      attributes: found[1] ?? "",
      body: found[2] ?? "",
      at: found.index ?? -1,
    }))
    .filter((script) => !script.attributes.includes("src"));
}

it("stamps the scheme before the first paint without a second copy of the narrowing", () => {
  const html = readFileSync(ENTRY_DOCUMENT, "utf8");
  const stamps = inlineScripts(html);

  expect(stamps).toHaveLength(1);
  const [stamp] = stamps;
  const body = withoutComments(stamp?.body ?? "");

  // It reads the key this module owns and writes the attribute this module owns, so renaming
  // either constant fails here rather than silently in a browser a student is looking at.
  expect(body).toContain(SCHEME_STORAGE_KEY);
  expect(body).toContain(SCHEME_ATTRIBUTE);

  // And it decides nothing about the value. `asSchemeChoice` is the single place a value from
  // outside becomes a choice; the stamp cannot import it, so instead of copying the rule it
  // narrows nothing and hands the string to `index.css`, which knows two values and treats the
  // rest as no attribute at all.
  //
  // Naming the two schemes is the obvious way to copy the rule, so that is checked first —
  // but it is not the only way, and a scan for those three words would be walked straight
  // past by `/^(dark|light)$/` or by `"da" + "rk"`. So the real assertion is the stronger and
  // simpler one below: **the only string literals in here are the two constants this module
  // exports, and there is no regular expression at all.** A narrowing needs something to
  // compare against, and there is nowhere left to put it.
  for (const name of SCHEME_CHOICES) {
    for (const quoted of [`"${name}"`, `'${name}'`, `\`${name}\``]) {
      expect(body, `${quoted} in the stamp is a second spelling of asSchemeChoice`).not.toContain(
        quoted,
      );
    }
  }

  const literals = (body.match(/"[^"]*"|'[^']*'|`[^`]*`/g) ?? []).map((found) =>
    found.slice(1, -1),
  );
  expect([...new Set(literals)].sort()).toEqual([SCHEME_STORAGE_KEY, SCHEME_ATTRIBUTE].sort());

  // No `/` at all, which is how a regex literal would have to start. The stamp has no use for
  // one, nor for a division, so the absence is cheap to require and it is what closes the
  // gap a name-scan alone leaves.
  expect(body).not.toContain("/");
});

/**
 * The entry module, read as source for the one thing no other test can see.
 *
 * Every assertion about `watchScheme` above and in `scheme.browser.test.tsx` starts the
 * watcher itself, because that is the only way to point it at a second document. So all of
 * them would still pass with the call taken out of `main.tsx` — a watcher nothing starts is
 * not a fix, and this is the line that says so. Importing the module instead would mount the
 * whole app and start polling the API, which is a different test's business.
 */
it("starts that watcher, and narrows the stamp, from the entry module", () => {
  const entry = withoutComments(
    readFileSync(fileURLToPath(new URL("main.tsx", import.meta.url)), "utf8"),
  );

  expect(entry).toContain("watchScheme(window");
  expect(entry).toContain("applyScheme(document.documentElement");
});

it("runs that stamp ahead of the paint it exists to beat", () => {
  const html = readFileSync(ENTRY_DOCUMENT, "utf8");
  const [stamp] = inlineScripts(html);

  // No attributes at all: a classic script, so not `type="module"` — which is deferred — and
  // carrying neither `defer` nor `async`. Any of those three and it runs after a paint, which
  // is the whole of what it is for and a change no palette assertion would notice.
  expect(stamp?.attributes.trim()).toBe("");

  // In `<head>`, and ahead of the module that would otherwise be the first thing to read the
  // store.
  expect(stamp?.at ?? -1).toBeGreaterThan(-1);
  expect(stamp?.at ?? -1).toBeLessThan(html.indexOf("</head>"));
  expect(stamp?.at ?? -1).toBeLessThan(html.indexOf('type="module"'));
});

/**
 * The `--dark-*` tokens are public on `:root` in every build, and only a comment says they
 * are not for reading. This is what makes that a rule: a component writing
 * `var(--dark-ink)` would be dark in the light scheme too, silently bypassing the choice —
 * the one failure the token indirection exists to prevent, and one no colour test would
 * catch, because the value it produced would be a perfectly valid colour.
 *
 * In the spirit of `tools/ci/workflows.test.ts`: a rule that only a comment states is a
 * rule that holds until someone is in a hurry.
 */
it("keeps the dark values behind the two rules that switch them", () => {
  /**
   * Two files may say it. `index.css` is the one that switches the tokens, so saying it is
   * its whole job — and this file names it in order to forbid it, which is the shape of
   * every rule of this kind.
   */
  const ALLOWED = ["index.css", "scheme.test.ts"];

  const web = fileURLToPath(new URL(".", import.meta.url));
  const reading = walk(web)
    .filter((file) => !ALLOWED.includes(basename(file)))
    .filter((file) => readFileSync(file, "utf8").includes("var(--dark-"));

  expect(reading.map((file) => relative(web, file))).toEqual([]);
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
