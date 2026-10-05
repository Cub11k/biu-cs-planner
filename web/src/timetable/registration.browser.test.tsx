/// <reference types="@vitest/browser-playwright" />
/**
 * Marking a Variant registered on the Timetable (#297): the confirmation lists every change "apply
 * all" would make before anything is written, both answers send the mark with the answer in it,
 * cancel sends nothing, the tab shows the mark, and unmarking takes it off.
 *
 * A browser, because what is under test is a press, a request and a re-render. The API is the fake
 * in `./fakeTimetableApi.ts`. Every wait is on something the screen shows, never on time.
 *
 * Fixture data is invented: 89-110, 89-210, 89-230 and 89-999 are real BIU course number shapes,
 * the names are not, and no crawled data is committed to this repo (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../index.css";
import { t, type Language } from "../i18n/strings.ts";
import type { Offering } from "./catalog.ts";
import { installFakeApi, type FakeApi, type FakePlanDiffs, type FakeVariant } from "./fakeTimetableApi.ts";
import type { PlanDiff } from "./picks.ts";
import { TimetableScreen } from "./TimetableScreen.tsx";

const TODAY = new Date(2026, 9, 15);

const offering = (courseNumber: string, nameEnglish: string): Offering => ({
  courseNumber,
  nameHebrew: nameEnglish,
  nameEnglish,
  credits: { known: true, total: 5 },
  semesters: ["fall"],
  groups: [{ number: "01", lessonType: "הרצאה", lecturers: [], meetings: [] }],
  exams: { known: false, sittings: [] },
});

const OFFERINGS = [offering("89-110", "Intro"), offering("89-210", "Data Structures")];

const at = { academicYear: 2027, semester: "fall" } as const;
const ADD: PlanDiff = { kind: "add", courseNumber: "89-210", ...at, semesters: ["fall"] };
const MOVE: PlanDiff = { kind: "move", courseNumber: "89-230", ...at, to: "spring", attemptIds: ["a2"] };
const NOT_OFFERED: PlanDiff = { kind: "not-offered", courseNumber: "89-999", ...at, attemptIds: ["a3"] };

let fake: FakeApi | undefined;
let host: HTMLElement | undefined;
let root: Root | undefined;
let startedAt = "";

beforeEach(() => {
  startedAt = `${location.pathname}${location.search}${location.hash}`;
});

afterEach(() => {
  history.replaceState(null, "", startedAt);
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  fake?.restore();
  fake = undefined;
});

const variants = (): FakeVariant[] => [
  { name: "A", primary: true, picks: [], tray: ["89-110", "89-210"] },
  { name: "B", primary: false, picks: [], tray: [] },
];

async function openWeek(
  planDiffs: FakePlanDiffs,
  options: { registers?: Record<string, string[]>; language?: Language; variants?: FakeVariant[] } = {},
): Promise<HTMLElement> {
  fake = installFakeApi({
    offerings: OFFERINGS,
    variants: options.variants ?? variants(),
    planDiffs,
    planned: ["89-110", "89-230", "89-999"],
    registers: options.registers ?? { A: ["89-110", "89-210"] },
  });
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(
    <TimetableScreen language={options.language ?? "en"} onLanguage={() => {}} today={TODAY} workspaceChanges={0} />,
  );
  await vi.waitFor(() => {
    // the actions on the tab shown are enabled once the Timetable has been read
    if (mounted.querySelector('button[data-variant-action="duplicate"]:not([disabled])') === null) {
      throw new Error("the tabs are not ready yet");
    }
  });
  return mounted;
}

const until = (check: () => void) => vi.waitFor(check);

const action = (mounted: HTMLElement, name: string): HTMLButtonElement =>
  mounted.querySelector<HTMLButtonElement>(`button[data-variant-action="${name}"]`)!;

const confirmation = (mounted: HTMLElement): HTMLElement | null =>
  mounted.querySelector<HTMLElement>("[data-registration-confirm]");

const answer = (mounted: HTMLElement, which: "apply" | "mark" | "cancel"): HTMLButtonElement =>
  confirmation(mounted)!.querySelector<HTMLButtonElement>(`button[data-registration="${which}"]`)!;

const marks = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll<HTMLElement>('[role="tab"]')]
    .filter((tab) => tab.querySelector("[data-registered-mark]") !== null)
    .map((tab) => tab.dataset.variant ?? "");

const marksSent = () => fake!.sent.filter((request) => request.pathname.endsWith("/variants/registered"));

it("lists every change apply all would make before anything is written", async () => {
  const mounted = await openWeek({ A: [MOVE, NOT_OFFERED, ADD] });

  action(mounted, "mark-registered").click();

  await until(() => expect(confirmation(mounted)).not.toBeNull());
  expect(confirmation(mounted)!.getAttribute("role")).toBe("dialog");
  expect(confirmation(mounted)!.textContent).toContain(t("en", "registrationHeading", { name: "A" }));
  const changes = [...confirmation(mounted)!.querySelectorAll("li")].map((li) => li.textContent);
  expect(changes).toEqual([
    "89-230 is planned for this semester, but this year's catalog offers it in Semester B. Move to Semester B in plan.",
    "89-999 is planned for this semester, but is not in this year's catalog. Nothing to apply.",
    "Data Structures is in this variant but not in your plan for this semester. Add to plan.",
    "Set to registered in your plan: Intro, Data Structures.",
  ]);
  // the preview was read for the Variant on screen, and nothing has been sent that writes
  expect(fake!.sent.find((request) => request.pathname.endsWith("/registration"))?.search).toBe(
    "?variant=A&position=0",
  );
  expect(marksSent()).toEqual([]);
  // the answer the question is about has the focus
  expect(document.activeElement).toBe(answer(mounted, "apply"));
});

it("sends apply all as the mark with applyDiffs, and the tab shows the mark", async () => {
  const mounted = await openWeek({ A: [MOVE, ADD] });
  action(mounted, "mark-registered").click();
  await until(() => expect(confirmation(mounted)).not.toBeNull());

  answer(mounted, "apply").click();

  await until(() => expect(marks(mounted)).toEqual(["A"]));
  expect(marksSent()).toEqual([
    expect.objectContaining({
      method: "POST",
      // with the digest of the list the confirmation showed (#355)
      body: { variant: "A", position: 0, applyDiffs: true, digest: JSON.stringify([MOVE, ADD]), basedOn: "v0" },
    }),
  ]);
  expect(confirmation(mounted)).toBeNull();
  expect(fake!.labels).toEqual(["mark-variant-registered"]);
  // the Plan Diffs the mark applied are gone with it
  await until(() => expect(mounted.querySelectorAll(".plan-diff-badge")).toHaveLength(0));
});

it("sends only mark with applyDiffs false, and leaves the Plan Diffs where they were", async () => {
  const mounted = await openWeek({ A: [ADD] });
  action(mounted, "mark-registered").click();
  await until(() => expect(confirmation(mounted)).not.toBeNull());

  answer(mounted, "mark").click();

  await until(() => expect(marks(mounted)).toEqual(["A"]));
  expect(marksSent()[0]?.body).toEqual({ variant: "A", position: 0, applyDiffs: false, basedOn: "v0" });
  expect(mounted.querySelectorAll(".plan-diff-badge")).toHaveLength(1);
});

it("sends nothing when the confirmation is cancelled", async () => {
  const mounted = await openWeek({ A: [ADD] });
  action(mounted, "mark-registered").click();
  await until(() => expect(confirmation(mounted)).not.toBeNull());

  answer(mounted, "cancel").click();

  await until(() => expect(confirmation(mounted)).toBeNull());
  expect(marksSent()).toEqual([]);
  expect(marks(mounted)).toEqual([]);
});

it("marks without asking when there is nothing to apply and nothing to register", async () => {
  const mounted = await openWeek({ A: [NOT_OFFERED] }, { registers: {} });

  action(mounted, "mark-registered").click();

  await until(() => expect(marks(mounted)).toEqual(["A"]));
  expect(marksSent()[0]?.body).toMatchObject({ applyDiffs: false });
  expect(confirmation(mounted)).toBeNull();
});

it("unmarks the registered Variant from its tab", async () => {
  const mounted = await openWeek(
    {},
    { variants: [{ name: "A", primary: true, registered: true, picks: [], tray: [] }], registers: {} },
  );
  await until(() => expect(marks(mounted)).toEqual(["A"]));

  action(mounted, "unmark-registered").click();

  await until(() => expect(marks(mounted)).toEqual([]));
  expect(marksSent()).toEqual([
    expect.objectContaining({ method: "DELETE", body: { variant: "A", position: 0, basedOn: "v0" } }),
  ]);
  expect(action(mounted, "mark-registered")).not.toBeNull();
});

it("says so when a hand-edited file marks two Variants registered", async () => {
  const mounted = await openWeek(
    {},
    {
      variants: [
        { name: "A", primary: true, registered: true, picks: [], tray: [] },
        { name: "B", primary: false, registered: true, picks: [], tray: [] },
      ],
      registers: {},
    },
  );

  await until(() => expect(mounted.textContent).toContain(t("en", "variantRegisteredNotUnique")));
  expect(mounted.textContent).not.toContain(t("en", "variantPrimaryNotUnique"));
  expect(marks(mounted)).toEqual(["A", "B"]);
});

it("marks the tab it was pressed on, even when another tab is shown before the preview arrives", async () => {
  const mounted = await openWeek({}, { registers: {} });
  let release = (): void => {};
  fake!.registrationGate = new Promise((resolve) => {
    release = resolve;
  });

  action(mounted, "mark-registered").click();
  await until(() => expect(fake!.sent.some((request) => request.pathname.endsWith("/registration"))).toBe(true));
  mounted.querySelector<HTMLButtonElement>('[role="tab"][data-variant="B"]')!.click();
  await until(() =>
    expect(mounted.querySelector('[role="tab"][data-variant="B"]')?.getAttribute("aria-selected")).toBe("true"),
  );
  release();

  await until(() => expect(marks(mounted)).toEqual(["A"]));
  expect(marksSent()[0]?.body).toMatchObject({ variant: "A", position: 0, applyDiffs: false });
});

it("refuses apply all when the list changed since the confirmation was read, and says so (#355)", async () => {
  const mounted = await openWeek({ A: [MOVE, ADD] });
  action(mounted, "mark-registered").click();
  await until(() => expect(confirmation(mounted)).not.toBeNull());
  // a new Catalog lands while the student reads: the move is gone, so "all" is no longer what was listed
  fake!.planDiffs.A = [ADD];

  answer(mounted, "apply").click();

  await until(() => expect(mounted.textContent).toContain(t("en", "planDiffStale")));
  expect(marksSent()).toHaveLength(1);
  expect(fake!.labels).toEqual([]);
  expect(marks(mounted)).toEqual([]);
  // and the Timetable is read again, so the list on screen is the one the server has
  await until(() => expect(mounted.querySelectorAll(".plan-diff-badge")).toHaveLength(1));
});

it("joins the Courses it would register with the separator of the language shown (#356)", async () => {
  const mounted = await openWeek({ A: [ADD] }, { language: "he" });
  action(mounted, "mark-registered").click();
  await until(() => expect(confirmation(mounted)).not.toBeNull());

  const registers = confirmation(mounted)!.querySelector('[data-registration-change="registers"]')!;
  expect(registers.textContent).toBe(
    t("he", "registrationRegisters", { courses: ["Intro", "Data Structures"].join(t("he", "registrationSeparator")) }),
  );
});
