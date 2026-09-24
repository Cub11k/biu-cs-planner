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
import { StrictMode } from "react";
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
/**
 * Which revision the fake server's State File is, moved by every save it accepts. A save
 * that names another one is refused, exactly as the real server refuses it (#90) — so these
 * tests only pass while the screen is carrying the revision it was served and handing it
 * back on the next click.
 */
let version: number;
/** Set to answer the next save as a file that changed under the page. */
let changedUnderneath: boolean;
/**
 * Holds the *read* of the Timetable open while the Catalog is served at once, which is the
 * window #111 is about: the screen asks for both in parallel, so the week is clickable
 * before the State File has been read.
 */
let readHeld: Promise<void> | undefined;

/** Holds the next save open, so a test can look at the screen with one in flight. */
let saveHeld: Promise<void> | undefined;

/** Holds the next Timetable reads, and gives back the release. */
function holdTheRead(): () => void {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = (): void => resolve();
  });
  readHeld = promise;
  return () => {
    readHeld = undefined;
    release();
  };
}

/**
 * Holds one save's **answer**, after the fake has accepted it and moved the file. That is the
 * only way to make a refusal resolve *before* the success that caused it, which is the order
 * a single `staleSave` boolean used to lose.
 */
let answerHeldFor: string | undefined;
let answerHeld: Promise<void> | undefined;

function holdTheAnswerFor(groupNumber: string): () => void {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = (): void => resolve();
  });
  answerHeldFor = groupNumber;
  answerHeld = promise;
  return () => {
    answerHeldFor = undefined;
    answerHeld = undefined;
    release();
  };
}

/** The same, for the saves. */
function holdTheSaves(): () => void {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = (): void => resolve();
  });
  saveHeld = promise;
  return () => {
    saveHeld = undefined;
    release();
  };
}

