/// <reference types="@vitest/browser-playwright" />
/**
 * Light and dark as a browser resolves them, in all three states (#114).
 *
 * This is a browser test because the claim is entirely about the cascade: which rule wins
 * when `prefers-color-scheme` and a `data-theme` attribute disagree. `renderToStaticMarkup`
 * returns a string and jsdom has no cascade, so neither can answer it (issue #45).
 *
 * The three states are light chosen, dark chosen, and **nothing chosen**, where the
 * operating system must still decide exactly as it did before this existed. A test of two
 * of them would pass with the guard removed from the media query, which is the defect the
 * ticket names as the likely one.
 *
 * Almost every assertion is an equality against one of two palettes captured from the
 * operating system itself, rather than a hex value written here. A test holding its own
 * copy of the palette would have to be edited whenever a hue was tuned, and an assertion
 * you edit to make it pass has stopped being one.
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import "./index.css";
// The entry document as it is on disk, not as a dev server hands it over: `?raw` is read at
// transform time, so nothing has injected or rewritten anything by the time a test sees it.
import ENTRY_DOCUMENT from "../index.html?raw";
import { LANGUAGES, t, type Language } from "./i18n/strings.ts";
import {
  SCHEME_ATTRIBUTE,
  SCHEME_CHOICES,
  SCHEME_STORAGE_KEY,
  applyScheme,
  rememberScheme,
  schemeStore,
  storedScheme,
  watchScheme,
  type SchemeChoice,
  type SchemeElement,
} from "./scheme.ts";
import { SchemeControl } from "./SchemeControl.tsx";

const ROOT = document.documentElement;

/** Emulates the media feature the dark scheme keys off, then waits for a style pass. */
async function operatingSystem(scheme: "light" | "dark"): Promise<void> {
  const session = await cdp();
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/**
 * The names of the tokens the dark scheme redefines, read out of the document rather than
 * listed here.
 *
 * `index.css` writes the dark values once as `--dark-*` and assigns them in two rules, so
 * every one of those names is a token this test must check in both. Derived, so a token
 * added to the palette later is covered without anyone remembering to add it here — the
 * failure mode of a hand-written list is that it silently stops being the palette.
 */
function darkTokenNames(root: Element = ROOT): string[] {
  return [...resolved(root)].filter((name) => name.startsWith("--dark-"));
}

/**
 * An element's resolved style, from its own window.
 *
 * Parameterised because half of what is under test lives in a second document — a `<html>`
 * in an iframe — and `getComputedStyle` has to be that document's own.
 */
function resolved(root: Element): CSSStyleDeclaration {
  const view = root.ownerDocument.defaultView;
  if (view === null) throw new Error("that element's document has no window");
  return view.getComputedStyle(root);
}

/** Every token the scheme changes, as a document currently resolves it. */
function palette(root: Element = ROOT): Record<string, string> {
  const computed = resolved(root);
  return Object.fromEntries(
    darkTokenNames(root).map((dark) => {
      const token = dark.replace("--dark-", "--");
      return [token, computed.getPropertyValue(token).trim()];
    }),
  );
}

/** `#16324f` as a browser reports a resolved colour, so the two can be compared. */
function asRgb(hex: string): string {
  const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((at) =>
    Number.parseInt(hex.slice(at, at + 2), 16),
  );
  return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * The two palettes the operating system produces with no choice made. Captured once, and
 * then everything else is measured against them.
 */
let systemLight: Record<string, string>;
let systemDark: Record<string, string>;

beforeAll(async () => {
  applyScheme(ROOT, "system");
  await operatingSystem("light");
  systemLight = palette();
  await operatingSystem("dark");
  systemDark = palette();
  await operatingSystem("light");
});

let host: HTMLElement | undefined;
let root: Root | undefined;
/** The second tabs a test opened, and the watchers it started, both torn down after it. */
const frames: HTMLIFrameElement[] = [];
const stops: (() => void)[] = [];

beforeEach(() => {
  localStorage.removeItem(SCHEME_STORAGE_KEY);
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const frame of frames.splice(0)) frame.remove();
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  localStorage.removeItem(SCHEME_STORAGE_KEY);
  applyScheme(ROOT, "system");
  await operatingSystem("light");
});

describe("the palettes this test measures against", () => {
  it("found the tokens in the document rather than an empty list", () => {
    // Without this, every equality below would be a comparison of two empty objects and
    // the whole file would pass against a stylesheet with no dark scheme in it at all.
    expect(darkTokenNames().length).toBeGreaterThan(10);
    expect(Object.keys(systemLight)).toEqual(Object.keys(systemDark));
  });

  it("is two different palettes, the darker one being the dark one", () => {
    expect(systemLight).not.toEqual(systemDark);

    // Which is which, said once, so the equalities below cannot be satisfied by the two
    // names having been swapped: paper is the light thing and ink is written on it, and in
    // the dark that has turned over.
    expect(systemLight["--paper"]).not.toBe(systemDark["--paper"]);
    expect(Number.parseInt(systemLight["--paper"]?.slice(1) ?? "", 16)).toBeGreaterThan(
      Number.parseInt(systemDark["--paper"]?.slice(1) ?? "", 16),
    );
  });
});

describe("with no explicit choice", () => {
  it("follows a light operating system", async () => {
    await operatingSystem("light");
    expect(ROOT.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(palette()).toEqual(systemLight);
  });

  it("follows a dark operating system, exactly as before there was a choice", async () => {
    await operatingSystem("dark");
    expect(ROOT.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(palette()).toEqual(systemDark);
  });

  it("leaves both schemes available, so the machine decides native controls too", async () => {
    await operatingSystem("dark");
    expect(getComputedStyle(ROOT).colorScheme).toBe("light dark");
  });
});

describe("an explicit light choice", () => {
  it("beats a dark operating system", async () => {
    await operatingSystem("dark");
    applyScheme(ROOT, "light");

    // The direction a bare media query cannot do: the machine says dark and the student
    // says light, and the student wins.
    expect(palette()).toEqual(systemLight);
  });

  it("is the same light palette a light machine gets", async () => {
    await operatingSystem("dark");
    applyScheme(ROOT, "light");
    const chosen = palette();
    await operatingSystem("light");
    applyScheme(ROOT, "system");

    expect(chosen).toEqual(palette());
  });

  it("narrows the scheme, so a native drop-down is light on a dark machine", async () => {
    await operatingSystem("dark");
    applyScheme(ROOT, "light");

    expect(getComputedStyle(ROOT).colorScheme).toBe("light");
  });
});

describe("an explicit dark choice", () => {
  it("beats a light operating system", async () => {
    await operatingSystem("light");
    applyScheme(ROOT, "dark");

    expect(palette()).toEqual(systemDark);
  });

  it("is the same dark palette a dark machine gets, token for token", async () => {
    // The drift guard. `index.css` has to assign the dark tokens in two rules, because no
    // single declaration block can sit behind both "the machine said dark" and "the student
    // said dark". This is what makes those two rules one palette rather than two.
    await operatingSystem("light");
    applyScheme(ROOT, "dark");

    expect(palette()).toEqual(systemDark);
    for (const [token, value] of Object.entries(palette())) {
      expect(value, `${token} differs between an explicit dark choice and a dark machine`)
        .toBe(systemDark[token]);
    }
  });

  it("narrows the scheme, so a native drop-down is dark on a light machine", async () => {
    await operatingSystem("light");
    applyScheme(ROOT, "dark");

    expect(getComputedStyle(ROOT).colorScheme).toBe("dark");
  });
});

it("treats a data-theme value it does not know as no choice at all", async () => {
  // Storage is data from outside the program. `scheme.ts` writes only the two names, but a
  // stylesheet that fell through to neither palette would leave a student with an unstyled
  // page, so the machine still decides.
  await operatingSystem("dark");
  ROOT.setAttribute(SCHEME_ATTRIBUTE, "solarized");

  expect(palette()).toEqual(systemDark);
});

/** The control, mounted after an optional remembered choice, with a Tab target before it. */
async function openControl(
  language: Language,
): Promise<{ select: HTMLSelectElement; before: HTMLElement; label: HTMLLabelElement }> {
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);

  // A button ahead of the control, so "reachable by Tab" is asked from a known place
  // rather than from wherever the previous test left the focus.
  const before = document.createElement("button");
  before.textContent = "before";
  mounted.append(before);

  const into = document.createElement("div");
  mounted.append(into);
  root = createRoot(into);
  root.render(<SchemeControl language={language} />);

  // `render` schedules the work rather than doing it, so the control is waited for. Its
  // effect — the stamp on `<html>` — lands after the paint that follows.
  const select = await vi.waitFor(() => {
    const found = into.querySelector("select");
    if (found === null) throw new Error("the control rendered no select");
    return found;
  });

  const label = into.querySelector("label");
  if (label === null) throw new Error("the control rendered no label");
  return { select, before, label };
}

describe.each(LANGUAGES)("the control in %s", (language) => {
  it("names itself and its three choices from the translation files", async () => {
    const { select, label } = await openControl(language);

    // A real `<label for>` association, the way `CoursePicker` labels its search field.
    expect(label.textContent).toBe(t(language, "schemeLabel"));
    expect(select.id).not.toBe("");
    expect(label.htmlFor).toBe(select.id);
    expect([...select.options].map((option) => option.value)).toEqual([...SCHEME_CHOICES]);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      t(language, "schemeSystem"),
      t(language, "schemeLight"),
      t(language, "schemeDark"),
    ]);

    // …and they are translations rather than one string shown twice: the Hebrew screen
    // showing English words is the failure this catches.
    if (language === "he") {
      expect(label.textContent).not.toBe(t("en", "schemeLabel"));
    }
  });

  it("starts on the choice this browser remembers", async () => {
    localStorage.setItem(SCHEME_STORAGE_KEY, "dark");
    await operatingSystem("light");
    const { select } = await openControl(language);

    await vi.waitFor(() => {
      expect(ROOT.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
    });
    expect(select.value).toBe("dark");
    expect(palette()).toEqual(systemDark);
  });

  it("applies and remembers a choice, and gives the decision back", async () => {
    await operatingSystem("light");
    const { select } = await openControl(language);

    select.value = "dark";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(ROOT.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
    });
    expect(palette()).toEqual(systemDark);
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe("dark");

    // Back to the machine, which is the third state and the reason this is not a toggle.
    select.value = "system";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(ROOT.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    });
    expect(palette()).toEqual(systemLight);
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe(null);
  });

});

