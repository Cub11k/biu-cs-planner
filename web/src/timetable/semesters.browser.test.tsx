/// <reference types="@vitest/browser-playwright" />
/**
 * The Semester tabs and the year control (#418): another Semester's week, Tray, Blocked Times,
 * Variants and Plan Diffs; the Academic Year and Semester kept in the URL with the Variant, which is
 * honoured only for the Semester it was stored with (#345's item 3); today's Semester when the URL
 * names none; and an edit in flight while the tab changes kept to the Semester it was made on.
 *
 * A browser, because what is under test is a click, a remount and a re-read. The API is the fake in
 * `./fakeTimetableApi.ts`, which holds a Timetable per Semester. Fixture data is invented: the
 * course numbers are BIU-shaped, the names and times are not (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../index.css";
import { t, type Language } from "../i18n/strings.ts";
import type { Offering } from "./catalog.ts";
import { installFakeApi, type FakeApi } from "./fakeTimetableApi.ts";
import type { GroupPick, PlanDiff } from "./picks.ts";
import { TimetableScreen } from "./TimetableScreen.tsx";

/** October 2026: the Fall Semester of Academic Year 2027. */
const TODAY = new Date(2026, 9, 15);

const offering = (courseNumber: string, nameEnglish: string, semester: "fall" | "spring"): Offering => ({
  courseNumber,
  nameHebrew: nameEnglish,
  nameEnglish,
  credits: { known: true, total: 4 },
  semesters: [semester],
  groups: [
    {
      number: "01",
      lessonType: "הרצאה",
      lecturers: [],
      meetings: [{ semester, day: semester === "fall" ? "tuesday" : "thursday", start: "10:00", end: "12:00" }],
    },
  ],
  exams: { known: false, sittings: [] },
});

const FALL_COURSE = offering("89-110", "Fall Course", "fall");
const SPRING_COURSE = offering("89-120", "Spring Course", "spring");

const pickOf = (course: Offering): GroupPick => ({
  courseNumber: course.courseNumber,
  lessonType: course.groups[0]!.lessonType,
  groupNumber: course.groups[0]!.number,
  meetings: [...course.groups[0]!.meetings],
});

const SPRING_DIFF: PlanDiff = {
  kind: "add",
  courseNumber: "89-120",
  academicYear: 2027,
  semester: "spring",
  semesters: ["spring"],
};

let fake: FakeApi;
let host: HTMLElement | undefined;
let root: Root | undefined;
/** The URL as the test started: the Semester shown is kept in it, and must not leak to the next test. */
let startedAt: string;

beforeEach(() => {
  startedAt = `${location.pathname}${location.search}${location.hash}`;
  history.replaceState(null, "", location.pathname);
  fake = installFakeApi({
    offerings: [FALL_COURSE],
    variants: [
      { name: "A", primary: true, picks: [pickOf(FALL_COURSE)], tray: [] },
      { name: "B", primary: false, picks: [], tray: [] },
    ],
    blockedTimes: [{ semester: "fall", day: "monday", start: "08:00", end: "10:00", label: "Fall job" }],
    semesters: {
      "2027/spring": {
        // "B" again, and not the primary: a Variant of Fall's name is not Fall's Variant
        variants: [
          { name: "B", primary: false, picks: [], tray: [] },
          { name: "Spring plan", primary: true, picks: [pickOf(SPRING_COURSE)], tray: [] },
        ],
        blockedTimes: [{ semester: "spring", day: "wednesday", start: "18:00", end: "20:00", label: "Spring job" }],
        planDiffs: { "Spring plan": [SPRING_DIFF] },
      },
    },
    catalogs: { "2027/spring": [SPRING_COURSE], "2028/fall": null },
  });
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  fake.restore();
  history.replaceState(null, "", startedAt);
});

function mount(language: Language = "en"): HTMLElement {
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(<TimetableScreen language={language} onLanguage={() => {}} today={TODAY} workspaceChanges={0} />);
  return mounted;
}

/** A remount against the same fake server, with nothing surviving but the URL. */
function reload(): void {
  root?.unmount();
  root = createRoot(host!);
  root.render(<TimetableScreen language="en" onLanguage={() => {}} today={TODAY} workspaceChanges={0} />);
}

const until = (check: () => void) => vi.waitFor(check);

const semesterTab = (mounted: HTMLElement, semester: string): HTMLButtonElement =>
  mounted.querySelector<HTMLButtonElement>(`[role="tab"][data-semester="${semester}"]`)!;
const selectedSemester = (mounted: HTMLElement): string | undefined =>
  mounted.querySelector<HTMLElement>('[role="tab"][data-semester][aria-selected="true"]')?.dataset.semester;
