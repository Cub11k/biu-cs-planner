/// <reference types="@vitest/browser-playwright" />
/**
 * The document title follows the language (#310): `App` sets it in the same effect that sets
 * `lang` and `dir`, from the `appName` key in both tables. `index.html`'s static title is only
 * the first paint.
 *
 * A browser and `<App />`, because the claim is about the real document's title after an effect
 * has run. The fake server keeps the preference the way the real route does, so switching back is
 * a second real write and not a test that only checks the first flip.
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./index.css";
import { App } from "./App.tsx";
import { t } from "./i18n/strings.ts";

const ROOT = document.documentElement;
const FIRST_PAINT = "a title nothing in the app would set";

let host: HTMLElement | undefined;
let root: Root | undefined;
const realFetch = globalThis.fetch;
let language: string;
let version: number;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  language = "en";
  version = 1;
  ROOT.lang = "en";
  ROOT.dir = "ltr";
  // the baseline: a title the effect must replace, so the test cannot pass on the static one
  document.title = FIRST_PAINT;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);
    const method = init?.method ?? "GET";

    if (pathname === "/api/settings") {
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { language?: string; basedOn?: string };
        if (body.basedOn !== `v${version}`) {
          return json({ reason: "state-file-changed", warnings: [] }, 409);
        }
        if (body.language !== undefined) language = body.language;
        version += 1;
      }
      return json({ language, examSpacingDays: 3, version: `v${version}`, warnings: [] });
    }
    if (pathname === "/api/workspace/changes") return json({ changeCount: 0 });
    if (pathname === "/api/history") return json({ canUndo: false, canRedo: false });
    if (pathname.startsWith("/api/timetable")) {
      return json({ variantName: "A", picks: [], clashes: [], version: `v${version}`, warnings: [] });
    }
    return json({ offerings: [] });
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  ROOT.lang = "en";
  ROOT.dir = "ltr";
  globalThis.fetch = realFetch;
});

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(<App />);
  return host;
}

const languageSwitch = (mounted: HTMLElement): HTMLButtonElement => {
  const found = mounted.querySelector<HTMLButtonElement>("button[data-language]");
  if (found === null) throw new Error("the header has no language switch");
  return found;
};

it("names the document in the language on screen, and switches back with it", async () => {
  expect(t("en", "appName")).not.toBe(t("he", "appName"));
  const mounted = mount();

  await vi.waitFor(() => {
    expect(document.title).toBe(t("en", "appName"));
  });

  await vi.waitFor(() => {
    if (languageSwitch(mounted).disabled) throw new Error("the settings have not been read yet");
  });
  languageSwitch(mounted).click();
  await vi.waitFor(() => {
    expect(ROOT.lang).toBe("he");
    expect(document.title).toBe(t("he", "appName"));
  });

  await vi.waitFor(() => {
    if (languageSwitch(mounted).disabled) throw new Error("the change has not landed yet");
  });
  languageSwitch(mounted).click();
  await vi.waitFor(() => {
    expect(ROOT.lang).toBe("en");
    expect(document.title).toBe(t("en", "appName"));
  });
});
