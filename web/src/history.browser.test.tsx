/// <reference types="@vitest/browser-playwright" />
/**
 * Undo and redo as a student meets them: two buttons in the Timetable header, a week that
 * changes when one is pressed, and a sentence for each of the four ways a press can come to
 * nothing (#144).
 *
 * A browser, because what is under test is a click, an effect, a re-render and — for the
 * focus ring — the cascade. `renderToStaticMarkup` runs no effect and fires no handler, and
 * jsdom has no cascade (issue #45).
 *
 * The API is stood in for by a fake `fetch` that keeps **real stacks**: it pushes the Variant
 * as it stood before each edit, pops on an undo and pushes what it displaced onto the redo
 * side, exactly as `server/src/history.ts` does. A fake that simply answered "moved" could
 * not say what the week shows afterwards, which is the half of this the ticket asks for.
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the name and the times are
 * not, and no crawled data is committed to this repo (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "./index.css";
import { t, type Language } from "./i18n/strings.ts";
import { SCHEME_ATTRIBUTE, SCHEME_STORAGE_KEY, applyScheme } from "./scheme.ts";
import type { Offering } from "./timetable/catalog.ts";
import type { GroupPick } from "./timetable/picks.ts";
import { TimetableScreen } from "./timetable/TimetableScreen.tsx";

const ROOT = document.documentElement;

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
  ],
  exams: { known: false, sittings: [] },
};

let host: HTMLElement | undefined;
let before: HTMLElement | undefined;
let root: Root | undefined;
const realFetch = globalThis.fetch;

/** One entry on a stack: the label the use case gave the edit, and what it displaced. */
type Entry = { label: string; picks: GroupPick[] };

/** The fake server's State File, its two stacks, and its revision. */
let picks: GroupPick[];
let undoStack: Entry[];
let redoStack: Entry[];
let version: number;
/** Every request the fake was sent. */
let sent: Array<{ method: string; pathname: string; body: unknown }>;
/**
 * Made the next step refuse with this reason, the way a 409 arrives. Set by a test that is
 * about the sentence rather than about the stacks.
 */
let refuseStep: { reason?: string; status?: number } | undefined;
/**
 * A lie the fake tells about availability, so a test can drive the refusal a button that was
 * wrong produces. The real server can be in this state honestly: `GET /api/history` is
 * answered from memory, and a second tab can empty a stack between the ask and the click.
 */
let claimCanUndo: boolean | undefined;
/** Holds the next step's answer open, so a test can look at the buttons mid-step. */
let stepHeld: Promise<void> | undefined;
/**
 * Holds the Timetable *reads* open, which is the window between a step's answer and the week
 * catching up to it. Only the reads: a step a test asks for still goes through at once, so
 * "nothing was sent" can be told from "something was sent and is waiting".
 */
let readHeld: Promise<void> | undefined;

/** Holds something open and gives back the release. */
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

const availability = () => ({
  canUndo: claimCanUndo ?? undoStack.length > 0,
  canRedo: redoStack.length > 0,
});

const view = () => ({
  variantName: "A",
  picks,
  clashes: [],
  version: `v${version}`,
  warnings: [],
});

/** One of the fixture's Groups as a Pick, the way a State File on disk would hold it. */
function pickOf(groupNumber: string): GroupPick {
  const group = OFFERING.groups.find((candidate) => candidate.number === groupNumber);
  if (group === undefined) throw new Error(`the fixture has no Group ${groupNumber}`);
  return {
    courseNumber: OFFERING.courseNumber,
    lessonType: group.lessonType,
    groupNumber: group.number,
    meetings: [...group.meetings],
  };
}

/**
 * One step over the stacks, written once for both directions as the server writes it once —
 * so a redo in this fake cannot drift from its undo either.
 */
function step(direction: "undo" | "redo", basedOn: string | undefined): Response {
  if (refuseStep !== undefined) {
    const { reason, status } = refuseStep;
    refuseStep = undefined;
    if (reason === undefined) return conflict({ error: "not-a-history-step" }, status ?? 400);
    // an invalidation throws both stacks away, which is the whole point of it
    if (reason === "history-invalidated") {
      undoStack = [];
      redoStack = [];
    }
    return conflict({ reason, ...availability(), warnings: [] });
  }

  const from = direction === "undo" ? undoStack : redoStack;
  const onto = direction === "undo" ? redoStack : undoStack;
  if (from.length === 0) {
    const nothing = direction === "undo" ? "nothing-to-undo" : "nothing-to-redo";
    return conflict({ reason: nothing, ...availability(), warnings: [] });
  }
  if (basedOn !== `v${version}`) {
    return conflict({ reason: "state-file-changed", ...availability(), warnings: [] });
  }

  const held = from.pop()!;
  onto.push({ label: held.label, picks });
  picks = held.picks;
  version += 1;

  return json({
    label: held.label,
    at: 1_700_000_000_000,
    version: `v${version}`,
    ...availability(),
    warnings: [],
  });
}

