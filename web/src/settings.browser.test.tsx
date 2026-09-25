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
/** The Picks the fake's State File holds, so a click on a Group is a real write. */
let picks: unknown[];
/** Makes the next change refuse with this reason, the way a 409 arrives. */
let refuseChange: { reason?: string; status?: number } | undefined;
/** Makes every read refuse: the State File is there and this build cannot read it. */
let refuseRead: string | undefined;
/** Holds the settings GET open, so a test can look at the switch before an answer exists. */
let settingsHeld: Promise<void> | undefined;
/** The Workspace's change count, which moving is how the page hears the folder changed. */
let changeCount: number;
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
  picks = [];
  refuseChange = undefined;
  refuseRead = undefined;
  settingsHeld = undefined;
  changeCount = 0;
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
    if (pathname === "/api/workspace/changes") return json({ changeCount });
    if (pathname === "/api/history") return json({ canUndo: false, canRedo: false });
    if (pathname.startsWith("/api/timetable")) {
      // A Pick is a write like any other, so it moves the revision — which is the whole point of
      // the reverse-direction test below: the header's language switch is holding the old one.
      if (method === "POST") {
        const { basedOn, ...pick } = (body ?? {}) as Record<string, unknown>;
        if (basedOn !== `v${version}`) {
          return conflict({ reason: "state-file-changed", warnings: [] });
        }
        picks = [...picks, pick];
        version += 1;
      }
      return json({ variantName: "A", picks, clashes: [], version: `v${version}`, warnings: [] });
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

/**
 * Waits until the switch can be used, which is when the settings have been read. Not named
 * `readSettings` — that is the `app` use case, and a helper that waits is not one that reads.
 */
async function settingsReady(mounted: HTMLElement): Promise<void> {
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
  await settingsReady(first);
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
  await settingsReady(mounted);

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
  await settingsReady(mounted);
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
  await settingsReady(mounted);
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
  await settingsReady(mounted);
  expect(switchFor(mounted).disabled).toBe(false);
});

/** Both languages' strings come from the translation files, which is what the switch says. */
it.each(["en", "he"] as const)("says the other language's name in %s", async (from: Language) => {
  language = from;

  const mounted = mount();

  await settingsReady(mounted);
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
 * …and it stops saying so once a read succeeds, **in the same page**.
 *
 * This used to remount, which could not fail for the reason the title named: a fresh mount has said
 * nothing yet, so the assertion passed whether or not anything retired the sentence. The folder
 * coming back is the Workspace change count moving, which is the one pipe the page has for news
 * about the disk — so the wait is the real poll interval (`DEFAULT_EVERY_MS` in `./changes.ts`).
 */
it("stops saying the preferences are unread once a read succeeds, without a reload", async () => {
  refuseRead = "state-file-unreadable";
  const mounted = mount();
  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "settingsUnread"));
  });

  // the folder comes back — an unmounted drive, a file put back — and the watcher's count moves
  refuseRead = undefined;
  language = "he";
  changeCount = 1;

  await vi.waitFor(
    () => {
      expect([ROOT.lang, ROOT.dir]).toEqual(["he", "rtl"]);
      expect(said(mounted)).not.toContain(t("he", "settingsUnread"));
      expect(said(mounted)).not.toContain(t("en", "settingsUnread"));
    },
    { timeout: 8000, interval: 100 },
  );
});

/**
 * A read refused **after** a successful one says something different, and the difference matters: a
 * student reading Hebrew whose file was corrupted a moment ago is not looking at defaults, and
 * `settingsUnread` would tell them they are.
 */
it("says the last version was kept when a later read is refused, not that defaults are shown", async () => {
  language = "he";
  const mounted = mount();
  await settingsReady(mounted);
  await vi.waitFor(() => {
    expect([ROOT.lang, ROOT.dir]).toEqual(["he", "rtl"]);
  });

  // an editor corrupts the file under the page, and the count moves
  refuseRead = "state-file-unreadable";
  changeCount = 1;

  await vi.waitFor(
    () => {
      expect(said(mounted)).toContain(t("he", "settingsUnreread"));
    },
    { timeout: 8000, interval: 100 },
  );
  // and it does not claim defaults are on screen, because Hebrew still is
  expect(said(mounted)).not.toContain(t("he", "settingsUnread"));
  expect([ROOT.lang, ROOT.dir]).toEqual(["he", "rtl"]);
});

