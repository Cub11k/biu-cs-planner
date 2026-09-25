/// <reference types="@vitest/browser-playwright" />
/**
 * The Timetable as a browser lays it out.
 *
 * `render.test.ts` beside this file asserts against a string, and a string cannot say
 * which side of the week the hour gutter landed on, whether `15:00–18:00` survived a
 * Hebrew line, or whether the dark tokens resolved. Those need an engine: a layout pass,
 * the Tailwind cascade, and the Unicode bidirectional algorithm (issue #45).
 *
 * Every assertion here states what should be true of the design rather than what the page
 * currently does. Nobody has opened this screen yet and the dark Lesson Type hues are
 * known to read as too neon, so a test that recorded today's output would enshrine that
 * instead of catching it. These go red when the layout is wrong, which is the point.
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the name and the times
 * are not, and no crawled data is committed to this repo.
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import "../index.css";
import { LANGUAGES, t, type Language } from "../i18n/strings.ts";
import type { Group, Offering } from "./catalog.ts";
import { TimetableScreen } from "./TimetableScreen.tsx";

/** October 2026: the Fall Semester of Academic Year 2027, which is what the fixture is. */
const TODAY = new Date(2026, 9, 15);

const group = (
  number: string,
  lessonType: string,
  meetings: ReadonlyArray<[Group["meetings"][number]["day"], string, string]>,
): Group => ({
  number,
  lessonType,
  lecturers: [],
  meetings: meetings.map(([day, start, end]) => ({ semester: "fall", day, start, end })),
});

/**
 * One Course, laid out to put a tile against each edge the assertions care about: the
 * earliest Meeting opens the hour range and the latest one closes it, so "a tile stays
 * inside its column" is asked at the top and the bottom of the grid and not only in the
 * middle of it. Nothing meets on Friday, so the week is the five columns of `WEEK_DAYS`.
 */
const OFFERING: Offering = {
  courseNumber: "89-110",
  nameHebrew: "מבוא למדעי המחשב",
  nameEnglish: "Introduction to Computer Science",
  credits: { known: true, total: 5 },
  semesters: ["fall"],
  groups: [
    group("01", "הרצאה", [
      ["sunday", "08:00", "10:00"],
      ["tuesday", "15:00", "18:00"],
    ]),
    group("02", "תרגיל", [["thursday", "18:00", "20:00"]]),
  ],
  exams: { known: false, sittings: [] },
};

/** The one time range the times assertion reads, spelled as `tileText` spells it. */
const TIME_RANGE = { start: "15:00", end: "18:00" } as const;

let host: HTMLElement | undefined;
let root: Root | undefined;
const realFetch = globalThis.fetch;

/**
 * The Catalog the screen asks for, served without a server.
 *
 * `web` reaches the domain only through the typed client, and the client sends a real
 * request through `fetch` — so the seam a test can stand in is `fetch` itself. Anything
 * that is not the API is handed to the real one, because Vite is serving this page.
 */
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!new URL(url, location.href).pathname.startsWith("/api/")) {
      return realFetch(input as RequestInfo, init);
    }

    // the screen asks two routes as it opens: the Catalog, and the Picks it has to draw.
    // This fixture picks nothing, so the week here is pencil throughout.
    const { pathname } = new URL(url, location.href);
    const body =
      pathname === "/api/history"
        ? // the header's two buttons ask this; nothing here is about them
          { canUndo: false, canRedo: false }
        : pathname.startsWith("/api/timetable")
          ? { variantName: "A", picks: [], clashes: [], warnings: [] }
          : { offerings: [OFFERING] };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  globalThis.fetch = realFetch;
  await colorScheme("light");
});

/**
 * The whole screen, with the Course chosen, mounted into the page.
 *
 * The screen and not the grid alone: `dir` is set on a div inside `TimetableScreen`
 * rather than on `<html>`, so mounting `WeekGrid` by itself would test a week that had
 * never been told which way it reads.
 */
async function openWeek(language: Language): Promise<HTMLElement> {
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(<TimetableScreen language={language} onLanguage={() => {}} today={TODAY} />);

  // The screen asks the API as it mounts and draws the week when the answer arrives, so
  // waiting for the Course to appear is waiting for the render that has the Catalog in it.
  const chooser = await vi.waitFor(() => {
    const found = [...mounted.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(OFFERING.courseNumber),
    );
    if (found === undefined) throw new Error("the Catalog served no Course to choose");
    return found;
  });

  chooser.click();
  await vi.waitFor(() => {
    if (mounted.querySelector(".day-column .tile") === null) {
      throw new Error("choosing the Course put no Meeting on the week");
    }
  });

  return mounted;
}

