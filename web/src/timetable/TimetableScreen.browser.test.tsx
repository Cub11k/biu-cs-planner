/// <reference types="@vitest/browser-playwright" />
/**
 * Every place the screen says a refusal it shares with another place, each one rendered on its
 * own (#251).
 *
 * Two sentences are said from more than one site. `workspaceNotReady` answers
 * `workspace-not-ready` in all three refusal maps — a Pick, an undo or redo, and a preference —
 * and `unauthorizedSaid`'s sentence answers a 401 in all four panes: the Catalog, the Picks, the
 * last step and the last preference. A test that finds the sentence *somewhere* on the page pins
 * none of the sites, because any one of them can put it there: PR #241 replaced the value in two
 * of the maps and deleted `case "unauthorized"` from two of the switches, and nothing failed.
 *
 * So each test here arranges for **exactly one** site to be able to say the sentence, with every
 * other source of it answered, and asserts it in the part of the page that site writes to. That
 * arrangement is not a state the real app reaches — a folder that is not a workspace refuses the
 * Timetable read too, and a retired token refuses every route — and it is not meant to be: it is
 * how one site is looked at without the others standing in for it. `../token.browser.test.tsx`
 * is the retired token as a student meets it, and `picking.browser.test.tsx` has the Pick path's
 * `workspace-not-ready`.
 *
 * Every expected sentence comes out of `t()`, so these fail when the wrong key reaches a site or
 * when what a site shows is not the sentence its key holds — and not when a sentence is reworded
 * in the translation files, which is no business of theirs (#252).
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the name and the times are not,
 * and no crawled data is committed to this repo (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../index.css";
import { LANGUAGES, t, type Language, type StringKey } from "../i18n/strings.ts";
import type { SettingsNotice } from "../settings.ts";
import type { Offering } from "./catalog.ts";
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
  ],
  exams: { known: false, sittings: [] },
};

/** One Pick on disk, so the Picks pane has a served sentence of its own to show. */
const PICK = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

let host: HTMLElement | undefined;
let root: Root | undefined;
const realFetch = globalThis.fetch;

/** Whether the Catalog route answers a 401. */
let catalogRefused: boolean;
/** Whether the Timetable route answers a 401. */
let timetableRefused: boolean;
/** How the next undo is answered: a 409 with this reason, or a 401. */
let stepAnswer: { refused: string } | "unauthorized" | undefined;
/** Every request the fake was sent, by path. */
let sent: string[];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Exactly what `server/src/guard.ts` answers, for a wrong token and for none alike. */
const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

beforeEach(() => {
  catalogRefused = false;
  timetableRefused = false;
  stepAnswer = undefined;
  sent = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);
    sent.push(pathname);

    if (pathname === "/api/workspace/changes") return json({ changeCount: 0 });
    // offered, so the undo button can be pressed: the press is what reaches `historyNotice`
    if (pathname === "/api/history") return json({ canUndo: true, canRedo: false });
    if (pathname === "/api/history/undo") {
      const answer = stepAnswer;
      stepAnswer = undefined;
      if (answer === "unauthorized") return unauthorized();
      if (answer !== undefined) {
        return json({ reason: answer.refused, canUndo: true, canRedo: false, warnings: [] }, 409);
      }
      throw new Error("an undo was pressed that this test did not arrange an answer for");
    }
    if (pathname.startsWith("/api/timetable")) {
      if (timetableRefused) return unauthorized();
      return json({ variantName: "A", picks: [PICK], clashes: [], version: "v1", warnings: [] });
    }
    if (pathname.startsWith("/api/catalog/")) {
      if (catalogRefused) return unauthorized();
      return json({ offerings: [OFFERING] });
    }
    throw new Error(`the screen asked ${pathname}, which this fake does not answer`);
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  globalThis.fetch = realFetch;
});

function mount(props: {
  language?: Language;
  tokenHeld?: boolean;
  settingsNotice?: SettingsNotice;
}): HTMLElement {
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(
    <TimetableScreen
      language={props.language ?? "en"}
      onLanguage={() => {}}
      settingsNotice={props.settingsNotice}
      tokenHeld={props.tokenHeld ?? false}
      today={TODAY}
    />,
  );
  return mounted;
}

/** The live region beside the week: the Picks, the last step and the last preference write here. */
function hintLine(mounted: HTMLElement): string {
  const region = mounted.querySelector('[role="status"]');
  if (region === null) throw new Error("the screen has no live region");
  return region.textContent ?? "";
}

/** The sidebar, which is the only place the Catalog says anything. */
function sidebar(mounted: HTMLElement): string {
  const aside = mounted.querySelector("aside");
  if (aside === null) throw new Error("the screen has no sidebar");
  return aside.textContent ?? "";
}

/** Waits for the Picks to be served, which is what makes the undo button pressable. */
async function servedWeek(mounted: HTMLElement, language: Language = "en"): Promise<void> {
  await vi.waitFor(() => {
    expect(hintLine(mounted)).toContain(t(language, "picksCountOne"));
  });
}

async function pressUndo(mounted: HTMLElement): Promise<void> {
  const undo = await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLButtonElement>('button[data-history="undo"]');
    if (found === null) throw new Error("the header has no undo button");
    if (found.disabled) throw new Error("the undo button was never offered");
    return found;
  });
  undo.click();
}

