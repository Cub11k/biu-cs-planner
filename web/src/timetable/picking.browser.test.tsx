/// <reference types="@vitest/browser-playwright" />
/**
 * Picking a Group by clicking it, and un-picking it by clicking it again.
 *
 * A browser, because what is under test is a click, an effect and a re-render:
 * `renderToStaticMarkup` runs no effect and fires no handler, so `render.test.ts` can say
 * what ink looks like but not that clicking a block produces any. The API is stood in for
 * by a fake `fetch` holding one Variant in memory — the same seam `geometry.browser.test.tsx`
 * uses, because `web` reaches the domain only through the typed client.
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the name and the times are
 * not, and no crawled data is committed to this repo (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../index.css";
import type { Offering } from "./catalog.ts";
import type { GroupPick } from "./picks.ts";
import { TimetableScreen } from "./TimetableScreen.tsx";

/** October 2026: the Fall Semester of Academic Year 2027, which is what the fixture is. */
const TODAY = new Date(2026, 9, 15);

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
    {
      number: "02",
      lessonType: "הרצאה",
      lecturers: [],
      meetings: [{ semester: "fall", day: "sunday", start: "10:00", end: "12:00" }],
    },
    {
      // overlaps lecture 01 on Tuesday afternoon, so picking both is a Clash
      number: "03",
      lessonType: "תרגיל",
      lecturers: [],
      meetings: [{ semester: "fall", day: "tuesday", start: "16:00", end: "17:00" }],
    },
  ],
  exams: { known: false, sittings: [] },
};

/**
 * The Clash the API would find among these Picks, in the shape the contract sends. Spelled
 * out here rather than computed: what is under test is the screen's half of it — the red pen
 * and the count — and `findMeetingClashes` has its own tests in `core`.
 */
const clashBetween = (first: string, second: string) => ({
  kind: "meeting-meeting" as const,
  overlap: { semester: "fall", day: "tuesday", start: "16:00", end: "17:00" },
  first: {
    group: { courseNumber: "89-110", lessonType: "הרצאה", number: first },
    meeting: { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
  },
  second: {
    group: { courseNumber: "89-110", lessonType: "תרגיל", number: second },
    meeting: { semester: "fall", day: "tuesday", start: "16:00", end: "17:00" },
  },
});

let host: HTMLElement | undefined;
let root: Root | undefined;
const realFetch = globalThis.fetch;

/** The Variant the fake API holds, and every request it was sent. */
let picks: GroupPick[] = [];
let sent: Array<{ method: string; pathname: string; body: unknown }> = [];
/** Set to make the next Timetable answer a refusal, the way a 409 arrives. */
let refuse: { reason: string; warnings: unknown[] } | undefined;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * One Variant, served the way `server/src/api.ts` serves it — including that a second Group
 * for a Lesson Type already picked replaces the first, which is the rule the screen relies
 * on rather than one it implements.
 */
beforeEach(() => {
  picks = [];
  sent = [];
  refuse = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    sent.push({ method, pathname, body });

    if (pathname === "/api/workspace/changes") return json({ changeCount: 0 });
    if (!pathname.startsWith("/api/timetable")) return json({ offerings: [OFFERING] });
    if (refuse !== undefined) {
      return new Response(JSON.stringify(refuse), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "POST") {
      const pick = body as GroupPick;
      picks = [
        ...picks.filter(
          (held) =>
            held.courseNumber !== pick.courseNumber || held.lessonType !== pick.lessonType,
        ),
        pick,
      ];
    }
    if (method === "DELETE") {
      const slot = body as { courseNumber: string; lessonType: string };
      picks = picks.filter(
        (held) =>
          held.courseNumber !== slot.courseNumber || held.lessonType !== slot.lessonType,
      );
    }

    // the two Groups that overlap in this fixture, once both are picked
    const clashes =
      picks.some((p) => p.lessonType === "הרצאה" && p.groupNumber === "01") &&
      picks.some((p) => p.lessonType === "תרגיל")
        ? [clashBetween("01", "03")]
        : [];

    return json({ variantName: "A", picks, clashes, warnings: [] });
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  globalThis.fetch = realFetch;
});

/** The screen, with the Course chosen, so its Groups are on the week as options. */
async function openWeek(): Promise<HTMLElement> {
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(<TimetableScreen language="en" onLanguage={() => {}} today={TODAY} />);

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
 * The tile for one Group, found by the detail line `tileText` writes on it — the Lesson Type
 * as well as the number, because a Group is identified by both (CONTEXT.md, "Group").
 */
function tileFor(
  mounted: HTMLElement,
  groupNumber: string,
  lessonType = "Lecture",
): HTMLElement {
  const detail = `89-110 · ${lessonType} · ${groupNumber}`;
  const found = [...mounted.querySelectorAll<HTMLElement>(".day-column .tile")].find((tile) =>
    tile.textContent?.includes(detail),
  );
  if (found === undefined) throw new Error(`no tile reading "${detail}"`);
  return found;
}

it("picks a Group when its block is clicked, and draws it in ink", async () => {
  const mounted = await openWeek();
  expect(tileFor(mounted, "01").classList.contains("is-picked")).toBe(false);

  tileFor(mounted, "01").click();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) {
      throw new Error("the Group was clicked and the block is still pencil");
    }
  });
  const recorded = sent.find((request) => request.method === "POST");
  expect(recorded?.pathname).toBe("/api/timetable/2027/fall/picks");
  // the snapshot of the Group's Meetings travels with the Pick (CONTEXT.md, "Pick")
  expect(recorded?.body).toMatchObject({
    courseNumber: "89-110",
    groupNumber: "01",
    meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
  });
  expect(mounted.textContent).toContain("1 group picked");
});