beforeEach(() => {
  picks = [];
  undoStack = [];
  redoStack = [];
  version = 0;
  sent = [];
  refuseStep = undefined;
  claimCanUndo = undefined;
  stepHeld = undefined;
  readHeld = undefined;
  localStorage.removeItem(SCHEME_STORAGE_KEY);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    sent.push({ method, pathname, body });

    if (pathname === "/api/workspace/changes") return json({ changeCount: 0 });
    if (pathname === "/api/history") return json(availability());

    if (pathname === "/api/history/undo" || pathname === "/api/history/redo") {
      if (stepHeld !== undefined) await stepHeld;
      const direction = pathname.endsWith("undo") ? "undo" : "redo";
      return step(direction, (body as { basedOn?: string } | undefined)?.basedOn);
    }

    if (!pathname.startsWith("/api/timetable")) return json({ offerings: [OFFERING] });
    if (method === "GET" && readHeld !== undefined) await readHeld;

    if (method === "POST" || method === "DELETE") {
      const { basedOn } = body as { basedOn?: string };
      if (basedOn !== `v${version}`) {
        return conflict({ reason: "state-file-changed", warnings: [] });
      }
      // an edit pushes what it displaced, and a new edit is a new future (ADR-0013)
      undoStack.push({
        label: method === "POST" ? "pick-group" : "remove-pick",
        picks,
      });
      redoStack = [];
      version += 1;

      if (method === "POST") {
        const pick = body as GroupPick;
        picks = [
          ...picks.filter(
            (held) =>
              held.courseNumber !== pick.courseNumber || held.lessonType !== pick.lessonType,
          ),
          pick,
        ];
      } else {
        const slot = body as { courseNumber: string; lessonType: string };
        picks = picks.filter(
          (held) =>
            held.courseNumber !== slot.courseNumber || held.lessonType !== slot.lessonType,
        );
      }
    }

    return json(view());
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  before?.remove();
  root = undefined;
  host = undefined;
  before = undefined;
  globalThis.fetch = realFetch;
  localStorage.removeItem(SCHEME_STORAGE_KEY);
  applyScheme(ROOT, "system");
});

/** The screen, with the fixture Course chosen so its Groups are on the week as options. */
async function openWeek(language: Language = "en"): Promise<HTMLElement> {
  // Focus starts from a button of this test's own, so a Tab assertion starts from a known
  // place rather than from wherever the previous test left it.
  const first = document.createElement("button");
  first.textContent = "before";
  before = first;
  document.body.append(first);

  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(<TimetableScreen language={language} onLanguage={() => {}} today={TODAY} />);

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

const buttonFor = (mounted: HTMLElement, which: "undo" | "redo"): HTMLButtonElement => {
  const found = mounted.querySelector<HTMLButtonElement>(`button[data-history="${which}"]`);
  if (found === null) throw new Error(`the header has no ${which} button`);
  return found;
};

/**
 * The tile for one Group, found by the detail line `tileText` writes on it — the Lesson Type
 * as well as the number, because a Group is identified by both (CONTEXT.md, "Group").
 */
function tileFor(
  mounted: HTMLElement,
  groupNumber: string,
  // `lessonType.ts` renders the Hebrew label Shoham printed into the screen's language, so
  // the line a Hebrew screen writes is not the line an English one writes
  lessonType = "Lecture",
): HTMLElement {
  const detail = `89-110 · ${lessonType} · ${groupNumber}`;
  const found = [...mounted.querySelectorAll<HTMLElement>(".day-column .tile")].find((tile) =>
    tile.textContent?.includes(detail),
  );
  if (found === undefined) throw new Error(`no tile reading "${detail}"`);
  return found;
}

const isPicked = (mounted: HTMLElement, groupNumber: string, lessonType?: string): boolean =>
  tileFor(mounted, groupNumber, lessonType).classList.contains("is-picked");

/** Waits for a sentence to reach the screen, and says which one was missing when it does not. */
async function saying(mounted: HTMLElement, sentence: string): Promise<void> {
  await vi.waitFor(() => {
    if (!(mounted.textContent ?? "").includes(sentence)) {
      throw new Error(`the screen never said "${sentence}"`);
    }
  });
}

/** Picks Group 01 and waits for the ink, which is the edit every test below starts from. */
async function pickOne(mounted: HTMLElement, lessonType?: string): Promise<void> {
  tileFor(mounted, "01", lessonType).click();
  await vi.waitFor(() => {
    if (!isPicked(mounted, "01", lessonType)) {
      throw new Error("the click never reached the file");
    }
  });
}

/** `#16324f` as a browser reports a resolved colour, so the two can be compared. */
function asRgb(hex: string): string {
  const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((at) =>
    Number.parseInt(hex.slice(at, at + 2), 16),
  );
  return `rgb(${red}, ${green}, ${blue})`;
}

it("offers neither direction until there is an edit to undo", async () => {
  const mounted = await openWeek();

  // Availability is the server's answer, and on a fresh State File the answer is no to both.
  expect(buttonFor(mounted, "undo").disabled).toBe(true);
  expect(buttonFor(mounted, "redo").disabled).toBe(true);
  expect(sent.some((request) => request.pathname === "/api/history")).toBe(true);
});

it("offers undo as soon as a Pick is made, without waiting for the change count", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);

  // The change count never moves in this fake, so nothing but the screen's own ask after an
  // edit can light this: a button that waited for the poll would still be grey here.
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });
  // …and redo stays out, because a new edit is a new future (ADR-0013)
  expect(buttonFor(mounted, "redo").disabled).toBe(true);
});