const selectedVariant = (mounted: HTMLElement): string | undefined =>
  mounted.querySelector<HTMLElement>('[role="tab"][data-variant][aria-selected="true"]')?.dataset.variant;
const variantNames = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll<HTMLElement>('[role="tab"][data-variant]')].map((tab) => tab.dataset.variant ?? "");
const yearShown = (mounted: HTMLElement): string | null | undefined =>
  mounted.querySelector("[data-year-shown]")?.textContent;
const trayCourses = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll<HTMLElement>(".tray-entry")].map((entry) => entry.dataset.course ?? "");
const blockedLabels = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll<HTMLElement>("[data-blocked-row]")].map((row) => row.textContent ?? "");
const inkedDays = (mounted: HTMLElement): number => mounted.querySelectorAll(".day-column .tile.is-picked").length;
const reads = (path: string) => fake.sent.filter((request) => request.method === "GET" && request.pathname === path);
const url = (): URLSearchParams => new URLSearchParams(location.search);

it("opens on today's Semester and Academic Year when the URL names none", async () => {
  const mounted = mount();

  await until(() => expect(selectedVariant(mounted)).toBe("A"));
  expect(selectedSemester(mounted)).toBe("fall");
  expect(yearShown(mounted)).toBe(t("en", "academicYear", { first: "2026", second: "27" }));
  expect(reads("/api/timetable/2027/fall").length).toBeGreaterThan(0);
  expect(fake.sent.some((request) => request.pathname.includes("/spring"))).toBe(false);
});

it("shows another Semester's week, Tray, Blocked Times, Variants and Plan Diffs, opening on its primary", async () => {
  const mounted = mount();
  await until(() => expect(selectedVariant(mounted)).toBe("A"));
  // a non-primary tab in Fall, which must not carry over
  mounted.querySelector<HTMLButtonElement>('[role="tab"][data-variant="B"]')!.click();
  await until(() => expect(selectedVariant(mounted)).toBe("B"));
  expect(blockedLabels(mounted).join()).toContain("Fall job");

  semesterTab(mounted, "spring").click();

  await until(() => expect(selectedVariant(mounted)).toBe("Spring plan"));
  expect(selectedSemester(mounted)).toBe("spring");
  expect(variantNames(mounted)).toEqual(["B", "Spring plan"]);
  expect(trayCourses(mounted)).toEqual(["89-120"]);
  expect(inkedDays(mounted)).toBe(1);
  expect(blockedLabels(mounted).join()).toContain("Spring job");
  expect(blockedLabels(mounted).join()).not.toContain("Fall job");
  expect(mounted.querySelector('[data-plan-diff-entry="add:89-120"]')).not.toBeNull();
  // the Catalog and the Timetable were both asked for Spring, and the week for its primary
  expect(fake.sent.some((r) => r.pathname === "/api/catalog/2027/offerings" && r.search === "?semester=spring")).toBe(true);
  expect(reads("/api/timetable/2027/spring").at(0)?.search).toBe("");
});

it("steps the Academic Year, and says a year with no Catalog has none", async () => {
  const mounted = mount();
  await until(() => expect(selectedVariant(mounted)).toBe("A"));

  mounted.querySelector<HTMLButtonElement>('[data-year-step="next"]')!.click();
  // in the URL at once, before anything about that year is read, and with no Variant of the last one
  expect([url().get("year"), url().get("semester"), url().get("variant")]).toEqual(["2028", "fall", null]);

  const next = t("en", "academicYear", { first: "2027", second: "28" });
  await until(() => expect(yearShown(mounted)).toBe(next));
  await until(() => expect(mounted.textContent).toContain(t("en", "catalogMissing", { year: next })));
  expect(selectedSemester(mounted)).toBe("fall");
  expect(reads("/api/timetable/2028/fall").length).toBeGreaterThan(0);

  mounted.querySelector<HTMLButtonElement>('[data-year-step="previous"]')!.click();
  await until(() => expect(yearShown(mounted)).toBe(t("en", "academicYear", { first: "2026", second: "27" })));
});