it("removes the Pick when the picked block is clicked again", async () => {
  const mounted = await openWeek();
  tileFor(mounted, "01").click();
  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) throw new Error("not picked");
  });

  tileFor(mounted, "01").click();

  await vi.waitFor(() => {
    if (tileFor(mounted, "01").classList.contains("is-picked")) {
      throw new Error("the Pick was clicked again and the block is still ink");
    }
  });
  expect(sent.some((request) => request.method === "DELETE")).toBe(true);
  expect(mounted.textContent).toContain("Nothing picked yet");
});

it("replaces the Pick when another Group of the same Lesson Type is clicked", async () => {
  const mounted = await openWeek();
  tileFor(mounted, "01").click();
  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) throw new Error("not picked");
  });

  tileFor(mounted, "02").click();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "02").classList.contains("is-picked")) {
      throw new Error("the second Group was clicked and is still pencil");
    }
  });
  // one Pick per Lesson Type per Offering: the first is gone rather than kept beside it
  expect(tileFor(mounted, "01").classList.contains("is-picked")).toBe(false);
  expect(mounted.textContent).toContain("1 group picked");
});

/**
 * The Clash, drawn. `core` finds it, the API sends it and `week.ts` turns it into keys — all
 * three have their own tests — and this is the join none of them can see: that the keys
 * reach the right tiles, and that the count reaches the hint line.
 */
it("draws a Pick that Clashes in red pen, and still keeps it", async () => {
  const mounted = await openWeek();

  tileFor(mounted, "01").click();
  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) throw new Error("not picked");
  });
  tileFor(mounted, "03", "Tirgul").click();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "03", "Tirgul").classList.contains("is-clashing")) {
      throw new Error("the second Pick overlaps the first and is not in red pen");
    }
  });
  // both sides of the Clash are marked, because a Group is picked whole and the student
  // has to see which one to change
  expect(tileFor(mounted, "01").classList.contains("is-clashing")).toBe(true);
  // and nothing was refused: both are still Picks, and the Clash is counted as a Warning
  expect(tileFor(mounted, "01").classList.contains("is-picked")).toBe(true);
  expect(tileFor(mounted, "03", "Tirgul").classList.contains("is-picked")).toBe(true);
  expect(mounted.textContent).toContain("2 groups picked");
  expect(mounted.textContent).toContain("1 clash");
});

/** The refused answer the screen has to say something honest about. */
it("says the folder is not a workspace rather than that nothing is picked", async () => {
  const mounted = await openWeek();

  refuse = { reason: "workspace-not-ready", warnings: [] };
  tileFor(mounted, "01").click();

  await vi.waitFor(() => {
    if (!(mounted.textContent ?? "").includes("not a workspace yet")) {
      throw new Error("the refusal reached the screen as something else");
    }
  });
  expect(mounted.textContent).not.toContain("Nothing picked yet");
});
