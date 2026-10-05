/// <reference types="@vitest/browser-playwright" />
/**
 * The app shell as a student meets it (#294): a navigation bar over the screens that are built,
 * the Timetable first and landed on, the open screen in the URL's path so a reload and the back
 * button return to it, and the header's controls — undo, the scheme, the language — on every
 * screen. A browser, because what is under test is a click, the URL, `popstate`, a re-render and
 * a mirrored row.
 *
 * The second screen here is the test's own, handed to the shell as the registry hands it the real
 * ones. The shell knows no screen by name, so a screen of the test's own exercises exactly what
 * the Progress screen will, without the test depending on that screen's own fetches; and no
 * placeholder screen ships for it (the ticket's "it must not ship placeholder screens").
 *
 * The URL is the real one of the page the tests run in, moved with `history` and put back after
 * each test, because "the URL follows" is a claim about the real thing.
 */
import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./index.css";
import { AppShell, type ScreenDefinition, type ScreenProps } from "./AppShell.tsx";
import { t, type Language } from "./i18n/strings.ts";
import { SCHEME_ATTRIBUTE, SCHEME_STORAGE_KEY } from "./scheme.ts";
import { claimLaunchToken, TOKEN_STORAGE_KEY } from "./token.ts";
import { TIMETABLE_SCREEN } from "./timetable/TimetableScreen.tsx";

const ROOT = document.documentElement;
const TODAY = new Date(2026, 9, 15);

let host: HTMLElement | undefined;
let root: Root | undefined;
let startedAt: string;
const realFetch = globalThis.fetch;

/** What the fake server was asked, method and path, and with which body. */
let sent: Array<{ method: string; pathname: string; body: unknown }>;
let canUndo: boolean;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  startedAt = location.pathname + location.search + location.hash;
  sent = [];
  canUndo = false;
  ROOT.lang = "en";
  ROOT.dir = "ltr";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    const text = input instanceof Request ? await input.clone().text() : init?.body;
    sent.push({ method, pathname, body: typeof text === "string" && text !== "" ? JSON.parse(text) : undefined });

    if (pathname === "/api/history") return json({ canUndo, canRedo: false });
    if (pathname === "/api/history/undo") {
      canUndo = false;
      return json({ label: "set-programs", at: 1, version: "v2", canUndo: false, canRedo: true, warnings: [] });
    }
    if (pathname.startsWith("/api/timetable")) {
      return json({
        variantName: "A",
        variants: [],
        picks: [],
        clashes: [],
        variantWarnings: [],
        tray: [],
        blockedTimes: [],
        blockedTimeWarnings: [],
        version: "v1",
        warnings: [],
      });
    }
    return json({ warnings: [{ kind: "no-catalog-for-year", academicYear: 2027 }] }, 404);
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  ROOT.lang = "en";
  ROOT.dir = "ltr";
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(SCHEME_STORAGE_KEY);
  ROOT.removeAttribute(SCHEME_ATTRIBUTE);
  history.replaceState(null, "", startedAt);
  globalThis.fetch = realFetch;
});

/** How many times the second screen has been asked to re-read by a step, as it last rendered. */
let otherRereads = 0;

/**
 * A screen of the test's own: it says which screen it is, reports a revision so the shell can
 * step from it, and shows the shell's notices in its own live region, as a real screen does.
 */
function OtherScreen({ language, onRevision, stepRereads, notices }: ScreenProps): React.JSX.Element {
  otherRereads = stepRereads;
  // a new answer per re-read, as a real screen's re-read hands it a new one
  useEffect(() => {
    onRevision({ version: `v${stepRereads + 1}`, answer: { stepRereads } });
  }, [onRevision, stepRereads]);
  return (
    <main data-other-screen={language}>
      <p>other screen</p>
      <p role="status">{notices}</p>
    </main>
  );
}

const OTHER: ScreenDefinition = {
  path: "/other",
  label: "navScreens",
  render: (props) => <OtherScreen {...props} />,
};

const SCREENS: readonly ScreenDefinition[] = [TIMETABLE_SCREEN, OTHER];

