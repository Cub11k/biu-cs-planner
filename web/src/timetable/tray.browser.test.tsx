/// <reference types="@vitest/browser-playwright" />
/**
 * The Tray (#283): a Course added from the Catalog, chips that fill when a Pick is made, an
 * incomplete mark that appears and clears, and a Course removed with its Picks.
 *
 * A browser, because what is under test is a click, an effect and a re-render. The API is the
 * fake in `./fakeTimetableApi.ts`, which keeps the revision guard the real server keeps and
 * derives the Tray as far as a page can see it.
 *
 * Fixture data is invented: 89-110 and 89-210 are real BIU course numbers, the names and times
 * are not, and no crawled data is committed to this repo (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../index.css";
import { t, type Language } from "../i18n/strings.ts";
import type { Offering } from "./catalog.ts";
import { installFakeApi, type FakeApi, type FakeVariant } from "./fakeTimetableApi.ts";
import { TimetableScreen } from "./TimetableScreen.tsx";

const TODAY = new Date(2026, 9, 15);

/** A lecture and a tirgul, so it is complete only once both are picked. */
const INTRO: Offering = {
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
      number: "03",
      lessonType: "תרגיל",
      lecturers: [],
      meetings: [{ semester: "fall", day: "wednesday", start: "10:00", end: "12:00" }],
    },
  ],
  exams: { known: false, sittings: [] },
};

const DATA: Offering = {
  courseNumber: "89-210",
  nameHebrew: "מבני נתונים",
  nameEnglish: "Data Structures",
  credits: { known: true, total: 5 },
  semesters: ["fall"],
  groups: [
    {
      number: "01",
      lessonType: "הרצאה",
      lecturers: [],
      meetings: [{ semester: "fall", day: "sunday", start: "10:00", end: "12:00" }],
    },
  ],
  exams: { known: false, sittings: [] },
};

let fake: FakeApi;
let host: HTMLElement | undefined;
let root: Root | undefined;

function setUp(variants: FakeVariant[] = []): void {
  fake = installFakeApi({ offerings: [INTRO, DATA], variants });
}

beforeEach(() => setUp());

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  fake.restore();
});

function render(language: Language, workspaceChanges: number): void {
  root!.render(
    <TimetableScreen
      language={language}
      onLanguage={() => {}}
      today={TODAY}
      workspaceChanges={workspaceChanges}
    />,
  );
}

async function openWeek(language: Language = "en"): Promise<HTMLElement> {
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  render(language, 0);
  // the Tray is drawn once the State File has been read, and the Add control once the Catalog is
  await vi.waitFor(() => {
    if (mounted.querySelector("button[data-tray-add]:not([disabled])") === null) {
      throw new Error("the Catalog and the Tray are not both there yet");
    }
  });
  return mounted;
}

const until = (check: () => void) => vi.waitFor(check);

const entry = (mounted: HTMLElement, courseNumber: string): HTMLElement | null =>
  mounted.querySelector<HTMLElement>(`.tray-entry[data-course="${courseNumber}"]`);

const trayCourses = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll<HTMLElement>(".tray-entry")].map((li) => li.dataset.course ?? "");

/** Each chip of a Tray entry, as "Lesson Type: Group" or "Lesson Type: —" while missing. */
const chips = (mounted: HTMLElement, courseNumber: string): string[] =>
  [...(entry(mounted, courseNumber)?.querySelectorAll<HTMLElement>(".tray-chip") ?? [])].map(
    (chip) => `${chip.dataset.lessonType}:${chip.classList.contains("is-filled") ? chip.textContent?.split(" ").at(-1) : "—"}`,
  );

const incomplete = (mounted: HTMLElement, courseNumber: string): boolean =>
  entry(mounted, courseNumber)?.querySelector(".tray-incomplete") !== null;

const tile = (mounted: HTMLElement, detail: string): HTMLElement => {
  const found = [...mounted.querySelectorAll<HTMLElement>(".day-column .tile")].find((candidate) =>
    candidate.textContent?.includes(detail),
  );
  if (found === undefined) throw new Error(`no tile reading "${detail}"`);
  return found;
};

const addButton = (mounted: HTMLElement, courseNumber: string): HTMLButtonElement =>
  mounted.querySelector<HTMLButtonElement>(`button[data-tray-add="${courseNumber}"]`)!;

it("says the Tray is empty, and adds a Course from the Catalog with every chip empty", async () => {
  const mounted = await openWeek();
  expect(mounted.textContent).toContain(t("en", "trayEmpty"));

  addButton(mounted, "89-110").click();

  await until(() => expect(trayCourses(mounted)).toEqual(["89-110"]));
  expect(fake.sent.find((request) => request.method === "POST")).toMatchObject({
    pathname: "/api/timetable/2027/fall/tray",
    body: { courseNumber: "89-110", basedOn: "v0" },
  });
  expect(chips(mounted, "89-110")).toEqual(["הרצאה:—", "תרגיל:—"]);
  expect(incomplete(mounted, "89-110")).toBe(true);
  expect(entry(mounted, "89-110")?.textContent).toContain("Introduction to Computer Science");
  // added is added: the control has nothing left to do for this Course
  expect(addButton(mounted, "89-110").disabled).toBe(true);
  // and the Course just added is the one whose Groups are on the week
  await until(() => tile(mounted, "89-110 · Lecture · 01"));
});

