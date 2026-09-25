/// <reference types="@vitest/browser-playwright" />
/**
 * The student's language as they meet it (#115): chosen once, kept in the State File, and there
 * again on the next reload — which is the bug this ticket is named for.
 *
 * A browser, and `<App />` rather than the screen, because every part of the claim is outside what
 * `renderToStaticMarkup` can answer: an effect asks the API, an effect puts `lang` and `dir` on
 * `<html>`, and a reload is a second mount against the same fake server. The whole point is the
 * document, and jsdom has no cascade and no real mount (issue #45).
 *
 * **The baseline is asserted before every flip.** A test of a language switch is exactly the kind
 * that passes because the document already said `lang="en"` — so each one below starts by putting
 * the root back to `en`/`ltr` and saying so, and only then looks for Hebrew.
 *
 * The API is stood in for by a fake `fetch` that **keeps the preference**: a PATCH changes what the
 * next GET answers and moves the revision, exactly as the real routes do over a file. A fake that
 * answered the change and forgot it could not say anything about a reload, which is the criterion.
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the name and the times are not,
 * and no crawled data is committed to this repo (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./index.css";
import { App } from "./App.tsx";
import { t, type Language } from "./i18n/strings.ts";
import type { Offering } from "./timetable/catalog.ts";

const ROOT = document.documentElement;

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

/** The fake server's State File: the two preferences, and the revision they are. */
let language: string;
let examSpacingDays: number;
let version: number;
/** Whether there is a State File at all; `undefined` is what a first save is based on. */
let hasFile: boolean;
/** Warnings the settings are read with, as `core` would raise them. */
let warnings: { kind: string; field?: string }[];
/** Makes the next change refuse with this reason, the way a 409 arrives. */
let refuseChange: { reason?: string; status?: number } | undefined;
/** Makes every read refuse: the State File is there and this build cannot read it. */
let refuseRead: string | undefined;
/** Holds the settings GET open, so a test can look at the switch before an answer exists. */
let settingsHeld: Promise<void> | undefined;
/** Every request the fake was sent. */
let sent: Array<{ method: string; pathname: string; body: unknown }>;

function hold(): [Promise<void>, () => void] {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = (): void => resolve();
  });
  return [promise, release];
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const conflict = (body: unknown, status = 409): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settings = () => ({
  language,
  examSpacingDays,
  version: hasFile ? `v${version}` : undefined,
  warnings,
});

/** A change, guarded on the revision as the real route is. */
function change(body: Record<string, unknown>): Response {
  if (refuseChange !== undefined) {
    const { reason, status } = refuseChange;
    refuseChange = undefined;
    if (reason === undefined) return conflict({ error: "not-settings" }, status ?? 400);
    return conflict({ reason, warnings: [] }, status ?? 409);
  }
  if (body.basedOn !== (hasFile ? `v${version}` : undefined)) {
    return conflict({ reason: "state-file-changed", warnings: [] });
  }

  if (typeof body.language === "string") language = body.language;
  if (typeof body.examSpacingDays === "number") examSpacingDays = body.examSpacingDays;
  hasFile = true;
  version += 1;
  return json(settings());
}

beforeEach(() => {
  language = "en";
  examSpacingDays = 3;
  version = 1;
  hasFile = true;
  warnings = [];
  refuseChange = undefined;
  refuseRead = undefined;
  settingsHeld = undefined;
  sent = [];
  // The baseline every assertion below is measured against. A student's browser may open on
  // anything, and a test that did not set this could pass with the flip never happening.
  ROOT.lang = "en";
  ROOT.dir = "ltr";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    sent.push({ method, pathname, body });

    if (pathname === "/api/settings") {
      if (method === "PATCH") return change((body ?? {}) as Record<string, unknown>);
      if (settingsHeld !== undefined) await settingsHeld;
      if (refuseRead !== undefined) return conflict({ reason: refuseRead, warnings: [] });
      return json(settings());
    }
    if (pathname === "/api/workspace/changes") return json({ changeCount: 0 });
    if (pathname === "/api/history") return json({ canUndo: false, canRedo: false });
    if (pathname.startsWith("/api/timetable")) {
      return json({ variantName: "A", picks: [], clashes: [], version: `v${version}`, warnings: [] });
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
  globalThis.fetch = realFetch;
});

/** Mounts the app, as a page load does. Called twice by the reload test. */
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

/** The language switch in the header, found by an attribute rather than by its wording. */
function switchFor(mounted: HTMLElement): HTMLButtonElement {
  const found = mounted.querySelector<HTMLButtonElement>("button[data-language]");
  if (found === null) throw new Error("the header has no language switch");
  return found;
}

/** Everything the live region is saying, which is where every account of a change appears. */
const said = (mounted: HTMLElement): string =>
  [...mounted.querySelectorAll("[role=status]")].map((node) => node.textContent ?? "").join(" ");

/** Waits until the settings have been read, which is when the switch can be used. */
async function readSettings(mounted: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    if (switchFor(mounted).disabled) throw new Error("the settings have not been read yet");
  });
}