it("undoes a Pick: the week stops showing it, and says what was undone", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });

  buttonFor(mounted, "undo").click();

  // The week is re-read rather than guessed at: the answer carries the new revision and no
  // Variant, so what is drawn here came back from the file.
  await vi.waitFor(() => {
    if (isPicked(mounted, "01")) throw new Error("the undo left the Pick on the week");
  });
  await saying(mounted, "Undid picking a group.");
  await saying(mounted, "Nothing picked yet.");
  // the label is a key the UI translates, never words to show
  expect(mounted.textContent).not.toContain("pick-group");
});

it("redoes it again: the Pick comes back, and says what was redone", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });
  buttonFor(mounted, "undo").click();
  // Waited for by what the *week* shows, not by the button lighting up. The button is the
  // step's answer and the week is the read after it, and pressing on the first of those was
  // how this test used to reach the window `steppedOn` now closes — it went red for real.
  await vi.waitFor(() => {
    if (isPicked(mounted, "01")) throw new Error("the undo never reached the week");
  });
  expect(buttonFor(mounted, "redo").disabled).toBe(false);

  buttonFor(mounted, "redo").click();

  await vi.waitFor(() => {
    if (!isPicked(mounted, "01")) throw new Error("the redo did not put the Pick back");
  });
  await saying(mounted, "Redid picking a group.");
  await saying(mounted, "1 group picked");
  // and the undo that displaced it is available again, from the server's own answer
  expect(buttonFor(mounted, "undo").disabled).toBe(false);
});

it("names the edit in Hebrew too, rather than showing an English sentence", async () => {
  const mounted = await openWeek("he");
  await pickOne(mounted, "הרצאה");
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });

  buttonFor(mounted, "undo").click();

  await saying(
    mounted,
    t("he", "undoneEdit", { edit: t("he", "editPickGroup") }),
  );
  expect(mounted.textContent).not.toContain("Undid");
  expect(buttonFor(mounted, "undo").textContent).toBe(t("he", "undo"));
  expect(buttonFor(mounted, "redo").textContent).toBe(t("he", "redo"));
});

it("says a label it has no name for is an edit, rather than printing the key", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });
  // a label a newer server attached: the contract types `label` as a `string`
  undoStack[0]!.label = "reorder-semesters";

  buttonFor(mounted, "undo").click();

  await saying(mounted, "Undid an edit.");
  expect(mounted.textContent).not.toContain("reorder-semesters");
});

