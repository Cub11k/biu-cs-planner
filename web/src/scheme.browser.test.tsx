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
import { LANGUAGES, t, type Language } from "./i18n/strings.ts";
import {
  SCHEME_ATTRIBUTE,
  SCHEME_CHOICES,
  SCHEME_STORAGE_KEY,
  applyScheme,
  type SchemeChoice,
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
function darkTokenNames(): string[] {
  return [...getComputedStyle(ROOT)].filter((name) => name.startsWith("--dark-"));
}

/** Every token the scheme changes, as this document currently resolves it. */
function palette(): Record<string, string> {
  const computed = getComputedStyle(ROOT);
  return Object.fromEntries(
    darkTokenNames().map((dark) => {
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

beforeEach(() => {
  localStorage.removeItem(SCHEME_STORAGE_KEY);
});

afterEach(async () => {
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
): Promise<{ select: HTMLSelectElement; before: HTMLElement }> {
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

  return { select, before };
}

describe.each(LANGUAGES)("the control in %s", (language) => {
  it("names itself and its three choices from the translation files", async () => {
    const { select } = await openControl(language);

    expect(select.getAttribute("aria-label")).toBe(t(language, "schemeLabel"));
    expect([...select.options].map((option) => option.value)).toEqual([...SCHEME_CHOICES]);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      t(language, "schemeSystem"),
      t(language, "schemeLight"),
      t(language, "schemeDark"),
    ]);

    // …and they are translations rather than one string shown twice: the Hebrew screen
    // showing English words is the failure this catches.
    if (language === "he") {
      expect(select.getAttribute("aria-label")).not.toBe(t("en", "schemeLabel"));
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

  it("is reachable by Tab", async () => {
    const { select, before } = await openControl(language);
    before.focus();

    await userEvent.tab();

    expect(document.activeElement).toBe(select);
  });

  it.each(["light", "dark"] as const)(
    "shows the stylesheet's own focus ring, in the %s scheme",
    async (scheme) => {
      /**
       * Chromium draws a focus ring of its own, so `matches(":focus-visible")` alone would
       * pass with `index.css`'s rule deleted — that has happened in this repo before. What
       * is asserted instead is the ring *that rule* makes: a solid 2px outline in `--ink`,
       * where the user agent's is `auto` and 1px in a colour of its own. It is checked in
       * both schemes, because a ring is only visible if it follows the tokens.
       */
      await operatingSystem(scheme === "dark" ? "dark" : "light");
      const { select, before } = await openControl(language);
      before.focus();
      await userEvent.tab();

      expect(select.matches(":focus-visible")).toBe(true);
      const ring = getComputedStyle(select);
      expect(ring.outlineStyle).toBe("solid");
      expect(ring.outlineWidth).toBe("2px");

      const ink = (scheme === "dark" ? systemDark : systemLight)["--ink"] ?? "";
      expect(ring.outlineColor).toBe(asRgb(ink));
    },
  );
});