const settingsAsked = (): number =>
  sent.filter((request) => request.pathname === "/api/settings" && request.method === "GET").length;

const changesSent = (): unknown[] =>
  sent
    .filter((request) => request.pathname === "/api/settings" && request.method === "PATCH")
    .map((request) => request.body);

/**
 * The first half of the ticket: the language in the file is the language on screen, and the whole
 * document follows it. A student's saved Hebrew has to survive a page that starts in English.
 */
it("opens in the language the State File holds, flipping a document that was English", async () => {
  language = "he";
  // the baseline, said out loud: without this the assertion below could pass unflipped
  expect([ROOT.lang, ROOT.dir]).toEqual(["en", "ltr"]);

  const mounted = mount();

  await vi.waitFor(() => {
    expect([ROOT.lang, ROOT.dir]).toEqual(["he", "rtl"]);
  });
  // and the strings followed, not only the attributes
  expect(mounted.textContent).toContain(t("he", "timetable"));
  expect(mounted.textContent).not.toContain(t("en", "timetable"));
});

/**
 * **The criterion this ticket is named for.** Choose Hebrew, then load the page again: the same
 * fake server, a second mount, and no click. Before #115 this was the failure — the language was a
 * `useState` in `App`, so the reload was English again.
 */
it("keeps a language across a reload, which is the whole of what #115 is about", async () => {
  const first = mount();
  await readSettings(first);
  expect([ROOT.lang, ROOT.dir]).toEqual(["en", "ltr"]);

  switchFor(first).click();

  await vi.waitFor(() => {
    expect([ROOT.lang, ROOT.dir]).toEqual(["he", "rtl"]);
  });

  // a reload: the page is thrown away and built again, and nothing of its memory survives
  root?.unmount();
  root = undefined;
  ROOT.lang = "en";
  ROOT.dir = "ltr";
  const second = mount();

  await vi.waitFor(() => {
    expect([ROOT.lang, ROOT.dir]).toEqual(["he", "rtl"]);
  });
  expect(second.textContent).toContain(t("he", "timetable"));
  // and the second page sent no change of its own: it read one
  expect(changesSent()).toHaveLength(1);
});

/**
 * A change to a preference is a change to the State File, so it carries the revision the page was
 * showing (`docs/design.md`, "External edits") and names only the preference it changes — a body
 * carrying both would reset the Exam spacing every time a student switched language.
 */
it("sends the change on the revision it read, naming only the language", async () => {
  const mounted = mount();
  await readSettings(mounted);

  switchFor(mounted).click();

  await vi.waitFor(() => {
    expect(changesSent()).toEqual([{ language: "he", basedOn: "v1" }]);
  });
});

/**
 * **A preference change can fail**, and this is the screen's answer for it.
 *
 * The sentence is asserted to be `settingsStale` and asserted **not** to be `picksStale`. That is
 * not belt and braces: `picksStale` is an account of a click on a Group, #111 is the ticket about
 * showing a claim the page cannot make, and reusing that wording here is the specific mistake this
 * ticket says not to repeat.
 */