async function mount(
  options: { language?: Language; onLanguage?: (language: Language) => void; screens?: readonly ScreenDefinition[] } = {},
): Promise<HTMLElement> {
  if (host === undefined) {
    host = document.createElement("div");
    document.body.append(host);
  }
  root?.unmount();
  root = createRoot(host);
  root.render(
    <AppShell
      screens={options.screens ?? SCREENS}
      language={options.language ?? "en"}
      onLanguage={options.onLanguage ?? (() => {})}
      today={TODAY}
    />,
  );
  const mounted = host;
  // `render` schedules the mount rather than performing it, so wait for the header it draws
  await vi.waitFor(() => {
    if (mounted.querySelector(`header[data-language-of="${options.language ?? "en"}"]`) === null) {
      throw new Error("the shell has not rendered");
    }
  });
  return mounted;
}

const nav = (mounted: HTMLElement): HTMLElement => {
  const found = mounted.querySelector<HTMLElement>("nav");
  if (found === null) throw new Error("the shell has no navigation");
  return found;
};

const link = (mounted: HTMLElement, path: string): HTMLAnchorElement => {
  const found = mounted.querySelector<HTMLAnchorElement>(`nav a[data-screen="${path}"]`);
  if (found === null) throw new Error(`the navigation has no link to ${path}`);
  return found;
};

const onTimetable = (mounted: HTMLElement): boolean =>
  mounted.querySelector("[data-week-grid], .week-grid, aside") !== null;
const onOther = (mounted: HTMLElement): boolean => mounted.querySelector("[data-other-screen]") !== null;

it("lands on the Timetable, and marks it open in the navigation", async () => {
  history.replaceState(null, "", "/");
  const mounted = await mount();

  await vi.waitFor(() => {
    if (!onTimetable(mounted)) throw new Error("the Timetable is not on screen");
  });
  expect(onOther(mounted)).toBe(false);
  expect(link(mounted, "/").getAttribute("aria-current")).toBe("page");
  expect(link(mounted, "/other").hasAttribute("aria-current")).toBe(false);
});

it("lands on the Timetable from a path no screen has, and leaves the URL alone", async () => {
  history.replaceState(null, "", "/no-such-screen");
  const mounted = await mount();

  await vi.waitFor(() => {
    if (!onTimetable(mounted)) throw new Error("the Timetable is not on screen");
  });
  expect(location.pathname).toBe("/no-such-screen");
});

it("switches screens from the navigation, and the URL follows", async () => {
  history.replaceState(null, "", "/");
  const mounted = await mount();

  link(mounted, "/other").click();

  await vi.waitFor(() => {
    if (!onOther(mounted)) throw new Error("the other screen never opened");
  });
  expect(onTimetable(mounted)).toBe(false);
  expect(location.pathname).toBe("/other");
  expect(link(mounted, "/other").getAttribute("aria-current")).toBe("page");
  expect(link(mounted, "/").hasAttribute("aria-current")).toBe(false);
});

it("returns to the screen it was on after a reload", async () => {
  history.replaceState(null, "", "/");
  let mounted = await mount();
  link(mounted, "/other").click();
  await vi.waitFor(() => {
    if (!onOther(mounted)) throw new Error("the other screen never opened");
  });

  // a reload is the page mounting again on the URL it was left on
  mounted = await mount();

  await vi.waitFor(() => {
    if (!onOther(mounted)) throw new Error("the reload did not return to the other screen");
  });
});

it("moves between screens with the browser's back and forward buttons", async () => {
  history.replaceState(null, "", "/");
  const mounted = await mount();
  link(mounted, "/other").click();
  await vi.waitFor(() => {
    if (!onOther(mounted)) throw new Error("the other screen never opened");
  });

  history.back();
  await vi.waitFor(() => {
    if (!onTimetable(mounted) || location.pathname !== "/") throw new Error("back did not return");
  });

  history.forward();
  await vi.waitFor(() => {
    if (!onOther(mounted) || location.pathname !== "/other") throw new Error("forward did not return");
  });
});

