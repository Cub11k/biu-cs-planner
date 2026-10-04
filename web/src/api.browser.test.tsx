/// <reference types="@vitest/browser-playwright" />
/**
 * An answer the page cannot read, as a student meets it (#171).
 *
 * The defect was that `web` read a failed answer's body **outside** the `catch` meant to cover
 * it, so a response that is not JSON rejected the promise instead of producing a message —
 * and `TimetableScreen` has no `.catch` on these paths, so the student was told nothing at
 * all: the click appeared to do nothing. Reachable in ordinary development rather than
 * exotic: Vite's `/api` proxy answers an **HTML 500** when the server behind it is not
 * running, and hono answers a plain-text 404 for a path only a newer bundle asks for.
 *
 * A browser and `<App />` rather than the module, because the claim is about what is **on
 * screen**: `picks.test.ts` and `offerings.test.ts` assert the answer, and this asserts the
 * sentence. The module tests would pass with every branch of the screen unwritten.
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the name and the times are
 * not, and no crawled data is committed to this repo (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./index.css";
import { App } from "./App.tsx";
import { t } from "./i18n/strings.ts";
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

/** What the dev proxy answers when the server behind it is not running. */
const htmlFiveHundred = (): Response =>
  new Response(
    "<!doctype html><html><head><title>Error</title></head>" +
      "<body><h1>500 Internal Server Error</h1></body></html>",
    { status: 500, headers: { "content-type": "text/html" } },
  );

/** What hono answers for an `/api/...` path it has no route for (`server/src/ui.ts`). */
const plainTextNotFound = (): Response => new Response("404 Not Found", { status: 404 });

/** Which paths answer with a body the page cannot read, and with which of the two shapes. */
let unreadable: { offerings?: boolean; timetablePost?: boolean; timetableGet?: boolean };
/** The Picks the fake's State File holds, so a click on a Group is a real write. */
let picks: unknown[];
let version: number;
let changeCount: number;
let sent: Array<{ method: string; pathname: string }>;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  unreadable = {};
  picks = [];
  version = 1;
  changeCount = 0;
  sent = [];
  ROOT.lang = "en";
  ROOT.dir = "ltr";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? "GET";
    sent.push({ method, pathname });

    if (pathname === "/api/settings") {
      return json({ language: "en", examSpacingDays: 3, version: `v${version}`, warnings: [] });
    }
    if (pathname === "/api/workspace/changes") return json({ changeCount });
    if (pathname === "/api/history") return json({ canUndo: false, canRedo: false });
    if (pathname.startsWith("/api/timetable")) {
      if (method === "POST" || method === "DELETE") {
        if (unreadable.timetablePost === true) return htmlFiveHundred();
        picks = [...picks, {}];
        version += 1;
      } else if (unreadable.timetableGet === true) {
        return plainTextNotFound();
      }
      return json({ variantName: "A", picks, clashes: [], version: `v${version}`, warnings: [] });
    }
    if (unreadable.offerings === true) return htmlFiveHundred();
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

/** Everything the live region is saying, which is where every account of a click appears. */
const said = (mounted: HTMLElement): string =>
  [...mounted.querySelectorAll("[role=status]")].map((node) => node.textContent ?? "").join(" ");

/** Chooses the fixture's Course, which puts its Group on the week as an option. */
async function chooseCourse(mounted: HTMLElement): Promise<HTMLElement> {
  const chooser = await vi.waitFor(() => {
    const found = [...mounted.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(OFFERING.courseNumber),
    );
    if (found === undefined) throw new Error("the Catalog served no Course to choose");
    return found;
  });
  chooser.click();
  return await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLElement>(".day-column .tile");
    if (found === null) throw new Error("choosing the Course put no Meeting on the week");
    return found;
  });
}

/**
 * **The criterion the ticket names: a click.** #111's whole lesson was that a student who acts
 * must be told what happened, and before this a Pick whose answer was an HTML 500 rejected
 * inside `recordPick` with nothing on screen to show for it.
 */
it("says something when a click's answer is a body it cannot read", async () => {
  const mounted = mount();
  const tile = await chooseCourse(mounted);
  // the first week read succeeded, so there is a revision to click on; the save is what fails
  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "picksNone"));
  });
  unreadable.timetablePost = true;

  tile.click();

  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "picksAnswerUnreadable"));
  });
  // and nothing was written, which is what the sentence claims
  expect(picks).toEqual([]);
});

/**
 * …and it claims nothing it does not know. `picksUnreadable` says the saved Picks could not be
 * read and `picksStale` says the file changed since this page read it; an unparseable body says
 * neither, and sending the student to look at their State File is the wrong remedy.
 */
it("names no cause an unreadable answer does not carry", async () => {
  const mounted = mount();
  const tile = await chooseCourse(mounted);
  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "picksNone"));
  });
  unreadable.timetablePost = true;

  tile.click();

  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "picksAnswerUnreadable"));
  });
  expect(said(mounted)).not.toContain(t("en", "picksUnreadable"));
  expect(said(mounted)).not.toContain(t("en", "picksStale"));
  expect(said(mounted)).not.toContain(t("en", "apiUnreachable"));
  expect(said(mounted)).not.toContain(t("en", "picksNotSaved"));
});

/** The read path too: the week is not left on "loading" with nothing said. */
it("says something when the week's own answer is a body it cannot read", async () => {
  unreadable.timetableGet = true;

  const mounted = mount();

  await vi.waitFor(() => {
    expect(said(mounted)).toContain(t("en", "picksAnswerUnreadable"));
  });
  // and it does not claim the student has nothing picked, which it cannot know
  expect(said(mounted)).not.toContain(t("en", "picksNone"));
});

/**
 * The Catalog's half. The sidebar's fall-through is the course list over an empty Catalog, so a
 * branch missing here is a sidebar that silently shows no Course — and `refused` with no
 * Warnings would have been worse still: `isAbsence` reads that as "no catalog for this year
 * yet, import a crawl of Shoham", a claim about the student's folder that nothing knows.
 */
it("says something when the Catalog's answer is a body it cannot read", async () => {
  unreadable.offerings = true;

  const mounted = mount();

  await vi.waitFor(() => {
    expect(mounted.textContent).toContain(t("en", "catalogAnswerUnreadable"));
  });
  // The sidebar says that and only that. Asserted as the whole of it rather than as a list of
  // sentences it must not contain: a negative assertion about a string built from a template
  // passes just as happily when the template was filled differently from the test's guess.
  const aside = mounted.querySelector("aside");
  expect(aside?.textContent).toBe(t("en", "catalogAnswerUnreadable"));
});

/** Both sentences are in the translation files, in both languages, and are not each other. */
it("has a sentence for each pane, in both languages", () => {
  for (const language of ["en", "he"] as const) {
    expect(t(language, "catalogAnswerUnreadable")).not.toBe("");
    expect(t(language, "picksAnswerUnreadable")).not.toBe("");
    expect(t(language, "catalogAnswerUnreadable")).not.toBe(t(language, "picksAnswerUnreadable"));
  }
  expect(t("he", "picksAnswerUnreadable")).not.toBe(t("en", "picksAnswerUnreadable"));
});