/** One of the fixture's Groups as a Pick, the way a State File on disk would hold it. */
function pickOf(groupNumber: string, lessonType = "הרצאה"): GroupPick {
  const group = OFFERING.groups.find(
    (candidate) => candidate.number === groupNumber && candidate.lessonType === lessonType,
  );
  if (group === undefined) throw new Error(`the fixture has no Group ${groupNumber}`);
  return {
    courseNumber: OFFERING.courseNumber,
    lessonType: group.lessonType,
    groupNumber: group.number,
    meetings: [...group.meetings],
  };
}

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
  version = 0;
  changedUnderneath = false;
  readHeld = undefined;
  saveHeld = undefined;
  answerHeldFor = undefined;
  answerHeld = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    sent.push({ method, pathname, body });

    if (pathname === "/api/workspace/changes") return json({ changeCount: 0 });
    if (!pathname.startsWith("/api/timetable")) return json({ offerings: [OFFERING] });
    // only the read is held: a save the screen decides to send still goes through at once,
    // so a test can tell "nothing was sent" from "something was sent and is waiting"
    if (method === "GET" && readHeld !== undefined) await readHeld;
    if (refuse !== undefined) {
      return new Response(JSON.stringify(refuse), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "POST" || method === "DELETE") {
      if (saveHeld !== undefined) await saveHeld;
      const { basedOn } = body as { basedOn?: string };
      if (changedUnderneath) {
        changedUnderneath = false;
        // somebody else wrote the file, so the revision the page holds is not the file's
        version += 1;
        return new Response(JSON.stringify({ reason: "state-file-changed", warnings: [] }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      if (basedOn !== `v${version}`) {
        // Refused the way the real server refuses it rather than thrown: `basedOn: undefined`
        // is the claim that there is no State File, and a 409 `state-file-changed` is the
        // answer #90's guard gives it. Throwing here would come back as "unreachable" and
        // hide the very notice #111 is about — so what the screen must never say is a
        // sentence this fake can actually produce.
        return new Response(JSON.stringify({ reason: "state-file-changed", warnings: [] }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      version += 1;

      // Held here, after the file has moved and before its Picks change: another save now
      // sees a revision it cannot match and is refused, while this one's effect stays
      // invisible until its answer is read. That is what makes a refusal readable *before*
      // the success that caused it, which is the order a single boolean used to lose.
      if (
        answerHeld !== undefined &&
        (body as { groupNumber?: string } | undefined)?.groupNumber === answerHeldFor
      ) {
        await answerHeld;
      }
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

    return json({ variantName: "A", picks, clashes, version: `v${version}`, warnings: [] });
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  globalThis.fetch = realFetch;
});

/**
 * The screen, with the Course chosen, so its Groups are on the week as options.
 *
 * `strict` mounts it the way `main.tsx` mounts the app, which double-invokes every effect:
 * the effect that sends a held click has to send it once and not twice, and nothing below a
 * real mount can say whether it does.
 */
async function openWeek(options: { strict?: boolean } = {}): Promise<HTMLElement> {
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  const screen = <TimetableScreen language="en" onLanguage={() => {}} today={TODAY} />;
  root.render(options.strict === true ? <StrictMode>{screen}</StrictMode> : screen);

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

/**
 * The external-edit guard as the student meets it (#90): the file changed under the page, the
 * click was refused rather than allowed to overwrite whoever else's edit, and the screen says
 * so and shows the file as it now is — it does not blank the week it can still see.
 */
it("says a click was not saved when the file changed under the page, and keeps the week", async () => {
  const mounted = await openWeek();
  tileFor(mounted, "01").click();
  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) throw new Error("not picked");
  });
  const readsBefore = sent.filter((request) => request.method === "GET").length;

  changedUnderneath = true;
  tileFor(mounted, "03", "Tirgul").click();

  await vi.waitFor(() => {
    if (!(mounted.textContent ?? "").includes("your click was not saved")) {
      throw new Error("a refused save said nothing to the student");
    }
  });
  // the Pick that is in the file is still drawn: a refusal costs nothing already there
  expect(tileFor(mounted, "01").classList.contains("is-picked")).toBe(true);
  expect(mounted.textContent).toContain("1 group picked");
  // and the screen re-read, so what it shows is the file rather than its own memory of it
  expect(sent.filter((request) => request.method === "GET").length).toBeGreaterThan(readsBefore);

  // The notice is the account of *that* click, so the next click is what retires it — not a
  // later success, which may be another click's answer entirely (#111).
  tileFor(mounted, "03", "Tirgul").click();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "03", "Tirgul").classList.contains("is-picked")) {
      throw new Error("clicking again after a refusal saved nothing");
    }
  });
  expect(mounted.textContent).not.toContain("your click was not saved");
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

/**
 * #111, the window itself: the Catalog is served at once and the read of the State File is
 * held, so the week is on screen and clickable before the Picks are known.
 *
 * A browser and not a unit test of the reducer, because what is wrong is the join — which
 * revision a click claims, and whether a tile the page has not read reads as unpicked. Only
 * a mounted screen with two answers arriving at different times has both halves.
 */
const STILL_LOADING = "Your saved picks are still loading";
const NOT_SAVED = "Your click was not saved.";
const FILE_CHANGED = "The file changed since this page read it";

/** March 2027: the Spring Semester of the same Academic Year, which is another week. */
const ANOTHER_SEMESTER = new Date(2027, 2, 15);

/** Waits for a sentence to reach the screen, and says which one was missing when it does not. */
async function waitForText(mounted: HTMLElement, wanted: string): Promise<void> {
  await vi.waitFor(() => {
    if (!(mounted.textContent ?? "").includes(wanted)) {
      throw new Error(`the screen never said "${wanted}"`);
    }
  });
}

/**
 * How a tile is actually drawn, so a class nothing styles cannot pass for a state.
 *
 * `opacity` is asserted as well as the border because dimming the tile is the tempting way to
 * draw "not read yet" and it takes the 11px detail line below 3:1 with it: the state has to
 * be carried by the border, not by fading the words.
 */
const drawnAs = (tile: HTMLElement): { border: string; colour: string; opacity: number } => {
  const style = getComputedStyle(tile);
  return {
    border: style.borderTopStyle,
    colour: style.borderTopColor,
    opacity: Number(style.opacity),
  };
};

it("draws a Group as neither picked nor unpicked while the Picks are still loading", async () => {
  const release = holdTheRead();
  const mounted = await openWeek();
  const unread = tileFor(mounted, "01");

  // unknowable rather than false: no ink, no pencil, and `mixed` rather than `false` —
  // the page has not read the file and says so instead of guessing
  expect(unread.classList.contains("is-unread")).toBe(true);
  expect(unread.classList.contains("is-picked")).toBe(false);
  expect(unread.getAttribute("aria-pressed")).toBe("mixed");
  expect(unread.getAttribute("aria-busy")).toBe("true");
  // and it is *drawn* as neither, not merely classed as neither
  const asUnread = drawnAs(unread);
  expect(asUnread.border).toBe("dotted");
  expect(asUnread.opacity).toBe(1);

  release();

  // once the Picks are read, the same Group is the pencil option it turns out to be
  await vi.waitFor(() => {
    if (tileFor(mounted, "01").classList.contains("is-unread")) {
      throw new Error("the Picks arrived and the week is still unread");
    }
  });
  const pencil = tileFor(mounted, "01");
  expect(pencil.getAttribute("aria-pressed")).toBe("false");
  expect(pencil.getAttribute("aria-busy")).toBe("false");
  const asPencil = drawnAs(pencil);
  expect(asPencil.border).toBe("dashed");
  expect(asPencil.opacity).toBe(1);
  // two properties apart, as this week's states are required to be
  expect(asUnread.colour).not.toBe(asPencil.colour);
});

it("holds a click made before the Picks arrived, says so, and saves it on the revision they bring", async () => {
  const release = holdTheRead();
  const mounted = await openWeek();

  tileFor(mounted, "01").click();

  // nothing is sent on a revision nobody has read: `basedOn: undefined` is the claim that
  // there is no State File, and the guard would refuse it as a file that changed (#90)
  await waitForText(mounted, STILL_LOADING);
  expect(sent.filter((request) => request.method !== "GET")).toEqual([]);

  release();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) {
      throw new Error("the held click never reached the file");
    }
  });
  // the revision the first answer carried, not `undefined`
  const recorded = sent.filter((request) => request.method === "POST");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.body).toMatchObject({ groupNumber: "01", basedOn: "v0" });
  // and the student was never sent looking for a change that never happened
  expect(mounted.textContent).not.toContain(FILE_CHANGED);
  expect(mounted.textContent).not.toContain(STILL_LOADING);
  expect(mounted.textContent).toContain("1 group picked");
});