it("says something true when the change is refused, and not the Pick's sentence", async () => {
  const mounted = mount();
  await readSettings(mounted);
  refuseChange = { reason: "state-file-changed" };

  switchFor(mounted).click();

  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "settingsStale"));
  });
  expect(said(mounted)).not.toContain(t("en", "picksStale"));
  // and the language did not change, because the change did not happen
  expect([ROOT.lang, ROOT.dir]).toEqual(["en", "ltr"]);
  expect(switchFor(mounted).textContent).toBe(t("en", "otherLanguage"));
});

/**
 * A refusal whose remedy is a fresher revision makes the page read again, so the next press is not
 * sent on a revision the file has already moved past.
 */
it("reads the settings again after a refusal about the file having changed", async () => {
  const mounted = mount();
  await readSettings(mounted);
  const before = settingsAsked();
  refuseChange = { reason: "state-file-changed" };

  switchFor(mounted).click();

  await vi.waitFor(() => {
    expect(settingsAsked()).toBeGreaterThan(before);
  });
});

/**
 * The Warning `core` has raised since the schema was written, reaching a student at last. Naming
 * the field, because "one of your preferences" leaves them nothing to go and look at.
 */
it("says which preference could not be read", async () => {
  warnings = [{ kind: "settings-unreadable", field: "examSpacingDays" }];

  const mounted = mount();

  await vi.waitFor(() => {
    expect(said(mounted)).toContain(
      t("en", "settingsUnreadableNamed", { setting: t("en", "settingExamSpacing") }),
    );
  });
});

/** A field this build has no word for falls back to the sentence that names none. */
it("says a preference could not be read without naming a field it has no word for", async () => {
  warnings = [{ kind: "settings-unreadable", field: "somethingNewer" }];

  const mounted = mount();

  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "settingsUnreadable"));
  });
  expect(said(mounted)).not.toContain("somethingNewer");
});

/**
 * No press before the settings have been read.
 *
 * Structural rather than careful: a change carries the revision it was based on, and `undefined`
 * there is the claim that there is no State File — so a page that had not read one would send a
 * change that fails closed and then tell the student their page was stale about something they had
 * no part in. That is #111, from the other side.
 */
it("offers no switch until the settings have been read", async () => {
  const [held, release] = hold();
  settingsHeld = held;

  const mounted = mount();

  await vi.waitFor(() => {
    expect(switchFor(mounted).disabled).toBe(true);
  });
  // and nothing was sent by the disabled control
  switchFor(mounted).click();
  expect(changesSent()).toEqual([]);

  release();
  await readSettings(mounted);
  expect(switchFor(mounted).disabled).toBe(false);
});

/** Both languages' strings come from the translation files, which is what the switch says. */
it.each(["en", "he"] as const)("says the other language's name in %s", async (from: Language) => {
  language = from;

  const mounted = mount();

  await readSettings(mounted);
  expect(switchFor(mounted).textContent).toBe(t(from, "otherLanguage"));
});

/**
 * A page that never had the student's preferences at all, which is the other way a preference can
 * fail to reach them. The switch is disabled — there is no revision to change anything on — and
 * without a sentence the app would simply be in English, for a Hebrew student, saying nothing about
 * either. A control that cannot be used and explains nothing is #111's failure in a new place.
 */
it("says the preferences could not be read, rather than showing defaults in silence", async () => {
  refuseRead = "state-file-unreadable";

  const mounted = mount();

  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "settingsUnread"));
  });
  expect(switchFor(mounted).disabled).toBe(true);
  expect([ROOT.lang, ROOT.dir]).toEqual(["en", "ltr"]);
});

/**
 * …and it stops saying so once a read succeeds. A sentence about a file that could not be read,
 * left on screen over a page that has since read it, is a claim the page no longer has.
 */
it("stops saying the preferences are unread once a read succeeds", async () => {
  refuseRead = "state-file-unreadable";
  const mounted = mount();
  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "settingsUnread"));
  });

  // the folder comes back — an unmounted drive, a file put back — and the page asks again
  refuseRead = undefined;
  language = "he";
  root?.unmount();
  root = undefined;
  mount();

  await vi.waitFor(() => {
    expect([ROOT.lang, ROOT.dir]).toEqual(["he", "rtl"]);
  });
  expect(said(host!)).not.toContain(t("en", "settingsUnread"));
  expect(said(host!)).not.toContain(t("he", "settingsUnread"));
});
