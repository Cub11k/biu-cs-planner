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
/**
 * Whether only the Timetable route is refused. Not a shape a retired token produces — the guard
 * is in front of every route — but it is how the week's own behaviour under an unreadable set of
 * Picks can be looked at without an empty Catalog in front of it.
 */
let refuseTimetable: boolean;
/** The Picks the fake's State File holds, so the week has something to lose. */
let picks: unknown[];
let changeCount: number;
let sent: string[];

/** Exactly what `server/src/guard.ts` answers, which is the same for every way a token fails. */
const unauthorized = (): Response =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

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
  refuseTimetable = false;
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
    if (refuseEverything) return unauthorized();

    if (pathname === "/api/settings") {
      return json({ language: "en", examSpacingDays: 3, version: "v1", warnings: [] });
    }
    if (pathname === "/api/workspace/changes") return json({ changeCount });
    if (pathname === "/api/history") return json({ canUndo: false, canRedo: false });
    if (pathname.startsWith("/api/timetable")) {
      if (refuseTimetable) return unauthorized();
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

/**
 * Chooses the fixture's Course, which puts its Groups on the week. Needed for the tile assertion
 * below: the week draws a Pick only through the Course it belongs to or through the Picks it was
 * served, so with neither in hand it draws nothing at all.
 */
async function chooseCourse(mounted: HTMLElement): Promise<void> {
  const chooser = await vi.waitFor(() => {
    const found = [...mounted.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(OFFERING.courseNumber),
    );
    if (found === undefined) throw new Error("the Catalog served no Course to choose");
    return found;
  });
  chooser.click();
}

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
  expect(onScreen(mounted)).not.toContain(t("en", "tokenMissing"));
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
    expect(onScreen(mounted)).toContain(t("en", "tokenMissing"));
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

  refuseFromNowOn();
  // Every ask from here on, so the mechanism can be read off it rather than inferred. Counting
  // asks would not do: the poll moves that number every two seconds whether or not a refusal is
  // ever reported, so a count would pass with `changes.ts` reverted.
  sent.length = 0;

  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "tokenRetired"));
  }, POLL);

  // The poll was refused — and the page then **re-read the week**, which is the whole of how it
  // finds out. A refused poll that reported nothing would leave only the poll's own asks here,
  // because `useReloading` asks again on the change count and nothing else moved it.
  expect(sent).toContain("/api/workspace/changes");
  expect(sent.some((path) => path.startsWith("/api/timetable"))).toBe(true);
});

/**
 * **The week does not present "cannot read the Picks" as "no Picks".** The student's Picks are
 * safe on disk and the page simply cannot read them, so an affirmative "nothing picked yet"
 * would be a false statement about their own data — which is #111's lesson and #117's unread
 * tile state. Asserted here because #126 is one of the shapes of ignorance that reaches it.
 */
it("leaves the week empty under a 401, and never says the student has no Picks", async () => {
  localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
  const mounted = mount();
  await chooseCourse(mounted);
  await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLElement>(".day-column .tile");
    if (found === null) throw new Error("the served Pick put no tile on the week");
    expect(found.getAttribute("aria-pressed")).toBe("true");
  });

  refuseFromNowOn();

  // **A retired token refuses the Catalog as well**, so there is no Offering left to draw and no
  // tile of any kind — not a pencil option, which would be the week claiming the Group is not
  // picked. The sentence beside the week is the whole account of what is missing, which is
  // honest and is not the same as the week saying so itself; redrawing the Picks a page read a
  // moment ago, as something it can no longer confirm, is the unread-screen question (#119,
  // #120, #172) and is not decided here.
  await vi.waitFor(() => {
    expect(onScreen(mounted)).toContain(t("en", "tokenRetired"));
    expect(mounted.querySelector(".day-column .tile")).toBeNull();
  }, POLL);
  expect(onScreen(mounted)).not.toContain(t("en", "picksNone"));
  expect(onScreen(mounted)).not.toContain(t("en", "picksCountOne"));
});

/**
 * **The criterion itself, isolated: "cannot read the Picks" is not "no Picks".**
 *
 * Only the Timetable route is refused here, and the Catalog still serves. A retired token refuses
 * both, so this is not the rotation reproduced — it is the week's own behaviour under the
 * ignorance a 401 produces, which is the part of #126 the screen has to get right and the part a
 * full refusal hides behind an empty Catalog. `aria-pressed="mixed"` with `aria-busy` is #117's
 * unread state; `aria-pressed="false"` — a pencil option, "this Group is not picked" — is the
 * false claim the `[]` fallback made, and is what this holds the screen to.
 *
 * The sentences would not catch it: `picksNone` and `picksCountOne` come from `picksSaid`, which
 * `picksNotice` reaches only on a served answer, so neither can appear on this path however the
 * Picks were defaulted.
 */
it("draws a Group whose Picks it cannot read as unread, not as unpicked", async () => {
  localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
  const mounted = mount();
  await chooseCourse(mounted);
  await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLElement>(".day-column .tile");
    if (found === null) throw new Error("the served Pick put no tile on the week");
    expect(found.getAttribute("aria-pressed")).toBe("true");
  });

  refuseTimetable = true;
  // and the folder changes, which is what makes the page re-read: the Workspace poll is still
  // answered here, so nothing else would send it back to a route that has started refusing
  changeCount = 1;

  await vi.waitFor(() => {
    const tile = mounted.querySelector<HTMLElement>(".day-column .tile");
    if (tile === null) throw new Error("the Catalog is still served, so the Group must be drawn");
    expect(tile.getAttribute("aria-pressed")).toBe("mixed");
    expect(tile.getAttribute("aria-busy")).toBe("true");
    expect(tile.className).toContain("is-unread");
  }, POLL);
  expect(onScreen(mounted)).not.toContain(t("en", "picksNone"));
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
    expect(t(language, "tokenRetired")).not.toBe(t(language, "tokenMissing"));
  }
  expect(t("he", "tokenRetired")).not.toBe(t("en", "tokenRetired"));
});