/**
 * The keyboard and the focus ring, asked once rather than per language: nothing in either
 * depends on the words in the control, and `en` and `he` were two reports of one fact.
 */
describe("the control's keyboard and focus", () => {
  const language = "en" as Language;

it("is reachable by Tab", async () => {
  const { select, before } = await openControl(language);
  before.focus();

  await userEvent.tab();

  expect(document.activeElement).toBe(select);
});

it.each([
  { where: "a light machine", os: "light", choice: "system", ink: "light" },
  { where: "a dark machine", os: "dark", choice: "system", ink: "dark" },
  { where: "an explicit dark choice, on a light machine", os: "light", choice: "dark", ink: "dark" },
  { where: "an explicit light choice, on a dark machine", os: "dark", choice: "light", ink: "light" },
] as const)("shows the stylesheet's own focus ring, on $where", async ({ os, choice, ink }) => {
  /**
   * Chromium draws a focus ring of its own, so `matches(":focus-visible")` alone would
   * pass with `index.css`'s rule deleted — that has happened in this repo before. What is
   * asserted instead is the ring *that rule* makes: a solid 2px outline in `--ink`, where
   * the user agent's is `auto` and 1px in a colour of its own.
   *
   * Asked in all four combinations, because a ring is only visible if it follows the
   * tokens — and an explicit choice is exactly the case where the ring could be left
   * reading the machine's `--ink` while the page around it used the chosen one.
   */
  await operatingSystem(os);
  // Through storage rather than `applyScheme`, because the control stamps the document
  // itself as it mounts: a scheme set here by hand would be overwritten a frame later.
  if (choice !== "system") localStorage.setItem(SCHEME_STORAGE_KEY, choice);

  const { select, before } = await openControl(language);
  if (choice !== "system") {
    await vi.waitFor(() => {
      expect(ROOT.getAttribute(SCHEME_ATTRIBUTE)).toBe(choice);
    });
  }

  before.focus();
  await userEvent.tab();

  expect(select.matches(":focus-visible")).toBe(true);
  const ring = getComputedStyle(select);
  expect(ring.outlineStyle).toBe("solid");
  expect(ring.outlineWidth).toBe("2px");
  expect(ring.outlineColor).toBe(asRgb((ink === "dark" ? systemDark : systemLight)["--ink"] ?? ""));
});
});