it("keeps the Academic Year, the Semester and the Variant across a reload", async () => {
  const mounted = mount();
  await until(() => expect(selectedVariant(mounted)).toBe("A"));
  semesterTab(mounted, "spring").click();
  await until(() => expect(selectedVariant(mounted)).toBe("Spring plan"));
  mounted.querySelector<HTMLButtonElement>('[role="tab"][data-variant="B"]')!.click();
  await until(() => expect(url().get("variant")).toBe("B"));
  expect([url().get("year"), url().get("semester")]).toEqual(["2027", "spring"]);

  const before = fake.sent.length;

  reload();

  await until(() => expect(selectedVariant(mounted)).toBe("B"));
  expect(selectedSemester(mounted)).toBe("spring");
  // the first read after the reload asked for Spring's B, not for Fall and then switching
  const after = fake.sent.slice(before).filter((r) => r.method === "GET" && r.pathname.startsWith("/api/timetable"));
  expect(after.some((r) => r.pathname.includes("/fall"))).toBe(false);
  expect(after[0]).toMatchObject({ pathname: "/api/timetable/2027/spring", search: "?variant=B&position=0" });
});

it("ignores a Variant the URL stored with another Semester", async () => {
  // Fall's B, as a reload of the Fall page would have kept it
  history.replaceState(null, "", `${location.pathname}?year=2027&semester=fall&variant=B&position=1`);
  const mounted = mount();
  await until(() => expect(selectedVariant(mounted)).toBe("B"));

  semesterTab(mounted, "spring").click();

  // Spring has a B too, and it is not the one the URL meant: Spring opens on its primary
  await until(() => expect(selectedVariant(mounted)).toBe("Spring plan"));
  expect(reads("/api/timetable/2027/spring").every((r) => r.search === "")).toBe(true);
});

/**
 * #418's criterion 4: a click in flight while the tab changes. The save is held at the server, the
 * student shows Spring, and then the save answers. It was sent for Fall, the Semester it was made on,
 * and its answer — Fall's week — never reaches the Spring week on screen.
 */
it("keeps an edit in flight to the Semester it was made on when the tab changes", async () => {
  const mounted = mount();
  await until(() => expect(selectedVariant(mounted)).toBe("A"));
  let release: () => void = () => {};
  fake.saveGate = new Promise((resolve) => {
    release = resolve;
  });

  // a click on ink removes Fall's Pick, and its save waits at the server
  mounted.querySelector<HTMLElement>(".day-column .tile.is-picked")!.click();
  await until(() => expect(fake.sent.some((r) => r.method === "DELETE")).toBe(true));
  semesterTab(mounted, "spring").click();
  await until(() => expect(selectedVariant(mounted)).toBe("Spring plan"));
  release();

  await until(() => expect(fake.labels).toEqual(["remove-pick"]));
  const saves = fake.sent.filter((r) => r.method !== "GET");
  expect(saves.map((r) => r.pathname)).toEqual(["/api/timetable/2027/fall/picks"]);
  expect(fake.variants.find((v) => v.name === "A")?.picks).toEqual([]);
  // Spring's own week is still the one drawn, with its Pick in ink
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(selectedSemester(mounted)).toBe("spring");
  expect(selectedVariant(mounted)).toBe("Spring plan");
  expect(trayCourses(mounted)).toEqual(["89-120"]);
  expect(inkedDays(mounted)).toBe(1);
});

it("draws the tabs in Hebrew, right to left, with the arrows following the reading direction", async () => {
  const mounted = mount("he");
  await until(() => expect(selectedVariant(mounted)).toBe("A"));

  const list = mounted.querySelector<HTMLElement>('[role="tablist"][aria-label]')!;
  expect(list.getAttribute("aria-label")).toBe(t("he", "semesterTabs"));
  expect(semesterTab(mounted, "fall").textContent).toBe(t("he", "semesterFall"));
  expect(getComputedStyle(list).direction).toBe("rtl");
  const fall = semesterTab(mounted, "fall").getBoundingClientRect();
  const spring = semesterTab(mounted, "spring").getBoundingClientRect();
  expect(spring.right).toBeLessThanOrEqual(fall.left);
  expect(mounted.querySelector('[data-year-step="next"]')?.getAttribute("aria-label")).toBe(t("he", "yearNext"));

  // in Hebrew the next tab is to the left
  semesterTab(mounted, "fall").focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(semesterTab(mounted, "spring"));
  await userEvent.keyboard("{Enter}");
  await until(() => expect(selectedSemester(mounted)).toBe("spring"));
});

it("labels everything under the tabs as the panel of the Semester shown", async () => {
  const mounted = mount();
  await until(() => expect(selectedVariant(mounted)).toBe("A"));

  const panel = mounted.querySelector<HTMLElement>('[role="tabpanel"]')!;
  expect(panel.contains(mounted.querySelector(".day-column"))).toBe(true);
  expect(semesterTab(mounted, "spring").getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("aria-labelledby")).toBe(semesterTab(mounted, "fall").id);
});