it("adds no history entry for a click on the screen already open", async () => {
  history.replaceState(null, "", "/");
  const mounted = await mount();
  const before = history.length;

  link(mounted, "/").click();

  expect(history.length).toBe(before);
  expect(location.pathname).toBe("/");
});

/**
 * ADR-0004: the Launch Token arrives in the fragment of the URL the launcher prints, and is taken
 * out of it before anything renders (`main.tsx`). With the screen in the path, the claim and the
 * route never touch the same part of the URL: the token is read, the fragment is cleaned, and the
 * screen the path names is the one that opens.
 */
it("still consumes the Launch Token's fragment, and opens the screen the path names", async () => {
  history.replaceState(null, "", "/other#t=Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ");

  const claimed = claimLaunchToken(window);
  const mounted = await mount();

  expect(claimed).toBe("Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ");
  expect(location.hash).toBe("");
  expect(location.pathname).toBe("/other");
  await vi.waitFor(() => {
    if (!onOther(mounted)) throw new Error("the path's screen did not open after the claim");
  });
});

it("undoes from the shell on whichever screen is open, based on that screen's revision", async () => {
  canUndo = true;
  history.replaceState(null, "", "/other");
  const mounted = await mount();

  const undo = await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLButtonElement>('button[data-history="undo"]');
    if (found === null || found.disabled) throw new Error("undo was never offered");
    return found;
  });
  undo.click();

  await vi.waitFor(() => {
    if (!sent.some((request) => request.pathname === "/api/history/undo")) {
      throw new Error("the undo never reached the API");
    }
  });
  expect(sent.find((request) => request.pathname === "/api/history/undo")?.body).toEqual({
    basedOn: "v1",
  });
  // the screen is asked to re-read, and the shell's account of the step is in its live region
  await vi.waitFor(() => {
    if (otherRereads !== 1) throw new Error("the screen was not asked to re-read");
  });
  await vi.waitFor(() => {
    const said = mounted.querySelector('[role="status"]')?.textContent ?? "";
    if (!said.includes(t("en", "undoneEdit", { edit: t("en", "editSetPrograms") }))) {
      throw new Error(`the step was not said on the open screen: ${said}`);
    }
  });
});

it("offers the language switch and the scheme control on every screen", async () => {
  history.replaceState(null, "", "/other");
  const chosen: Language[] = [];
  const mounted = await mount({ onLanguage: (language) => chosen.push(language) });

  mounted.querySelector<HTMLButtonElement>("button[data-language]")?.click();
  expect(chosen).toEqual(["he"]);

  const scheme = mounted.querySelector<HTMLSelectElement>("header select");
  expect(scheme).not.toBeNull();
  scheme!.value = "dark";
  scheme!.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => {
    if (ROOT.getAttribute(SCHEME_ATTRIBUTE) !== "dark") throw new Error("the scheme did not apply");
  });
});

it("is a navigation landmark named in the student's language", async () => {
  history.replaceState(null, "", "/");
  const english = await mount();
  expect(nav(english).getAttribute("aria-label")).toBe(t("en", "navScreens"));

  const hebrew = await mount({ language: "he" });
  expect(nav(hebrew).getAttribute("aria-label")).toBe(t("he", "navScreens"));
  expect(link(hebrew, "/").textContent).toBe(t("he", "timetable"));
});

it("mirrors the navigation right to left in Hebrew", async () => {
  history.replaceState(null, "", "/");
  const mounted = await mount({ language: "he" });

  const first = link(mounted, "/").getBoundingClientRect();
  const second = link(mounted, "/other").getBoundingClientRect();
  const header = mounted.querySelector("header")!.getBoundingClientRect();

  // the first screen sits at the start, which is the right in Hebrew
  expect(first.left).toBeGreaterThan(second.left);
  expect(header.right - first.right).toBeLessThan(first.left - header.left);
});

it("leaves the navigation out when there is only one screen to go to", async () => {
  history.replaceState(null, "", "/");
  const mounted = await mount({ screens: [TIMETABLE_SCREEN] });

  expect(mounted.querySelector("nav")).toBeNull();
  expect(mounted.querySelector("h1")?.textContent).toBe(t("en", "timetable"));
});