/**
 * The real `web/index.html`, with every external script removed, in an iframe. This is how
 * both halves of #146 become askable in a browser: what a page looks like before its module
 * has run, and what a second tab does when the first one chooses.
 *
 * An iframe is a second browsing context on the same origin, so it shares this page's
 * `localStorage` and the browser decides on its own which documents hear a `storage` event —
 * which is the whole point, because the fact under test is *who is not told*. A fake that
 * declined to deliver the event to the writer would be asserting its own manners.
 *
 * Removing `script[src]` — `main.tsx` — is what holds the first paint still. The claim is
 * about the moment before the deferred module runs, and there is no asking a browser to
 * pause one; a document served without it is that moment, and nothing else in it can have
 * set the attribute. `srcdoc` rather than navigating to the URL for the same reason.
 *
 * `index.css` is linked because `main.tsx` is the thing that imports it, and it is gone. An
 * attribute nothing reads is not a palette, so without the stylesheet the interesting
 * assertion — the tokens resolve dark before the first paint — could not be made at all.
 *
 * With `stamp: false` the inline script goes too, which gives every test its own control:
 * the same document, the same store, the same machine, and the one line removed.
 *
 * With `modules: true` the module script is kept instead, pointed at where the dev server
 * actually serves it, so **`main.tsx` runs and the app mounts**. That is a different question
 * from the first paint and the only way to ask it: what a student actually gets. A module that
 * throws before `createRoot` leaves a blank page, and nothing about the first paint can see it.
 *
 * With `store: "blocked"` the document gets a store that throws on every access, ahead of the
 * stamp — a browser in a mode where the store is switched off. That is the stamp's own `catch`
 * under test rather than a stand-in for it. The same script records any uncaught error onto
 * `<html>`, because a stamp with no `catch` leaves exactly the same *page* as one with it: no
 * attribute either way, since the throw happens on the line that would have set it. What the
 * `catch` is worth is that nothing is thrown at all, and that has to be looked at directly.
 */
