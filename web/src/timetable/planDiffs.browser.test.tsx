/// <reference types="@vitest/browser-playwright" />
/**
 * Plan Diffs on the Timetable (#296): a badge on the Tray entry each is about, pressing it offering
 * its "apply to Plan", the side panel listing every one with a one-click apply, the screen following
 * the answer, nothing at all without a Plan, a stale apply said in a sentence, and the Plan Diffs
 * following the Variant tab.
 *
 * A browser, because what is under test is a press, a request and a re-render. The API is the fake
 * in `./fakeTimetableApi.ts`, which serves the Plan Diffs a test gives it — `core` computes them
 * and is tested there — and keeps the revision guard the real server keeps.
 *
 * Every wait is on something the screen shows, never on time (docs/agents/orchestration.md).
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
const DROP: PlanDiff = { kind: "drop", courseNumber: "89-110", ...at, attemptIds: ["a1"] };
const MOVE: PlanDiff = { kind: "move", courseNumber: "89-230", ...at, to: "spring", attemptIds: ["a2"] };
const NOT_OFFERED: PlanDiff = { kind: "not-offered", courseNumber: "89-999", ...at, attemptIds: ["a3"] };

const A: FakeVariant = { name: "A", primary: true, picks: [], tray: ["89-210"] };
const B: FakeVariant = { name: "B", primary: false, picks: [], tray: ["89-110"] };

let fake: FakeApi | undefined;
let host: HTMLElement | undefined;
let root: Root | undefined;

/** The page's URL as a test found it: the screen keeps the open tab there (#325), and a tab one
 * test opened must not be the tab the next one opens on. */
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

/** The week, with these Plan Diffs served and the Plan's Fall Courses in the Tray. */
async function openWeek(
  planDiffs: FakePlanDiffs,
  options: { language?: Language; planned?: string[]; variants?: FakeVariant[] } = {},
): Promise<HTMLElement> {
  fake = installFakeApi({
    offerings: OFFERINGS,
    variants: options.variants ?? [A, B],
    planDiffs,
    planned: options.planned ?? ["89-110", "89-230", "89-999"],
  });
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(
    <TimetableScreen language={options.language ?? "en"} onLanguage={() => {}} today={TODAY} workspaceChanges={0} />,
  );
  await vi.waitFor(() => {
    if (mounted.querySelector(".tray-entry") === null) throw new Error("the Tray is not there yet");
  });
  return mounted;
}

const until = (check: () => void) => vi.waitFor(check);

const entry = (mounted: HTMLElement, courseNumber: string): HTMLElement =>
  mounted.querySelector<HTMLElement>(`.tray-entry[data-course="${courseNumber}"]`)!;

/** The badges on a Tray entry, as `kind: text`. */
const badges = (mounted: HTMLElement, courseNumber: string): string[] =>
  [...entry(mounted, courseNumber).querySelectorAll<HTMLElement>(".plan-diff-badge")].map(
    (badge) => `${badge.dataset.planDiff}: ${badge.textContent}`,
  );

const badge = (mounted: HTMLElement, courseNumber: string, kind: string): HTMLElement =>
  entry(mounted, courseNumber).querySelector<HTMLElement>(`.plan-diff-badge[data-plan-diff="${kind}"]`)!;

const panel = (mounted: HTMLElement): HTMLElement | null =>
  mounted.querySelector<HTMLElement>(`section[aria-label="${t("en", "planDiffsHeading")}"]`);

const panelEntries = (mounted: HTMLElement): string[] =>
  [...(panel(mounted)?.querySelectorAll<HTMLElement>("li") ?? [])].map((li) => li.dataset.planDiffEntry ?? "");

const applies = () => fake!.sent.filter((request) => request.pathname.endsWith("/plan-diffs/apply"));

it("puts each kind of badge on the Tray entry it is about, in the design's words", async () => {
  const mounted = await openWeek({ A: [DROP, MOVE, NOT_OFFERED, ADD] });

  await until(() => expect(badges(mounted, "89-210")).toEqual(["add: not in plan"]));
  expect(badges(mounted, "89-110")).toEqual(["drop: not scheduled"]);
  expect(badges(mounted, "89-230")).toEqual(["move: offered in Semester B"]);
  expect(badges(mounted, "89-999")).toEqual(["not-offered: not in this year's catalog"]);
});

it("makes an actionable badge a button named with its Course, and a not-offered one only a label", async () => {
  const mounted = await openWeek({ A: [ADD, NOT_OFFERED] });
  await until(() => expect(badges(mounted, "89-210")).toHaveLength(1));

  const add = badge(mounted, "89-210", "add");
  expect(add.tagName).toBe("BUTTON");
  expect(add.getAttribute("aria-label")).toBe("not in plan: Data Structures");
  expect(add.getAttribute("aria-expanded")).toBe("false");
  // reachable from the keyboard like any button
  add.focus();
  expect(document.activeElement).toBe(add);

  const notOffered = badge(mounted, "89-999", "not-offered");
  expect(notOffered.tagName).toBe("SPAN");
  expect(notOffered.getAttribute("aria-label")).toBe("not in this year's catalog: 89-999");
});