// --- `workspace-not-ready`, on the two paths the Pick path's test does not reach --------------

/**
 * An undo refused because the folder is not a workspace says that, and not the sentence of the
 * map's other arms. The Picks pane is served here, so its own sentence is the count and the
 * refusal sentence can only have come from the step.
 */
it.each(LANGUAGES)(
  "says an undo was refused because the folder is not a workspace, in %s",
  async (language) => {
    const mounted = mount({ language });
    await servedWeek(mounted, language);
    expect(hintLine(mounted)).not.toContain(t(language, "workspaceNotReady"));

    stepAnswer = { refused: "workspace-not-ready" };
    await pressUndo(mounted);

    await vi.waitFor(() => {
      expect(hintLine(mounted)).toContain(t(language, "workspaceNotReady"));
    });
    // the Picks sentence is still the served one: the refusal was the step's, not the week's
    expect(hintLine(mounted)).toContain(t(language, "picksCountOne"));
    expect(hintLine(mounted)).not.toContain(t(language, "picksNone"));
    // and a press of Undo is not a click on a Group (`HISTORY_REFUSAL_STRING`'s comment)
    expect(hintLine(mounted)).not.toContain(t(language, "picksStale"));
  },
);

/** The same for a preference the API would not change, which `App` hands down as a notice. */
it.each(LANGUAGES)(
  "says a preference was refused because the folder is not a workspace, in %s",
  async (language) => {
    const mounted = mount({
      language,
      settingsNotice: { kind: "refused", reason: "workspace-not-ready" },
    });
    await servedWeek(mounted, language);

    expect(hintLine(mounted)).toContain(t(language, "workspaceNotReady"));
    expect(hintLine(mounted)).toContain(t(language, "picksCountOne"));
    expect(hintLine(mounted)).not.toContain(t(language, "picksNone"));
    expect(hintLine(mounted)).not.toContain(t(language, "picksStale"));
  },
);

// --- a 401, pinned in each of the four panes ---------------------------------------------------

/**
 * The sentence each page should see for a 401, and the one it must not. Both token states for
 * every site, so a site that hard-coded either answer fails on the other.
 */
const TOKEN_STATES = [
  { tokenHeld: false, page: "holds no token", said: "tokenMissing", notSaid: "tokenRetired" },
  {
    tokenHeld: true,
    page: "holds a refused token",
    said: "tokenRetired",
    notSaid: "tokenMissing",
  },
] as const satisfies ReadonlyArray<{
  tokenHeld: boolean;
  page: string;
  said: StringKey;
  notSaid: StringKey;
}>;

it.each(TOKEN_STATES)(
  "says a refused Catalog in the sidebar, for a page that $page",
  async ({ tokenHeld, said, notSaid }) => {
    catalogRefused = true;
    const mounted = mount({ tokenHeld });
    await servedWeek(mounted);

    await vi.waitFor(() => {
      expect(sidebar(mounted)).toContain(t("en", said));
    });
    expect(sidebar(mounted)).not.toContain(t("en", notSaid));
    // every other pane was answered, so none of them is saying it
    expect(hintLine(mounted)).not.toContain(t("en", said));
  },
);

it.each(TOKEN_STATES)(
  "says refused Picks in the hint line, for a page that $page",
  async ({ tokenHeld, said, notSaid }) => {
    timetableRefused = true;
    const mounted = mount({ tokenHeld });
    // the Catalog is served, so the sidebar lists the Catalog's Courses and says no refusal
    await vi.waitFor(() => {
      expect(sidebar(mounted)).toContain(OFFERING.courseNumber);
    });

    await vi.waitFor(() => {
      expect(hintLine(mounted)).toContain(t("en", said));
    });
    expect(hintLine(mounted)).not.toContain(t("en", notSaid));
    expect(sidebar(mounted)).not.toContain(t("en", said));
  },
);

it.each(TOKEN_STATES)(
  "says a refused undo in the hint line, for a page that $page",
  async ({ tokenHeld, said, notSaid }) => {
    const mounted = mount({ tokenHeld });
    await servedWeek(mounted);
    // nothing has been refused yet, so whatever says it next is the press
    expect(mounted.textContent).not.toContain(t("en", said));

    stepAnswer = "unauthorized";
    await pressUndo(mounted);

    await vi.waitFor(() => {
      expect(hintLine(mounted)).toContain(t("en", said));
    });
    expect(sent).toContain("/api/history/undo");
    expect(hintLine(mounted)).not.toContain(t("en", notSaid));
    expect(hintLine(mounted)).toContain(t("en", "picksCountOne"));
    expect(sidebar(mounted)).not.toContain(t("en", said));
  },
);

it.each(TOKEN_STATES)(
  "says a refused preference in the hint line, for a page that $page",
  async ({ tokenHeld, said, notSaid }) => {
    const mounted = mount({ tokenHeld, settingsNotice: { kind: "unauthorized" } });
    await servedWeek(mounted);

    expect(hintLine(mounted)).toContain(t("en", said));
    expect(hintLine(mounted)).not.toContain(t("en", notSaid));
    expect(sidebar(mounted)).not.toContain(t("en", said));
  },
);