/**
 * A `mixed` tile does not change state when it is clicked and nothing moves focus, so a
 * screen-reader user has no way to tell a held click from a lost one unless the notice is
 * announced. Every sentence that accounts for a click lives in one live region.
 */
it("puts the account of a click in a live region, so it is announced", async () => {
  const release = holdTheRead();
  const mounted = await openWeek();

  tileFor(mounted, "01").click();
  await waitForText(mounted, STILL_LOADING);

  const region = mounted.querySelector('[role="status"]');
  expect(region?.textContent).toContain(STILL_LOADING);
  release();
  // and the count that replaces it is announced by the same region
  await vi.waitFor(() => {
    if (!(region?.textContent ?? "").includes("1 group picked")) {
      throw new Error("the region never carried what became of the click");
    }
  });
});

/**
 * The half that predates #90: a click on a Group the file already picks used to send a POST,
 * because `picks` fell back to `[]` and every tile read as unpicked. There is nothing to
 * send — the file already says what the click asked for — so nothing is sent, and the ink
 * the student wanted is what they get.
 */
it("sends nothing at all for a held click on a Group the file already picks", async () => {
  picks = [pickOf("01")];
  const release = holdTheRead();
  const mounted = await openWeek();

  tileFor(mounted, "01").click();
  await waitForText(mounted, STILL_LOADING);

  release();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) {
      throw new Error("the Pick in the file never reached the week");
    }
  });
  await vi.waitFor(() => {
    if ((mounted.textContent ?? "").includes(STILL_LOADING)) {
      throw new Error("the click is still said to be waiting");
    }
  });
  expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
  expect(mounted.textContent).not.toContain(FILE_CHANGED);
  // and the Pick was not replaced by itself: one Pick, the one that was already there
  expect(mounted.textContent).toContain("1 group picked");
});