it("offers the apply when a badge is pressed, and applies only when that is pressed", async () => {
  const mounted = await openWeek({ A: [ADD, DROP] });
  await until(() => expect(badges(mounted, "89-210")).toHaveLength(1));

  badge(mounted, "89-210", "add").click();
  await until(() => expect(badge(mounted, "89-210", "add").getAttribute("aria-expanded")).toBe("true"));
  // pressing the badge asked for nothing: an apply is the student's explicit act (ADR-0008)
  expect(applies()).toEqual([]);

  const apply = entry(mounted, "89-210").querySelector<HTMLButtonElement>('button[data-plan-diff-apply="add"]')!;
  expect(apply.textContent).toBe("Add to plan");
  apply.click();

  await until(() => expect(applies()).toHaveLength(1));
  expect(applies()[0]).toMatchObject({
    method: "POST",
    pathname: "/api/timetable/2027/fall/plan-diffs/apply",
    body: { variant: "A", position: 0, kind: "add", courseNumber: "89-210", basedOn: "v0" },
  });
  // the screen follows the answer: the badge and the panel entry are gone, the other stays
  await until(() => expect(badges(mounted, "89-210")).toEqual([]));
  expect(panelEntries(mounted)).toEqual(["drop:89-110"]);
  expect(fake!.labels).toEqual(["apply-plan-diff-add"]);
});

it("lists every Plan Diff in the side panel, each actionable one with a one-click apply", async () => {
  const mounted = await openWeek({ A: [DROP, MOVE, NOT_OFFERED] });
  await until(() => expect(panelEntries(mounted)).toEqual(["drop:89-110", "move:89-230", "not-offered:89-999"]));

  const said = [...panel(mounted)!.querySelectorAll("li")].map((li) => li.querySelector("span")?.textContent);
  expect(said).toEqual([
    "Intro is planned for this semester but not scheduled in this variant.",
    "89-230 is planned for this semester, but this year's catalog offers it in Semester B.",
    "89-999 is planned for this semester, but is not in this year's catalog.",
  ]);
  const buttons = [...panel(mounted)!.querySelectorAll<HTMLButtonElement>("button[data-plan-diff-apply]")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Drop from plan", "Move to Semester B in plan"]);

  buttons[1]!.click();

  await until(() => expect(panelEntries(mounted)).toEqual(["drop:89-110", "not-offered:89-999"]));
  expect(applies()[0]?.body).toMatchObject({ kind: "move", courseNumber: "89-230" });
});

it("shows no badge and no Plan Diffs section without a Plan, and lays the screen out as before", async () => {
  const mounted = await openWeek({}, { planned: [] });
  await until(() => expect(entry(mounted, "89-210")).not.toBeNull());

  expect(mounted.querySelectorAll(".plan-diff-badge")).toHaveLength(0);
  expect(panel(mounted)).toBeNull();
  expect(mounted.querySelector(".grid")?.className).toContain("grid-cols-[18rem_minmax(0,1fr)]");
  expect(mounted.querySelector(".grid")?.className).not.toContain("16rem");
});

it("says a stale apply was refused because the Plan changed, and shows what is left", async () => {
  const mounted = await openWeek({ A: [ADD, DROP] });
  await until(() => expect(panelEntries(mounted)).toEqual(["add:89-210", "drop:89-110"]));
  // another tab, or a new Catalog, settled the drop since this page read it
  fake!.planDiffs.A = [ADD];

  panel(mounted)!.querySelector<HTMLButtonElement>('button[data-plan-diff-apply="drop"]')!.click();

  await until(() => expect(mounted.textContent).toContain(t("en", "planDiffStale")));
  await until(() => expect(panelEntries(mounted)).toEqual(["add:89-210"]));
  expect(fake!.labels).toEqual([]);
});

it("follows the Variant tab, so each alternative shows its own Plan Diffs", async () => {
  const mounted = await openWeek({ A: [ADD], B: [DROP] }, { planned: ["89-110"] });
  await until(() => expect(panelEntries(mounted)).toEqual(["add:89-210"]));

  mounted.querySelector<HTMLButtonElement>('[role="tab"][data-variant="B"]')!.click();

  await until(() => expect(panelEntries(mounted)).toEqual(["drop:89-110"]));
  expect(badges(mounted, "89-110")).toEqual(["drop: not scheduled"]);
});

it("translates the badges and the panel, right to left, in Hebrew", async () => {
  const mounted = await openWeek({ A: [MOVE] }, { language: "he" });
  await until(() => expect(badges(mounted, "89-230")).toHaveLength(1));

  expect(badges(mounted, "89-230")).toEqual([`move: ${t("he", "planDiffBadgeMove", { semester: t("he", "semesterSpring") })}`]);
  const section = mounted.querySelector<HTMLElement>(`section[aria-label="${t("he", "planDiffsHeading")}"]`);
  expect(section).not.toBeNull();
  // the panel sits on the end side, which is the left in Hebrew
  expect(section!.closest("aside")?.className).toContain("border-s");
});
