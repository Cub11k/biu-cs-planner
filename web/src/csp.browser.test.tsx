/// <reference types="@vitest/browser-playwright" />
/**
 * The strict CSP `server/src/ui.ts` sends (#170), asked of a real engine: under it, the first paint
 * still stamps the remembered scheme and the Timetable grid still positions its tiles.
 *
 * Each claim is asked in an iframe whose document carries the policy as a `<meta>`, which a browser
 * enforces as it would the header (`frame-ancestors` aside, which a `<meta>` cannot carry and which
 * is about other pages, not this one). The policy is spelled here, because `web` may not import
 * `server`, and `server/src/ui.test.ts` holds this copy to the header: it reads this file and fails
 * when `policy` below is not the header less `frame-ancestors`. The hash is the source stamp's;
 * `ui.test.ts` is what holds the built stamp to the same bytes.
 *
 * The grid is the ruling's open question: React sets `style={{…}}` through the CSSOM, which CSP does
 * not govern, so `style-src 'self'` should hold without `'unsafe-inline'`. React here runs in this
 * page and renders into the iframe's document, so it is that document's policy the styles meet.
 * Each test has a control proving the policy is live: a stamp with the wrong hash does not run, and
 * a `style` attribute written as markup is refused.
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the name and times are not.
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ENTRY_DOCUMENT from "../index.html?raw";
import type { Offering } from "./timetable/catalog.ts";
import { TimetableScreen } from "./timetable/TimetableScreen.tsx";

/** `ui.ts`'s policy for a stamp hashed to `hash`, less `frame-ancestors`. */
const policy = (hash: string): string =>
  `default-src 'self'; script-src 'self' 'sha256-${hash}'; style-src 'self'`;

/** The one inline script of `web/index.html`, as the browser hashes it: its text, byte for byte. */
const stampOf = (html: string): string => {
  const found = new DOMParser().parseFromString(html, "text/html").querySelector("script:not([src])");
  if (found === null) throw new Error("the entry document carries no stamp");
  return found.textContent;
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

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
      meetings: [
        { semester: "fall", day: "sunday", start: "08:00", end: "10:00" },
        { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
      ],
    },
  ],
  exams: { known: false, sittings: [] },
};

const realFetch = globalThis.fetch;
const frames: HTMLIFrameElement[] = [];
let root: Root | undefined;

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);
    const body =
      pathname === "/api/history"
        ? { canUndo: false, canRedo: false }
        : pathname.startsWith("/api/timetable")
          ? { variantName: "A", picks: [], clashes: [], warnings: [] }
          : { offerings: [OFFERING] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  for (const frame of frames.splice(0)) frame.remove();
  localStorage.clear();
  globalThis.fetch = realFetch;
});

/** A document under `csp`: the entry document's head with its module script gone, and the stylesheet linked. */
async function underPolicy(csp: string): Promise<Document> {
  const parsed = new DOMParser().parseFromString(ENTRY_DOCUMENT, "text/html");
  for (const external of parsed.querySelectorAll("script[src]")) external.remove();
  const meta = parsed.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = csp;
  parsed.head.prepend(meta);
  // a same-origin stylesheet, as the build links its own
  const styles = parsed.createElement("link");
  styles.rel = "stylesheet";
  styles.href = "/web/src/index.css";
  parsed.head.append(styles);

  const frame = document.createElement("iframe");
  frames.push(frame);
  frame.style.width = "1600px";
  frame.style.height = "800px";
  frame.srcdoc = `<!doctype html>${parsed.documentElement.outerHTML}`;
  document.body.append(frame);
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  const loaded = frame.contentDocument;
  if (loaded === null) throw new Error("the document did not load");
  return loaded;
}

it("still stamps the remembered scheme before the first paint, allowed by the stamp's hash", async () => {
  localStorage.setItem("biu-cs-planner.scheme", "dark");
  const hash = await sha256(stampOf(ENTRY_DOCUMENT));

  const stamped = await underPolicy(policy(hash));
  expect(stamped.documentElement.getAttribute("data-theme")).toBe("dark");

  // the control: the same document under a hash of anything else, and the stamp is refused
  const refused = await underPolicy(policy(await sha256("not the stamp")));
  expect(refused.documentElement.hasAttribute("data-theme")).toBe(false);
});

it("still positions the Timetable's tiles, which React styles through the CSSOM", async () => {
  const framed = await underPolicy(policy(await sha256(stampOf(ENTRY_DOCUMENT))));

  // the control: a `style` attribute as markup is exactly what `style-src 'self'` refuses
  const probe = framed.createElement("div");
  framed.body.append(probe);
  probe.setAttribute("style", "margin-top: 37px");
  expect(framed.defaultView?.getComputedStyle(probe).marginTop).toBe("0px");

  const host = framed.createElement("div");
  framed.body.append(host);
  root = createRoot(host);
  root.render(<TimetableScreen language="en" onLanguage={() => {}} today={new Date(2026, 9, 15)} />);

  const chooser = await vi.waitFor(() => {
    const found = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(OFFERING.courseNumber));
    if (found === undefined) throw new Error("the Catalog served no Course to choose");
    return found;
  });
  chooser.click();
  const [sunday, tuesday] = await vi.waitFor(() => {
    const tiles = [...host.querySelectorAll<HTMLElement>(".day-column .tile")];
    if (tiles.length !== 2) throw new Error("choosing the Course did not put both Meetings on the week");
    return tiles;
  });

  const column = (tile: HTMLElement): DOMRect => tile.closest(".day-column")!.getBoundingClientRect();
  const hour = Number.parseFloat(framed.defaultView!.getComputedStyle(sunday!).getPropertyValue("--hour"));
  expect(hour).toBeGreaterThan(0);
  // 08:00 opens the week and 15:00 is seven hours below it; a two-hour Meeting is two hours tall,
  // less the hairline between blocks
  expect(sunday!.getBoundingClientRect().top - column(sunday!).top).toBeCloseTo(0, 0);
  expect(tuesday!.getBoundingClientRect().top - column(tuesday!).top).toBeCloseTo(7 * hour, 0);
  expect(sunday!.getBoundingClientRect().height).toBeCloseTo(2 * hour - 2, 0);
});