/**
 * A refusal the route named no reason for — a 400 on a body this client does not send. The floor:
 * nothing happened, and no cause is named, because naming one of the four would be wrong in the
 * other three (finding 7 of #160's review: this arm and its sentence were rendered by no test).
 */
it("says nothing changed for a refusal that names no reason", async () => {
  const mounted = mount();
  await settingsReady(mounted);
  refuseChange = {};

  switchFor(mounted).click();

  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "settingsNotDone"));
  });
  expect([ROOT.lang, ROOT.dir]).toEqual(["en", "ltr"]);
});

/**
 * **The switch is not offered again until the re-read has landed.** `settingsStale` tells the
 * student the page has re-read and to try again; until #160's review found it, `saving` was already
 * false when that sentence appeared, so following it before the re-read landed sent the same spent
 * revision and produced the same sentence.
 */
it("does not offer the switch again until the re-read a refusal asked for has landed", async () => {
  const mounted = mount();
  await settingsReady(mounted);
  // Held *before* the click, which is the whole point: the re-read the refusal asks for is the
  // thing the next press has to wait for, so a hold set afterwards would have let it land first.
  const [held, release] = hold();
  settingsHeld = held;
  refuseChange = { reason: "state-file-changed" };

  switchFor(mounted).click();

  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "settingsStale"));
  });
  // the sentence says the page has re-read and to try again; until it has, there is nothing to try
  expect(switchFor(mounted).disabled).toBe(true);

  settingsHeld = undefined;
  release();
  await settingsReady(mounted);
  expect(switchFor(mounted).disabled).toBe(false);
});

/**
 * **A preference change and a Pick are two writers on one page**, and each holds the revision it
 * read. Before #160's review the screen learned a settings write only from the 2-second poll, so a
 * language switch followed by a click on a Group was refused `state-file-changed` — and the student
 * read "your click was not saved" for a staleness their own switch had caused.
 *
 * Asserted as the revision the screen sends: after a change, the next Timetable read carries the
 * revision the change wrote, without the change count having moved.
 */
it("re-reads the week at once after a preference change, so the next click is not refused", async () => {
  const mounted = mount();
  await settingsReady(mounted);
  const readsBefore = sent.filter((r) => r.pathname.startsWith("/api/timetable")).length;

  switchFor(mounted).click();

  await vi.waitFor(() => {
    expect([ROOT.lang, ROOT.dir]).toEqual(["he", "rtl"]);
  });
  // the poll has not moved — `changeCount` is still 0 — so a re-read here is the page's own doing
  await vi.waitFor(() => {
    expect(
      sent.filter((r) => r.pathname.startsWith("/api/timetable")).length,
    ).toBeGreaterThan(readsBefore);
  });
  expect(changeCount).toBe(0);
});

/**
 * …and the same fix pointing the other way. **A Pick moves the revision the header is holding**, so
 * without `onEdited` a student who picked a Group and then used the language switch inside the poll
 * interval was refused `state-file-changed` — told their page was showing an older version because
 * of a click they had just made themselves.
 *
 * Driven through a real click on a real tile, because the claim is that the two writers on this page
 * stay in step and a spy on the callback would only say the wiring exists.
 */
it("re-reads the preferences at once after a Pick, so the next language switch is not refused", async () => {
  const mounted = mount();
  await settingsReady(mounted);

  // choose the fixture's Course, which puts its Group on the week
  const chooser = await vi.waitFor(() => {
    const found = [...mounted.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(OFFERING.courseNumber),
    );
    if (found === undefined) throw new Error("the Catalog served no Course to choose");
    return found;
  });
  chooser.click();
  const tile = await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLElement>(".day-column .tile");
    if (found === null) throw new Error("choosing the Course put no Meeting on the week");
    return found;
  });

  tile.click();

  // the Pick landed and moved the revision
  await vi.waitFor(() => {
    expect(picks).toHaveLength(1);
  });
  expect(version).toBe(2);

  // …and the switch still works, on the revision the Pick wrote, with the poll never having moved
  await settingsReady(mounted);
  switchFor(mounted).click();

  await vi.waitFor(() => {
    expect([ROOT.lang, ROOT.dir]).toEqual(["he", "rtl"]);
  });
  expect(changesSent()).toEqual([{ language: "he", basedOn: "v2" }]);
  expect(changeCount).toBe(0);
});