it("neither button can be pressed while a step is in flight", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });

  const [held, release] = hold();
  stepHeld = held;
  buttonFor(mounted, "undo").click();

  // A second press would go out on a revision the first has already moved past and come back
  // `state-file-changed`, telling the student their page was stale about their own press.
  await vi.waitFor(() => {
    if (!buttonFor(mounted, "undo").disabled) throw new Error("a second press is still offered");
  });
  expect(buttonFor(mounted, "redo").disabled).toBe(true);

  stepHeld = undefined;
  release();
  await vi.waitFor(() => {
    if (isPicked(mounted, "01")) throw new Error("the undo never landed");
  });
});

it("offers no second press until the week has caught up with the first", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  // a second edit, so there is still something to undo after the first undo lands
  tileFor(mounted, "02").click();
  await vi.waitFor(() => {
    if (!isPicked(mounted, "02")) throw new Error("the second click never reached the file");
  });
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });

  // From here the step's answer arrives and its re-read does not, which is the window: the
  // step has moved the file, so the revision on screen is spent, and a press sent on it would
  // come back `state-file-changed` — the page blaming the student's view for staleness the
  // button it offered had caused.
  const [held, release] = hold();
  readHeld = held;
  buttonFor(mounted, "undo").click();
  await saying(mounted, "Undid picking a group.");

  // The answer has landed, so nothing is in flight any more — and the press is still not
  // offered, because what it would be based on is a revision the file has moved past.
  expect(buttonFor(mounted, "undo").disabled).toBe(true);
  expect(buttonFor(mounted, "redo").disabled).toBe(true);

  readHeld = undefined;
  release();

  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo never came back");
  });
  expect(buttonFor(mounted, "redo").disabled).toBe(false);
  // …and the press that is now offered goes through, rather than being refused on a spent
  // revision. This is the whole point: no `state-file-changed` for a press the page offered.
  buttonFor(mounted, "undo").click();
  await vi.waitFor(() => {
    if (isPicked(mounted, "01")) throw new Error("the second undo never reached the week");
  });
  expect(mounted.textContent).not.toContain(t("en", "historyStale"));
});

/**
 * The four refusals, which are the half of this ticket that carries weight. Each is asserted
 * against the string in the translation files rather than a sentence written here, so a
 * reworded message is not a failing test — and each is checked for what it must *not* say.
 */
it("tells the student the history was let go, without reusing the wording #111 replaced", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });
  // somebody else wrote the file, so every snapshot predates their change (ADR-0013)
  refuseStep = { reason: "history-invalidated" };
  // …and this is what they wrote, which the screen must go and read
  picks = [pickOf("02")];
  version += 1;

  buttonFor(mounted, "undo").click();

  await saying(mounted, t("en", "historyInvalidated"));
  // #111: the page must not claim to know the file changed *since it read it*, which is the
  // sentence that was shown for a file the page had simply not read. This one says what the
  // server actually compared — and says nothing about a click, because none was made.
  expect(mounted.textContent).not.toContain("since this page read it");
  expect(mounted.textContent).not.toContain("your click was not saved");
  // the file it was showing is stale by definition, so it re-read: Group 02 is the file now
  await vi.waitFor(() => {
    if (!isPicked(mounted, "02")) throw new Error("the screen never re-read the changed file");
  });
  // and the buttons are the server's answer to the invalidation, not a memory of before it
  await vi.waitFor(() => {
    if (!buttonFor(mounted, "undo").disabled) throw new Error("undo survived the invalidation");
  });
});

it("tells the student a missing file is recoverable and that nothing was lost", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });
  refuseStep = { reason: "state-file-missing" };

  buttonFor(mounted, "undo").click();

  await saying(mounted, t("en", "historyFileMissing"));
  // Nothing was written and both stacks are intact, so the undo is still offered: a greyed
  // button here would say the history had gone, which is the other refusal's news and not this
  // one's.
  expect(buttonFor(mounted, "undo").disabled).toBe(false);
  // and the week is left exactly as it was, because there is nothing newer to fetch
  expect(isPicked(mounted, "01")).toBe(true);
});

it("corrects a button that was wrong, from the refusal it produced", async () => {
  // The server answers availability from memory, so a second tab can empty the stack between
  // this page asking and this page clicking. The refusal carries the flags for exactly this.
  // Set before the mount, because the header asks the question as it mounts and this fake is
  // never asked again unless an edit or the change count makes it be.
  claimCanUndo = true;
  const mounted = await openWeek();

  const mountedUndo = await vi.waitFor(() => {
    const button = buttonFor(mounted, "undo");
    if (button.disabled) throw new Error("the wrong availability never reached the button");
    return button;
  });
  claimCanUndo = undefined;
  mountedUndo.click();

  await saying(mounted, t("en", "historyNothingToUndo"));
  await vi.waitFor(() => {
    if (!buttonFor(mounted, "undo").disabled) {
      throw new Error("the button did not correct itself from the refusal");
    }
  });
});

