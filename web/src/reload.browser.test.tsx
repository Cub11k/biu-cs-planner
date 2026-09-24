/// <reference types="@vitest/browser-playwright" />
/**
 * The UI reloading on an external change (docs/design.md, "Storage").
 *
 * A browser, because the thing under test is a React effect: `renderToStaticMarkup` never
 * runs one, so `timetable/render.test.ts` cannot tell a screen that re-reads the Catalog
 * from one that ignores the news entirely. Here the screen is mounted, the Catalog on the
 * far side of `fetch` is replaced the way a hand-dropped file replaces one on disk, and the
 * question is whether what the student is looking at follows.
 *
 * The last test is the whole path at once: `App` asking the API for the change counter on
 * its own timer, noticing that it moved, and the screen reading the Catalog again. Nothing
 * below that level can say whether the pieces are actually joined up.
 *
 * Fixture data is invented: 89-110 and 89-210 are real BIU course numbers, the names and
 * the times are not, and no crawled data is committed to this repo.
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./index.css";
import { App } from "./App.tsx";
import type { Offering } from "./timetable/catalog.ts";
import { TimetableScreen } from "./timetable/TimetableScreen.tsx";

/** October 2026: the Fall Semester of Academic Year 2027, which is what the fixture is. */
const TODAY = new Date(2026, 9, 15);

const offering = (courseNumber: string, nameEnglish: string): Offering => ({
  courseNumber,
  nameHebrew: "קורס",
  nameEnglish,
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
});

const BEFORE = offering("89-110", "Introduction to Computer Science");
/** The Catalog after a second one was dropped into `catalogs/` by hand. */
const AFTER = offering("89-210", "Data Structures");

let host: HTMLElement | undefined;
let root: Root | undefined;
const realFetch = globalThis.fetch;
let served: Offering[] = [BEFORE];
/** The count the server would serve; moving it is a file having changed on disk. */
let changeCount = 0;
let polls = 0;
let asks = 0;
/** Holds the Catalog answer open, so a test can look at the screen mid-re-read. */
let held: Promise<void> | undefined;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  served = [BEFORE];
  changeCount = 0;
  polls = 0;
  asks = 0;
  held = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);

    if (pathname === "/api/workspace/changes") {
      polls += 1;
      return json({ changeCount });
    }
    if (pathname.startsWith("/api/timetable")) {
      // nothing is picked in this fixture: what is under test here is the Catalog
      return json({ variantName: "A", picks: [], clashes: [], warnings: [] });
    }
    asks += 1;
    if (held !== undefined) await held;
    return json({ offerings: served });
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  globalThis.fetch = realFetch;
});

/** Mounts the screen with a given change count and waits for the Catalog it draws. */
async function show(workspaceChanges: number): Promise<HTMLElement> {
  if (host === undefined) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  root!.render(
    <TimetableScreen
      language="en"
      onLanguage={() => {}}
      today={TODAY}
      workspaceChanges={workspaceChanges}
    />,
  );
  const mounted = host;
  // a Course, not any button: the header's language switch is there before the Catalog is,
  // so waiting for `button` would be waiting for nothing at all
  await vi.waitFor(() => {
    if (courseNumbers(mounted).length === 0) {
      throw new Error("the Catalog served no Course to choose");
    }
  });
  return mounted;
}

/** The Courses the picker is actually offering, named exactly and in the order shown. */
const courseNumbers = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll("button")].flatMap((button) => {
    const text = button.textContent ?? "";
    return [BEFORE.courseNumber, AFTER.courseNumber].filter((number) => text.includes(number));
  });

it("reads the Catalog again when the Workspace changed, and shows what it found", async () => {
  const mounted = await show(0);
  expect(courseNumbers(mounted)).toEqual([BEFORE.courseNumber]);
  const askedOnce = asks;

  // the file on disk is now a different Catalog, and the server's counter has moved
  served = [AFTER];
  await show(1);

  await vi.waitFor(() => {
    expect(courseNumbers(mounted)).toEqual([AFTER.courseNumber]);
  });
  expect(asks).toBeGreaterThan(askedOnce);
});