/**
 * Emulates the media feature the dark scheme keys off. Nothing here stamps a
 * `data-theme`, so these assertions are about the operating system's half of the
 * scheme; an explicit choice overriding it is `../scheme.browser.test.tsx` (#114).
 */
async function colorScheme(scheme: "light" | "dark"): Promise<void> {
  const session = await cdp();
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
}

const one = (within: HTMLElement, selector: string): HTMLElement => {
  const found = within.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing on the screen matched ${selector}`);
  return found;
};

const all = (within: HTMLElement, selector: string): HTMLElement[] => [
  ...within.querySelectorAll<HTMLElement>(selector),
];

/** A sub-pixel: layout is fractional, and "touching" must not read as "overlapping". */
const HAIR = 0.5;

/**
 * The one text node that holds this string, found without naming an element.
 *
 * Deliberately not `.tile bdi`: the claim being made is about where the characters end
 * up, and a selector naming the isolate would turn "the times render in order" into
 * "there is a `<bdi>`" — which is the assertion `render.test.ts` already makes on a string.
 */
function findText(within: HTMLElement, exact: string): Text {
  const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeValue === exact) return node as Text;
  }

  throw new Error(`nothing on the screen rendered the text ${exact}`);
}

/**
 * Where a run of characters inside a text node actually ended up. Reading the element's
 * rect would only say where the whole string is; the question here is the order of two
 * runs within it, which is what the bidirectional algorithm decides.
 */
function runRect(text: Text, from: number, to: number): DOMRect {
  const range = document.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  return range.getBoundingClientRect();
}

/** sRGB relative luminance, 0 (black) to 1 (white), from a computed `rgb(...)` colour. */
function luminance(computed: string): number {
  const channels = [...computed.matchAll(/[\d.]+/g)].slice(0, 3).map((match) => Number(match[0]));
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const part = channel / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

describe.each(LANGUAGES)("the week in %s", (language) => {
  const rightToLeft = language === "he";

  it("puts the hour gutter on the reading side and runs the days away from it", async () => {
    const screen = await openWeek(language);
    const gutter = one(screen, ".hour-gutter").getBoundingClientRect();
    const [sunday, monday] = all(screen, ".day-column").map((column) =>
      column.getBoundingClientRect(),
    );
    if (sunday === undefined || monday === undefined) throw new Error("the week has no days");

    if (rightToLeft) {
      // the gutter is first in DOM order, so in Hebrew it is the rightmost thing there is
      expect(gutter.left).toBeGreaterThanOrEqual(sunday.right - HAIR);
      expect(monday.right).toBeLessThanOrEqual(sunday.left + HAIR);
    } else {
      expect(gutter.right).toBeLessThanOrEqual(sunday.left + HAIR);
      expect(monday.left).toBeGreaterThanOrEqual(sunday.right - HAIR);
    }
  });

  it("reads a Meeting's time range left to right, whichever way the line runs", async () => {
    const screen = await openWeek(language);
    const text = findText(screen, `${TIME_RANGE.start}\u2013${TIME_RANGE.end}`);
    const start = runRect(text, 0, TIME_RANGE.start.length);
    const end = runRect(text, TIME_RANGE.start.length + 1, text.length);

    // A range broken across two lines would put one end under the other and "which is
    // further left" would stop meaning anything, so that is ruled out before it is asked --
    // and says so, because this one depends on the metrics of whatever font `system-ui`
    // resolves to and a bare "expected 13.75 to be less than 0.5" in English would read as
    // a bidi regression.
    expect(
      Math.abs(start.top - end.top),
      "the tile's detail line wrapped between the two clock times, so their order says " +
        "nothing about direction. Widen the browser project's viewport rather than " +
        "reading this as a bidi failure.",
    ).toBeLessThan(HAIR);

    // The en dash between two clock times is bidi-neutral and sits between two numbers,
    // so an unisolated range in a Hebrew line renders as 18:00\u201315:00 — the bug #4 shipped.
    expect(start.left).toBeLessThan(end.left);
    expect(start.width).toBeGreaterThan(0);
  });

  it("puts a Meeting under the heading of the day it falls on", async () => {
    const screen = await openWeek(language);
    const heading = all(screen, ".week-head").find(
      // the day name comes from the translation file, so this reads the same fixture the
      // screen does rather than spelling "Tuesday" or "שלישי" here
      (head) => head.textContent === t(language, "tuesday"),
    );
    if (heading === undefined) throw new Error("the week has no Tuesday heading");

    const tile = findText(screen, `${TIME_RANGE.start}\u2013${TIME_RANGE.end}`).parentElement?.closest(
      ".tile",
    );
    if (!(tile instanceof HTMLElement)) throw new Error("the times are on no tile");

    // Which column a tile is in is DOM order, which render.test.ts can already see. That
    // the column is under the right heading is a fact about where the two ended up, and it
    // has to hold with the columns running the other way round.
    const above = heading.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(above.left - HAIR);
    expect(box.right).toBeLessThanOrEqual(above.right + HAIR);
  });

  it("keeps every tile inside the day column it belongs to", async () => {
    const screen = await openWeek(language);
    const columns = all(screen, ".day-column");
    expect(columns.length).toBeGreaterThan(0);

    const escaped: string[] = [];
    for (const column of columns) {
      const box = column.getBoundingClientRect();
      for (const tile of all(column, ".tile")) {
        const rect = tile.getBoundingClientRect();
        const inside =
          rect.left >= box.left - HAIR &&
          rect.right <= box.right + HAIR &&
          rect.top >= box.top - HAIR &&
          rect.bottom <= box.bottom + HAIR;
        if (!inside) escaped.push(`${tile.textContent ?? ""}: ${JSON.stringify(rect)}`);
      }
    }

    expect(escaped).toEqual([]);
    // the fixture puts a Meeting against the top of the range and another against the
    // bottom, so this was asked at both edges and not only in the middle of the grid
    expect(all(screen, ".day-column .tile").length).toBe(3);
  });

  it("leaves the first hour label clear of the sticky corner", async () => {
    const screen = await openWeek(language);
    const corner = one(screen, ".week-corner").getBoundingClientRect();
    const first = one(screen, ".hour-label-first").getBoundingClientRect();

    // every other label is lifted to straddle its line; this one would be lifted under
    // the corner, which paints over it, so it sits below the corner's bottom edge
    expect(first.top).toBeGreaterThanOrEqual(corner.bottom - HAIR);
    expect(first.height).toBeGreaterThan(0);
  });

  it("draws the page's own focus ring on whatever the keyboard lands on", async () => {
    const screen = await openWeek(language);

    // The ring is `2px solid var(--ink)`, and Chromium draws a ring of its own on anything
    // focusable whether the page asks for one or not -- so "an outline exists" is a claim
    // about the browser, not about this page. The ink is read off the page rather than
    // named here, so refining the palette moves both sides of this at once.
    const ink = getComputedStyle(one(screen, ".tile-name")).color;
    const reached: string[] = [];
    const wrong: string[] = [];

    // walking with the keyboard rather than calling focus(): :focus-visible is about how
    // the element was reached, and a mouse must not draw the same ring
    for (let step = 0; step < 12; step += 1) {
      await userEvent.tab();
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !screen.contains(focused)) continue;

      const ring = getComputedStyle(focused);
      const what = `${focused.tagName.toLowerCase()}.${focused.className}`;
      reached.push(what);
      if (Number.parseFloat(ring.outlineWidth) <= 0 || ring.outlineColor !== ink) {
        wrong.push(`${what}: ${ring.outlineWidth} ${ring.outlineColor}, wanted ${ink}`);
      }
    }

    expect(wrong).toEqual([]);
    expect(reached.length).toBeGreaterThan(2);
    expect(reached.some((what) => what.includes("tile"))).toBe(true);
  });


  it("follows the system colour scheme rather than a stamp on the page", async () => {
    await colorScheme("light");
    const light = await openWeek(language);
    const lightPaper = luminance(getComputedStyle(one(light, ".week")).backgroundColor);
    const lightInk = luminance(getComputedStyle(one(light, ".tile-name")).color);

    // paper is the light thing and ink the dark thing written on it
    expect(lightPaper).toBeGreaterThan(lightInk);

    root?.unmount();
    host?.remove();
    await colorScheme("dark");
    const dark = await openWeek(language);
    const darkPaper = luminance(getComputedStyle(one(dark, ".week")).backgroundColor);
    const darkInk = luminance(getComputedStyle(one(dark, ".tile-name")).color);

    // and in the dark the two have swapped, which is the whole claim: the tokens were
    // redefined, not filtered. Which hues they were redefined to is deliberately not
    // asserted -- docs/design.md still defers refining them.
    expect(darkPaper).toBeLessThan(darkInk);
    expect(darkPaper).toBeLessThan(lightPaper);

    // and the week is still a week in the dark: the gutter has not moved to the other side
    const gutter = one(dark, ".hour-gutter").getBoundingClientRect();
    const sunday = all(dark, ".day-column")[0]?.getBoundingClientRect();
    if (sunday === undefined) throw new Error("the week has no days");
    if (rightToLeft) expect(gutter.left).toBeGreaterThanOrEqual(sunday.right - HAIR);
    else expect(gutter.right).toBeLessThanOrEqual(sunday.left + HAIR);
  });
});