async function entryDocument({
  stamp = true,
  store = "working",
  modules = false,
}: { stamp?: boolean; store?: "working" | "blocked"; modules?: boolean } = {}): Promise<Document> {
  const parsed = new DOMParser().parseFromString(ENTRY_DOCUMENT, "text/html");

  for (const external of parsed.querySelectorAll("script[src]")) {
    // `index.html` names `/src/main.tsx`, which is right for a server rooted at `web/`; the
    // one running these tests is rooted at the repository, so the path is retargeted rather
    // than the script rewritten. Everything else external goes either way.
    const src = external.getAttribute("src");
    if (modules && src === "/src/main.tsx") external.setAttribute("src", "/web/src/main.tsx");
    else external.remove();
  }
  if (!stamp) for (const inline of parsed.querySelectorAll("script")) inline.remove();

  if (store === "blocked") {
    const block = parsed.createElement("script");
    block.textContent = `window.addEventListener("error", (failure) => {
      document.documentElement.dataset.stampError = String(failure.message);
    });
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("the store is switched off");
      },
    });`;
    parsed.head.prepend(block);
  }

  const styles = parsed.createElement("link");
  styles.rel = "stylesheet";
  styles.href = "/web/src/index.css";
  parsed.head.append(styles);

  const frame = document.createElement("iframe");
  frames.push(frame);
  frame.srcdoc = `<!doctype html>${parsed.documentElement.outerHTML}`;
  document.body.append(frame);
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));

  const loaded = frame.contentDocument;
  if (loaded === null) throw new Error("the entry document did not load");
  return loaded;
}

/** Starts a watcher inside another document, on that document's own window and store. */
function watchIn(document: Document, element: SchemeElement): void {
  const view = document.defaultView;
  if (view === null) throw new Error("that document has no window");
  stops.push(watchScheme(view, { localStorage: view.localStorage }, element));
}