/**
 * Two clicks in the window are two Picks, in the order they were made — each on the revision
 * the one before it produced. A queue rather than a last-click-wins, because dropping the
 * first silently is the failure this ticket is about.
 */
it("saves several held clicks in order, each on the revision the one before produced", async () => {
  const release = holdTheRead();
  const mounted = await openWeek();

  tileFor(mounted, "01").click();
  tileFor(mounted, "03", "Tirgul").click();
  await waitForText(mounted, STILL_LOADING);

  release();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "03", "Tirgul").classList.contains("is-picked")) {
      throw new Error("the second held click never reached the file");
    }
  });
  expect(tileFor(mounted, "01").classList.contains("is-picked")).toBe(true);
  const recorded = sent.filter((request) => request.method === "POST");
  expect(recorded.map((request) => request.body)).toMatchObject([
    { groupNumber: "01", basedOn: "v0" },
    { groupNumber: "03", basedOn: "v1" },
  ]);
  expect(mounted.textContent).not.toContain(FILE_CHANGED);
  expect(mounted.textContent).toContain("2 groups picked");
});

/**
 * And when the Picks never arrive there is no revision to save on and no week to reconcile
 * against, so the held click is dropped — but said, because a click that vanishes without a
 * word is exactly what this ticket was filed about.
 */
it("says a held click was not saved when the Picks could not be read at all", async () => {
  const release = holdTheRead();
  const mounted = await openWeek();

  tileFor(mounted, "01").click();
  await waitForText(mounted, STILL_LOADING);

  refuse = { reason: "state-file-unreadable", warnings: [] };
  release();

  await waitForText(mounted, NOT_SAVED);
  expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
  // the refusal it is, and not the one about a file that changed
  expect(mounted.textContent).not.toContain(FILE_CHANGED);
});

/**
 * A held click belongs to the week it was made on. One State File holds every Semester, so
 * its revision would accept a Pick saved into a Semester the student has left — and the Picks
 * of the week now on screen are not the ones this click has to be reconciled against either.
 * So the answer it was waiting for never comes, and it is dropped and said rather than
 * applied somewhere it was never aimed.
 */
it("drops a held click when the screen is asked about another week, and says so", async () => {
  const release = holdTheRead();
  const mounted = await openWeek();

  tileFor(mounted, "01").click();
  await waitForText(mounted, STILL_LOADING);

  // the same mounted screen, now asked about the Spring Semester
  root?.render(
    <TimetableScreen language="en" onLanguage={() => {}} today={ANOTHER_SEMESTER} />,
  );
  release();

  await waitForText(mounted, NOT_SAVED);
  expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
  expect(mounted.textContent).not.toContain(FILE_CHANGED);
  expect(mounted.textContent).not.toContain(STILL_LOADING);
});

/**
 * `main.tsx` wraps the app in `StrictMode`, so every *mount* effect runs twice — including the
 * two that ask the API. This is the screen mounted the way the app mounts it, with the held
 * click still landing exactly once.
 *
 * It is deliberately **not** the test of the effect that sends a held click: that one is not a
 * mount effect, so `StrictMode` never double-invokes it. What guards it is the test below.
 */
it("holds and sends a click once when mounted the way the app mounts it", async () => {
  const release = holdTheRead();
  const mounted = await openWeek({ strict: true });

  tileFor(mounted, "01").click();
  await waitForText(mounted, STILL_LOADING);

  release();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) {
      throw new Error("the held click never reached the file");
    }
  });
  expect(sent.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(mounted.textContent).toContain("1 group picked");
  expect(mounted.textContent).not.toContain(FILE_CHANGED);
});

/**
 * The send is guarded against being started twice, and this is the way that can happen: the
 * save moves the Workspace's change count, so the screen re-reads *while its own save is in
 * flight* (#88), and the fresh answer runs this effect again with the click still held —
 * because the click only leaves the queue when its save answers.
 *
 * Without the guard the Pick is recorded twice, on a revision the first save has replaced, so
 * the second comes back as the file having changed: #111's own notice, produced by its fix.
 */