it("keeps a Course added when the week is read again", async () => {
  setUp([{ name: "A", primary: true, picks: [], tray: ["89-210"] }]);
  const mounted = await openWeek();
  await until(() => expect(trayCourses(mounted)).toEqual(["89-210"]));

  render("en", 1);

  await until(() =>
    expect(fake.sent.filter((request) => request.pathname === "/api/timetable/2027/fall").length).toBe(2),
  );
  expect(trayCourses(mounted)).toEqual(["89-210"]);
});

it("shows a Tray entry's Groups as pencil options when it is selected", async () => {
  setUp([{ name: "A", primary: true, picks: [], tray: ["89-210"] }]);
  const mounted = await openWeek();
  await until(() => expect(trayCourses(mounted)).toEqual(["89-210"]));

  entry(mounted, "89-210")!.querySelector("button")!.click();

  await until(() => {
    const option = tile(mounted, "89-210 · Lecture · 01");
    expect(option.classList.contains("is-picked")).toBe(false);
  });
  expect(entry(mounted, "89-210")!.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
});

it("fills a chip when its Lesson Type is picked, and clears the incomplete mark once all are", async () => {
  const mounted = await openWeek();
  addButton(mounted, "89-110").click();
  await until(() => tile(mounted, "89-110 · Lecture · 01"));

  tile(mounted, "89-110 · Lecture · 01").click();
  await until(() => expect(chips(mounted, "89-110")).toEqual(["הרצאה:01", "תרגיל:—"]));
  expect(incomplete(mounted, "89-110")).toBe(true);

  tile(mounted, "89-110 · Tirgul · 03").click();
  await until(() => expect(chips(mounted, "89-110")).toEqual(["הרצאה:01", "תרגיל:03"]));
  expect(incomplete(mounted, "89-110")).toBe(false);
  expect(entry(mounted, "89-110")?.dataset.complete).toBe("true");
});

it("puts a Course picked but never added in the Tray, because it is on the week", async () => {
  setUp([
    {
      name: "A",
      primary: true,
      tray: [],
      picks: [
        {
          courseNumber: "89-210",
          lessonType: "הרצאה",
          groupNumber: "01",
          meetings: [{ semester: "fall", day: "sunday", start: "10:00", end: "12:00" }],
        },
      ],
    },
  ]);
  const mounted = await openWeek();

  await until(() => expect(trayCourses(mounted)).toEqual(["89-210"]));
  expect(chips(mounted, "89-210")).toEqual(["הרצאה:01"]);
});

it("removes a Course with its Picks, and its Groups leave the week", async () => {
  setUp([
    {
      name: "A",
      primary: true,
      tray: ["89-110"],
      picks: [
        {
          courseNumber: "89-110",
          lessonType: "הרצאה",
          groupNumber: "01",
          meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
        },
      ],
    },
  ]);
  const mounted = await openWeek();
  await until(() => expect(tile(mounted, "89-110 · Lecture · 01").classList.contains("is-picked")).toBe(true));

  mounted.querySelector<HTMLButtonElement>('button[data-tray-remove="89-110"]')!.click();

  await until(() => expect(trayCourses(mounted)).toEqual([]));
  expect(mounted.querySelectorAll(".day-column .tile")).toHaveLength(0);
  expect(fake.sent.find((request) => request.method === "DELETE")).toMatchObject({
    pathname: "/api/timetable/2027/fall/tray",
    body: { courseNumber: "89-110" },
  });
  expect(fake.labels).toEqual(["remove-from-tray"]);
});

it("lists a Course this Semester's Catalog does not have, saying what is not known", async () => {
  setUp([{ name: "A", primary: true, picks: [], tray: ["89-999"] }]);
  const mounted = await openWeek();

  await until(() => expect(trayCourses(mounted)).toEqual(["89-999"]));
  expect(entry(mounted, "89-999")?.textContent).toContain(t("en", "trayChipsUnknown"));
  expect(entry(mounted, "89-999")?.dataset.complete).toBe("unknown");
  // no incomplete mark: what it needs is not known, so nothing is known to be missing
  expect(incomplete(mounted, "89-999")).toBe(false);
});

it("gives each Variant its own Tray", async () => {
  setUp([
    { name: "A", primary: true, picks: [], tray: ["89-110"] },
    { name: "B", primary: false, picks: [], tray: ["89-210"] },
  ]);
  const mounted = await openWeek();
  await until(() => expect(trayCourses(mounted)).toEqual(["89-110"]));

  mounted.querySelector<HTMLButtonElement>('[role="tab"][data-variant="B"]')!.click();

  await until(() => expect(trayCourses(mounted)).toEqual(["89-210"]));
});

it("draws the Tray in Hebrew, its chips named in Hebrew", async () => {
  setUp([{ name: "A", primary: true, picks: [], tray: ["89-110"] }]);
  const mounted = await openWeek("he");

  await until(() => expect(trayCourses(mounted)).toEqual(["89-110"]));
  expect(mounted.textContent).toContain(t("he", "trayHeading"));
  expect(entry(mounted, "89-110")?.textContent).toContain("מבוא למדעי המחשב");
  expect(entry(mounted, "89-110")?.textContent).toContain(t("he", "lessonTirgul"));
  expect(entry(mounted, "89-110")?.textContent).toContain(t("he", "trayIncomplete"));
});