describe("the first paint, before any module has run", () => {
  it("is the remembered dark scheme on a light machine, and the stamp is what makes it so", async () => {
    localStorage.setItem(SCHEME_STORAGE_KEY, "dark");
    await operatingSystem("light");

    const stamped = await entryDocument();
    expect(stamped.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
    expect(palette(stamped.documentElement)).toEqual(systemDark);

    // The control, and the reason this test means anything: a first-paint assertion passes
    // very easily because the page happened to already be in the scheme it asserted. Same
    // document, same store, same machine, with the stamp taken out — and it is light.
    const bare = await entryDocument({ stamp: false });
    expect(bare.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(palette(bare.documentElement)).toEqual(systemLight);
  });

  it("is the remembered light scheme on a dark machine, the direction a media query cannot do", async () => {
    localStorage.setItem(SCHEME_STORAGE_KEY, "light");
    await operatingSystem("dark");

    const stamped = await entryDocument();
    expect(stamped.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("light");
    expect(palette(stamped.documentElement)).toEqual(systemLight);

    const bare = await entryDocument({ stamp: false });
    expect(palette(bare.documentElement)).toEqual(systemDark);
  });

  it("follows the machine with nothing remembered, in both directions", async () => {
    // The third state at the earliest moment it exists. A stamp that wrote something for a
    // browser it had never been told about would be a third palette, which is what the
    // no-choice state is deliberately not.
    await operatingSystem("light");
    const light = await entryDocument();
    expect(light.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(palette(light.documentElement)).toEqual(systemLight);

    await operatingSystem("dark");
    const dark = await entryDocument();
    expect(dark.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(palette(dark.documentElement)).toEqual(systemDark);
  });

  it("leaves a stored value it does not recognise to the stylesheet, and the module clears it", async () => {
    // The stamp narrows nothing, on purpose: `asSchemeChoice` is the only narrowing and the
    // stamp cannot import it. So an unrecognised value does reach the attribute, and the
    // stylesheet is what makes that harmless — it matches two values and treats the rest as
    // no attribute at all. A student on a dark machine still sees a dark page.
    localStorage.setItem(SCHEME_STORAGE_KEY, "solarized");
    await operatingSystem("dark");

    const stamped = await entryDocument();
    expect(stamped.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("solarized");
    expect(palette(stamped.documentElement)).toEqual(systemDark);

    // …and then the narrowing catches up. This is `main.tsx`'s line, run against that
    // document: the value the stylesheet ignored is gone from the document as well.
    applyScheme(stamped.documentElement, storedScheme(schemeStore()));
    expect(stamped.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(palette(stamped.documentElement)).toEqual(systemDark);
  });

  it("paints the machine's scheme when the store throws instead of answering", async () => {
    // A browser with the store switched off, which is the one case where the stamp is a line
    // that can throw *before* anything at all has rendered. It has to leave a working page,
    // and the page it leaves is the operating system's.
    localStorage.setItem(SCHEME_STORAGE_KEY, "light");
    await operatingSystem("dark");

    const blocked = await entryDocument({ store: "blocked" });

    expect(blocked.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(palette(blocked.documentElement)).toEqual(systemDark);
    expect(blocked.getElementById("root")).not.toBeNull();
    // And it threw nothing on the way. Without this line the `catch` could be deleted and no
    // assertion here would move, because the page a throw leaves is the same page.
    expect(blocked.documentElement.dataset["stampError"]).toBeUndefined();
  });

  it("still mounts the app when the store is blocked, which is the page a student gets", async () => {
    /**
     * Criterion 3 of #146 in full, and the one form of it the tests above cannot reach: they
     * load the entry document with its module removed, so a module that throws is invisible
     * to them by construction.
     *
     * The trap is that `typeof` does not make a global safe to touch. It suppresses a
     * `ReferenceError` for an *undeclared* name, but `localStorage` is a declared property of
     * the global object, so `typeof localStorage` invokes the getter — and in a browser with
     * site data blocked that getter throws. `schemeStore` is called twice at the top of
     * `main.tsx`, before `createRoot`, so the whole module aborts and React never mounts.
     * `token.ts`'s `storedToken` gets this right by reading inside its `try`.
     *
     * "A working page" is therefore asserted as React having mounted, not as the palette
     * being right — a blank page in the operating system's scheme would satisfy every other
     * assertion in this file.
     */
    localStorage.setItem(SCHEME_STORAGE_KEY, "dark");
    await operatingSystem("light");

    const blocked = await entryDocument({ modules: true, store: "blocked" });

    await vi.waitFor(
      () => {
        expect(blocked.getElementById("root")?.childElementCount ?? 0).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );

    // Blocked, so nothing is remembered: no attribute, and the machine decides.
    expect(blocked.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(palette(blocked.documentElement)).toEqual(systemLight);
    // And nothing threw on the way — neither the stamp nor the module.
    expect(blocked.documentElement.dataset["stampError"]).toBeUndefined();

    // The control, so this cannot pass for a reason unrelated to the store: the same document
    // with a store that answers mounts too, and there the remembered choice is applied.
    const working = await entryDocument({ modules: true });
    await vi.waitFor(
      () => {
        expect(working.getElementById("root")?.childElementCount ?? 0).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
    expect(working.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
  });

  it("paints the machine's scheme with no script at all, which is JavaScript switched off", async () => {
    // Before the stamp runs, or where it never will: the same page every student had before
    // there was a choice, and no control on it to change the scheme.
    localStorage.setItem(SCHEME_STORAGE_KEY, "light");
    await operatingSystem("dark");
    const bare = await entryDocument({ stamp: false });

    expect(bare.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(palette(bare.documentElement)).toEqual(systemDark);
  });
});

describe("a second tab on the same origin", () => {
  it("follows a choice made in another tab, without a reload", async () => {
    await operatingSystem("light");
    const second = await entryDocument();
    watchIn(second, second.documentElement);

    // The choice is made here, in this document, exactly the way the control makes it.
    // Nothing reaches into the other one.
    rememberScheme(schemeStore(), "dark");

    await vi.waitFor(() => {
      expect(second.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
    });
    expect(palette(second.documentElement)).toEqual(systemDark);

    // And back to the machine, which is the third state arriving through the event: the key
    // going away has to reach the other tab too, not just a new value.
    rememberScheme(schemeStore(), "system");
    await vi.waitFor(() => {
      expect(second.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    });
    expect(palette(second.documentElement)).toEqual(systemLight);
  });

  it("does not tell the tab that made the choice, so nothing is applied twice", async () => {
    // A `storage` event is not delivered to the document that wrote the value. That is what
    // makes a double-apply impossible rather than merely unlikely, and it is the browser's
    // fact, so it is asked where a browser answers.
    await operatingSystem("light");

    // A watcher in *this* document, aimed at a throwaway element, so that "it never fired"
    // is something an assertion can see.
    const writer = document.createElement("div");
    watchIn(document, writer);

    const second = await entryDocument();
    watchIn(second, second.documentElement);

    rememberScheme(schemeStore(), "dark");

    await vi.waitFor(() => {
      expect(second.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
    });
    // The other tab has heard, so the event has landed everywhere it is going to. This tab's
    // watcher was never called: same store, same key, same moment. The tab holding the
    // control applies its choice once, through the control.
    expect(writer.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
  });

  it("narrows what arrives, so an unrecognised value hands the decision back", async () => {
    await operatingSystem("light");
    const second = await entryDocument();
    watchIn(second, second.documentElement);

    rememberScheme(schemeStore(), "dark");
    await vi.waitFor(() => {
      expect(second.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
    });

    // Something the app never wrote — devtools, or another build's idea of this key. The
    // watcher re-reads through `storedScheme`, so it is no choice at all rather than an
    // attribute the stylesheet has to go on ignoring.
    localStorage.setItem(SCHEME_STORAGE_KEY, "solarized");
    await vi.waitFor(() => {
      expect(second.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    });
    expect(palette(second.documentElement)).toEqual(systemLight);
  });

  it("goes back to the machine when the store is emptied under it", async () => {
    // `localStorage.clear()` reports no key at all, because every key changed. A browser
    // reset or a devtools clear leaves the page following the operating system, which is the
    // state that is never wrong, rather than a scheme nothing in the store agrees with.
    localStorage.setItem(SCHEME_STORAGE_KEY, "light");
    await operatingSystem("dark");

    const second = await entryDocument();
    expect(second.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("light");
    watchIn(second, second.documentElement);

    localStorage.clear();

    await vi.waitFor(() => {
      expect(second.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    });
    expect(palette(second.documentElement)).toEqual(systemDark);
  });

  it("stops following once its watcher is stopped", async () => {
    // The stop function is what a component would use. `main.tsx` does not, because there the
    // listener lives as long as the page, so this is the only place it is exercised.
    await operatingSystem("light");
    const second = await entryDocument();
    const view = second.defaultView;
    if (view === null) throw new Error("that document has no window");
    const stop = watchScheme(view, { localStorage: view.localStorage }, second.documentElement);

    rememberScheme(schemeStore(), "dark");
    await vi.waitFor(() => {
      expect(second.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
    });

    stop();

    // A third tab, opened while the store already says dark, so its stamp puts dark on it and
    // the change below can only reach it through the event. That is what makes the assertion
    // about the stopped tab mean anything: the event was delivered, and it was ignored there.
    const third = await entryDocument();
    expect(third.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
    watchIn(third, third.documentElement);

    rememberScheme(schemeStore(), "light");
    await vi.waitFor(() => {
      expect(third.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("light");
    });

    expect(second.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
  });
});