it("says nothing changed for a refusal the route named no reason for", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });
  // the 400 on a body the client does not send: no reason to name, and none is invented
  refuseStep = { status: 400 };

  buttonFor(mounted, "undo").click();

  await saying(mounted, t("en", "historyNotDone"));
  expect(mounted.textContent).not.toContain("could not be read");
  expect(isPicked(mounted, "01")).toBe(true);
});

it("retires what a press said when the next click is made", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });
  buttonFor(mounted, "undo").click();
  await saying(mounted, "Undid picking a group.");

  tileFor(mounted, "02").click();

  // The account belongs to the press. A click is a new thing the student did, and the
  // sentence about the press before it would read as an account of this one.
  await vi.waitFor(() => {
    if ((mounted.textContent ?? "").includes("Undid picking a group.")) {
      throw new Error("the undo's account outlived the click after it");
    }
  });
});

it("is reachable by Tab, as the first thing in the header", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });
  before?.focus();

  await userEvent.tab();

  expect(document.activeElement).toBe(buttonFor(mounted, "undo"));

  // Redo is reached once there is one to make. A `disabled` button is deliberately not
  // tabbable — an unavailable undo is not a thing to tab to and be refused by — so both are
  // asserted where both are real: two edits, and one of them undone.
  tileFor(mounted, "02").click();
  await vi.waitFor(() => {
    if (!isPicked(mounted, "02")) throw new Error("the second click never reached the file");
  });
  buttonFor(mounted, "undo").click();
  await vi.waitFor(() => {
    const undo = buttonFor(mounted, "undo");
    const redo = buttonFor(mounted, "redo");
    if (undo.disabled || redo.disabled) throw new Error("both directions are not available");
  });
  before?.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(buttonFor(mounted, "undo"));
  await userEvent.tab();
  expect(document.activeElement).toBe(buttonFor(mounted, "redo"));
});

it("is pressed by the keyboard, not only by a mouse", async () => {
  const mounted = await openWeek();
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });

  buttonFor(mounted, "undo").focus();
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => {
    if (isPicked(mounted, "01")) throw new Error("Enter on the undo button did nothing");
  });
});

it.each([
  { scheme: "light", where: "a light page" },
  { scheme: "dark", where: "a dark page" },
] as const)("shows the stylesheet's own focus ring on $where", async ({ scheme }) => {
  /**
   * Chromium draws a focus ring of its own, so `matches(":focus-visible")` alone would pass
   * with `index.css`'s rule deleted — that has happened in this repo before. What is asserted
   * instead is the ring *that rule* makes: a solid 2px outline in `--ink`, where the user
   * agent's is `auto` and 1px in a colour of its own.
   *
   * Asked in both schemes, because a ring is only visible if it follows the tokens — and #137
   * made light and dark an explicit choice, so the ring could be left reading one palette
   * while the page around it used the other.
   */
  // through storage, because `SchemeControl` stamps the document itself as the header mounts
  localStorage.setItem(SCHEME_STORAGE_KEY, scheme);

  const mounted = await openWeek();
  await vi.waitFor(() => {
    expect(ROOT.getAttribute(SCHEME_ATTRIBUTE)).toBe(scheme);
  });
  await pickOne(mounted);
  await vi.waitFor(() => {
    if (buttonFor(mounted, "undo").disabled) throw new Error("undo is still disabled");
  });
  before?.focus();

  await userEvent.tab();

  const undo = buttonFor(mounted, "undo");
  expect(document.activeElement).toBe(undo);
  expect(undo.matches(":focus-visible")).toBe(true);
  const ring = getComputedStyle(undo);
  expect(ring.outlineStyle).toBe("solid");
  expect(ring.outlineWidth).toBe("2px");
  // read out of the document rather than written here, so tuning a hue is not a failing test
  const ink = getComputedStyle(ROOT).getPropertyValue("--ink").trim();
  expect(ring.outlineColor).toBe(asRgb(ink));
  // …and the two schemes are two rings rather than one reported twice
  expect(ring.outlineColor).not.toBe(
    asRgb(getComputedStyle(ROOT).getPropertyValue("--paper").trim()),
  );
});
