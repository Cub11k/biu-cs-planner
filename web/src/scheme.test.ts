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
  rememberScheme,
  schemeStore,
  storedScheme,
  type SchemeBrowser,
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

/** An element that only records what was done to it. */
function element() {
  const attributes = new Map<string, string>();
  const stamp: SchemeElement = {
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
  };
  return { stamp, attributes };
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