/**
 * And not on every render. A screen that re-read the Catalog whenever React felt like
 * rendering it would poll the API through a side door, which is the opposite of one
 * notification per burst.
 */
it("leaves the Catalog alone when nothing in the Workspace changed", async () => {
  const mounted = await show(0);
  const askedOnce = asks;

  served = [AFTER];
  await show(0);
  await show(0);

  expect(asks).toBe(askedOnce);
  expect(courseNumbers(mounted)).toEqual([BEFORE.courseNumber]);
});

/**
 * The whole path, with nothing standing in for the joins: `App` asks the API for the change
 * counter on its own timer, the counter moves because a file changed on disk, and the screen
 * reads the Catalog again. `web` learns about it through the HTTP API and through nothing
 * else — there is no second pipe here to learn it from.
 *
 * Slower than the tests above by design: the wait is the real poll interval
 * (`DEFAULT_EVERY_MS` in ./changes.ts), because a page that only reloads when a test hands it
 * a number is not the claim the design makes.
 */
it("reloads the whole app when the server's change count moves", async () => {
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(<App />);

  await vi.waitFor(() => {
    if (courseNumbers(mounted).length === 0) throw new Error("the Catalog served no Course");
    // and the count has been read once, which is the baseline every later answer is
    // compared against: a change made before the page ever asked is not one it can see
    if (polls === 0) throw new Error("the page has not asked for the change count yet");
  });
  expect(courseNumbers(mounted)).toEqual([BEFORE.courseNumber]);

  // a Catalog is dropped into `catalogs/` by hand: the file changes, the server's watcher
  // settles the burst, and its count moves. Nothing tells the page directly.
  served = [AFTER];
  changeCount = 1;

  await vi.waitFor(
    () => {
      expect(courseNumbers(mounted)).toEqual([AFTER.courseNumber]);
    },
    { timeout: 8000, interval: 100 },
  );
});

/**
 * And it re-reads **without blanking what is on screen**.
 *
 * From the moment a Pick can be saved, every save moves the change count — the watcher
 * watches the Workspace root and filters no filenames — so this re-read happens per Pick
 * and not only when someone drops a file in by hand. #88 ruled the reload idempotent
 * rather than suppressed, and a screen that flashed "Loading the catalog…" on every Pick
 * would be the suppression argument all over again.
 *
 * The Catalog answer is held open here so the screen can be looked at mid-re-read, which is
 * the only moment the difference exists.
 */
it("keeps the Catalog on screen while it re-reads after a change", async () => {
  const mounted = await show(0);
  expect(courseNumbers(mounted)).toEqual([BEFORE.courseNumber]);

  let release = (): void => {};
  held = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  served = [AFTER];
  await show(1);

  // the request is in flight and the old Catalog is still there to work with
  await vi.waitFor(() => {
    if (asks < 2) throw new Error("the screen has not asked for the Catalog again");
  });
  expect(courseNumbers(mounted)).toEqual([BEFORE.courseNumber]);
  expect(mounted.textContent).not.toContain("Loading the catalog");

  release();
  await vi.waitFor(() => {
    expect(courseNumbers(mounted)).toEqual([AFTER.courseNumber]);
  });
});

/** A first load has genuinely nothing to show, so it still says so. */
it("says it is loading on the first read, when there is nothing to keep", async () => {
  let release = (): void => {};
  held = new Promise<void>((resolve) => {
    release = () => resolve();
  });

  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(<TimetableScreen language="en" onLanguage={() => {}} today={TODAY} />);

  await vi.waitFor(() => {
    if (!(mounted.textContent ?? "").includes("Loading the catalog")) {
      throw new Error("the first load said nothing about loading");
    }
  });

  release();
  await vi.waitFor(() => {
    expect(courseNumbers(mounted)).toEqual([BEFORE.courseNumber]);
  });
});
