/// <reference types="@vitest/browser-playwright" />
/**
 * A page whose launch token has been retired, as a student meets it (#126).
 *
 * `biu-cs-planner rotate-token` replaces the token and the next start of the app refuses every
 * tab still holding the old one (ADR-0004). What those tabs were told was wrong in two ways:
 * the screen said *"This page has no launch token"* — the page has one, it is the old one — and
 * the page never found out on its own, because `changes.ts` discarded a refused poll, so a
 * loaded tab kept showing what it had last read and looked healthy until a reload or a click.
 *
 * A browser and `<App />` rather than the modules, because every part of the claim is outside
 * what a module test can answer: the token comes out of `localStorage`, the poll is a real
 * interval, and the sentence is in a live region on a mounted page.
 *
 * **The order of the fake is the criterion.** Serve 200s, let the page read them, *then* refuse
 * everything with a 401 and look at the screen without touching it.
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the name and the times are not,
 * and no crawled data is committed to this repo (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./index.css";
import { App } from "./App.tsx";
import { t } from "./i18n/strings.ts";
import { TOKEN_STORAGE_KEY } from "./token.ts";
import type { Offering } from "./timetable/catalog.ts";

const ROOT = document.documentElement;

/** Shaped as the server generates them: 32 random bytes as base64url (`token.ts`). */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

const OFFERING: Offering = {
  courseNumber: "89-110",
  nameHebrew: "מבוא למדעי המחשב",
  nameEnglish: "Introduction to Computer Science",
  credits: { known: true, total: 5 },
  semesters: ["fall"],
  groups: [
    {
      number: "01",
      lessonType: "הרצאה",
      lecturers: [],
      meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
    },
  ],
  exams: { known: false, sittings: [] },
};

let host: HTMLElement | undefined;
let root: Root | undefined;
const realFetch = globalThis.fetch;

/** Whether the server refuses every request, as it does from the start after a rotation. */
let refuseEverything: boolean;
/** The Picks the fake's State File holds, so the week has something to lose. */
let picks: unknown[];
let changeCount: number;
let sent: string[];

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const PICK = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

beforeEach(() => {
  refuseEverything = false;
  picks = [PICK];
  changeCount = 0;
  sent = [];
  ROOT.lang = "en";
  ROOT.dir = "ltr";
  // No token in the store is the default, so a test that wants one puts it there. The store is
  // per origin and survives a test, which is why it is cleared here as well as afterwards.
  localStorage.removeItem(TOKEN_STORAGE_KEY);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);

    sent.push(pathname);
    // Exactly what the guard answers, and it answers it the same way for a wrong token and for
    // no token at all — which is why the page has to tell the two apart from its own side.
    if (refuseEverything) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    if (pathname === "/api/settings") {
      return json({ language: "en", examSpacingDays: 3, version: "v1", warnings: [] });
    }
    if (pathname === "/api/workspace/changes") return json({ changeCount });
    if (pathname === "/api/history") return json({ canUndo: false, canRedo: false });
    if (pathname.startsWith("/api/timetable")) {
      return json({ variantName: "A", picks, clashes: [], version: "v1", warnings: [] });
    }
    return json({ offerings: [OFFERING] });
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
  globalThis.fetch = realFetch;
});

function mount(): HTMLElement {
  if (host === undefined) {
    host = document.createElement("div");
    document.body.append(host);
  }
  root?.unmount();
  root = createRoot(host);
  root.render(<App />);
  return host;
}

/** Everything on screen, both panes: the sidebar says one of these and the hint line the other. */
const onScreen = (mounted: HTMLElement): string => mounted.textContent ?? "";

/** A 401 answered from here on, the way a restarted app refuses a tab holding the old token. */
function refuseFromNowOn(): void {
  refuseEverything = true;
}

/** Long enough for the Workspace poll to ask again on its own clock (`DEFAULT_EVERY_MS`). */
const POLL = { timeout: 8000, interval: 100 } as const;