it("starts a held click's save once even when a fresh answer arrives mid-save", async () => {
  const releaseRead = holdTheRead();
  const releaseSaves = holdTheSaves();
  const mounted = await openWeek();

  tileFor(mounted, "01").click();
  await waitForText(mounted, STILL_LOADING);
  releaseRead();

  // the held click is now in flight, and stays in flight until the saves are released
  await vi.waitFor(() => {
    if (!sent.some((request) => request.method === "POST")) {
      throw new Error("the held click was never sent");
    }
  });

  // what the watcher does to a screen whose own save moved the folder
  root?.render(
    <TimetableScreen
      language="en"
      onLanguage={() => {}}
      today={TODAY}
      workspaceChanges={1}
    />,
  );
  await vi.waitFor(() => {
    if (sent.filter((request) => request.method === "GET").length < 3) {
      throw new Error("the change count moved and the screen did not re-read");
    }
  });
  // the Picks have arrived and the click is being saved, so "still loading" is no longer true
  expect(mounted.textContent).not.toContain(STILL_LOADING);

  releaseSaves();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) {
      throw new Error("the held click never reached the file");
    }
  });
  expect(sent.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(mounted.textContent).toContain("1 group picked");
  expect(mounted.textContent).not.toContain(FILE_CHANGED);
});

/**
 * A stale refusal mid-drain must not doom the clicks behind it.
 *
 * The refusal leaves the week on screen alone — deliberately, so the student keeps a week they
 * can read — and triggers a re-read. Firing the next held click at the revision that was just
 * refused would send a request that cannot succeed, and lose a click the code had everything
 * it needed to save. It waits for the re-read instead.
 */
it("sends the rest of the queue on the re-read, not on the revision just refused", async () => {
  const release = holdTheRead();
  const mounted = await openWeek();

  tileFor(mounted, "01").click();
  tileFor(mounted, "03", "Tirgul").click();
  await waitForText(mounted, STILL_LOADING);

  // somebody else writes the file while the week is loading, so the first held click is refused
  changedUnderneath = true;
  release();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "03", "Tirgul").classList.contains("is-picked")) {
      throw new Error("the click behind the refused one was lost too");
    }
  });
  const recorded = sent.filter((request) => request.method === "POST");
  expect(recorded.map((request) => request.body)).toMatchObject([
    // refused: the file is v1 by the time this lands
    { groupNumber: "01", basedOn: "v0" },
    // and this one goes out on the revision the re-read brought, not on v0 again
    { groupNumber: "03", basedOn: "v1" },
  ]);
  // the refused click is not re-applied (#104), and the student is told it was not saved
  expect(tileFor(mounted, "01").classList.contains("is-picked")).toBe(false);
  expect(mounted.textContent).toContain(FILE_CHANGED);
  expect(mounted.textContent).toContain("1 group picked");
});

/**
 * Two saves can be in flight at once now — a held click draining while the student clicks
 * again — and the second is refused because the first moved the file. If the success clears
 * the refusal's notice, the refused click is dropped with no account at all: #111's own
 * failure, arriving through #111's own machinery.
 *
 * The order that used to lose it is the one this drives: the refusal is read *before* the
 * success that caused it, which needs the accepted save's answer held open.
 */
it("still says a click was refused when the save that refused it succeeds afterwards", async () => {
  const release = holdTheRead();
  const mounted = await openWeek();

  tileFor(mounted, "01").click();
  await waitForText(mounted, STILL_LOADING);

  // the held click is accepted and moves the file to v1, but its answer is held back
  const releaseAnswer = holdTheAnswerFor("01");
  release();
  await vi.waitFor(() => {
    if (!sent.some((request) => request.method === "POST")) {
      throw new Error("the held click was never sent");
    }
  });

  // a live click on the week still showing v0, so the file has moved under it
  tileFor(mounted, "03", "Tirgul").click();
  await waitForText(mounted, FILE_CHANGED);

  releaseAnswer();

  await vi.waitFor(() => {
    if (!tileFor(mounted, "01").classList.contains("is-picked")) {
      throw new Error("the held click never landed");
    }
  });
  // the refusal is still on screen: the click that was refused is still unaccounted for
  // otherwise, and a success is not an answer about it
  expect(mounted.textContent).toContain(FILE_CHANGED);
  expect(mounted.textContent).toContain("1 group picked");
});