/**
 * **The criterion the ticket is named for.** A page holding a token that the app refuses says
 * its token was refused, and does **not** say it has none — which is what a student who reads
 * carefully would go looking for a token they can see is present.
 */
it("says a held launch token was refused, rather than claiming the page has none", async () => {
  localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
  const mounted = mount();
  // the 200s landed first: there is a week on screen, with a Pick in it
  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "picksCountOne"));
  });

  refuseFromNowOn();

  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "tokenRetired"));
  }, POLL);
  expect(onScreen(mounted)).not.toContain(t("en", "catalogUnauthorized"));
});

/**
 * …and the sentence that was always right stays right. A page opened with no token at all is a
 * real state — a bookmark on a browser whose storage was cleared, a fresh window on the port —
 * and "this page has no launch token" is true of exactly that one.
 */
it("still says a page has no launch token when it has none", async () => {
  refuseFromNowOn();

  const mounted = mount();

  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "catalogUnauthorized"));
  }, POLL);
  expect(onScreen(mounted)).not.toContain(t("en", "tokenRetired"));
});

/**
 * **It finds out without a click.** Nothing below touches the page after the server starts
 * refusing: the sentence arrives because the Workspace poll was refused and reported it, which
 * is the contract `changes.ts` changed for this ticket. Before it, the tab sat on the week it
 * had last read and looked healthy.
 */
it("finds out that its token was refused without anything being clicked", async () => {
  localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
  const mounted = mount();
  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "picksCountOne"));
  });
  const asksBefore = sent.length;

  refuseFromNowOn();

  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "tokenRetired"));
  }, POLL);
  // the page asked again of its own accord, which is the only way this sentence could appear
  expect(sent.length).toBeGreaterThan(asksBefore);
});

/**
 * **The week does not present "cannot read the Picks" as "no Picks".** The student's Picks are
 * safe on disk and the page simply cannot read them, so an affirmative "nothing picked yet"
 * would be a false statement about their own data — which is #111's lesson and #117's unread
 * tile state. Asserted here because #126 is one of the shapes of ignorance that reaches it.
 */
it("does not claim the student has no Picks when it cannot read them", async () => {
  localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
  const mounted = mount();
  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "picksCountOne"));
  });

  refuseFromNowOn();

  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "tokenRetired"));
  }, POLL);
  expect(onScreen(mounted)).not.toContain(t("en", "picksNone"));
  expect(onScreen(mounted)).not.toContain(t("en", "picksCountOne"));
});

/**
 * **A tab on the same port heals itself**, which is what ADR-0004 already promises and the app
 * did not show: the token rides from the origin's own store on every request, so opening the
 * fresh address in the same browser is enough. The store is written here directly, because that
 * is what `claimLaunchToken` does with the fragment the new address carries.
 *
 * Nothing is clicked here either. The poll reports the first answered ask after a refusal for
 * exactly this: without it the requests would work again and every pane would still be showing
 * the refusal until something else happened to re-render.
 */
it("heals itself when a fresh token reaches the same origin's store", async () => {
  localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
  const mounted = mount();
  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "picksCountOne"));
  });
  refuseFromNowOn();
  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "tokenRetired"));
  }, POLL);

  // the student opens the address the terminal printed, in this same browser
  localStorage.setItem(TOKEN_STORAGE_KEY, `${TOKEN}2`);
  refuseEverything = false;

  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "picksCountOne"));
  }, POLL);
  expect(onScreen(mounted)).not.toContain(t("en", "tokenRetired"));
});

/** Both sentences are in both languages, and they are two sentences rather than one. */
it("has a sentence for each of the two states, in both languages", () => {
  for (const language of ["en", "he"] as const) {
    expect(t(language, "tokenRetired")).not.toBe("");
    expect(t(language, "tokenRetired")).not.toBe(t(language, "catalogUnauthorized"));
  }
  expect(t("he", "tokenRetired")).not.toBe(t("en", "tokenRetired"));
});
