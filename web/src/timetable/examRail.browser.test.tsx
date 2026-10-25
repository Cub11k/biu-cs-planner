/// <reference types="@vitest/browser-playwright" />
/**
 * The exam rail in the side pane (#419): one mark per sitting spaced by days, a spacing Warning and
 * an Exam Clash each said in words, unknown Exams admitted, the rail following a Pick, a Year-long
 * Course's sittings listed apart (#214), and an answer that carries no exam period never drawn as
 * an empty one (#184's ruling).
 *
 * The exam period is served by the fake as a test sets it: the check is `core`'s and tested there,
 * and this is what the screen does with its answer. Fixture data is invented (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../index.css";
import { t, type Language } from "../i18n/strings.ts";
import type { Offering } from "./catalog.ts";
import { installFakeApi, type FakeApi, type FakeExams } from "./fakeTimetableApi.ts";
import type { GroupPick } from "./picks.ts";
import { TimetableScreen } from "./TimetableScreen.tsx";

const TODAY = new Date(2026, 9, 15);

const offering = (courseNumber: string, nameEnglish: string, day: "sunday" | "tuesday"): Offering => ({
  courseNumber,
  nameHebrew: `קורס ${courseNumber}`,
  nameEnglish,
  credits: { known: true, total: 4 },
  semesters: ["fall"],
  groups: [
    { number: "01", lessonType: "הרצאה", lecturers: [], meetings: [{ semester: "fall", day, start: "10:00", end: "12:00" }] },
  ],
  exams: { known: true, sittings: [] },
});

const INTRO = offering("89-110", "Intro", "sunday");
const LOGIC = offering("89-112", "Logic", "tuesday");

const pickOf = (course: Offering): GroupPick => ({
  courseNumber: course.courseNumber,
  lessonType: course.groups[0]!.lessonType,
  groupNumber: "01",
  meetings: [...course.groups[0]!.meetings],
});

const sitting = (courseNumber: string, moed: string, date: string, daysSincePrevious: number | undefined) => ({
  courseNumber,
  moed,
  date,
  time: "09:00",
  daysSincePrevious,
  yearLong: false,
});

/** Intro's מועד א, Logic two days later, and Intro's מועד ב two weeks after that. */
const PERIOD: Exclude<FakeExams, "unreadable"> = {
  sittings: [
    sitting("89-110", "מועד א", "2027-01-21", undefined),
    sitting("89-112", "מועד א", "2027-01-23", 2),
    sitting("89-110", "מועד ב", "2027-02-06", 14),
  ],
  warnings: [
    {
      kind: "exam-spacing",
      sitting: { courseNumber: "89-110", moed: "מועד א", date: "2027-01-21", time: "09:00" },
      nearbyCount: 1,
      nearby: [{ courseNumber: "89-112", moed: "מועד א", date: "2027-01-23", time: "09:00" }],
    },
    {
      kind: "exam-spacing",
      sitting: { courseNumber: "89-112", moed: "מועד א", date: "2027-01-23", time: "09:00" },
      nearbyCount: 1,
      nearby: [{ courseNumber: "89-110", moed: "מועד א", date: "2027-01-21", time: "09:00" }],
    },
  ],
  coursesWithUnknownExams: 0,
};

let fake: FakeApi;
let host: HTMLElement | undefined;
let root: Root | undefined;
let startedAt: string;

const install = (exams: FakeExams | undefined, picks: GroupPick[] = [pickOf(INTRO), pickOf(LOGIC)]): void => {
  fake?.restore();
  fake = installFakeApi({
    offerings: [INTRO, LOGIC],
    variants: [{ name: "A", primary: true, picks, tray: [] }],
    ...(exams === undefined ? {} : { exams }),
  });
};

beforeEach(() => {
  startedAt = `${location.pathname}${location.search}${location.hash}`;
  history.replaceState(null, "", location.pathname);
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

const until = (check: () => void) => vi.waitFor(check);
const rail = (mounted: HTMLElement): HTMLElement | null => mounted.querySelector("[data-exam-rail]");
const marks = (mounted: HTMLElement): HTMLElement[] => [...mounted.querySelectorAll<HTMLElement>("[data-exam-rail] ol > li")];
const pad = (mark: HTMLElement): number => Number.parseFloat(getComputedStyle(mark).paddingBlockStart);

it("draws one mark per sitting, spaced by the days between them, with a later Moed lighter", async () => {
  install(PERIOD);
  const mounted = mount();

  await until(() => expect(marks(mounted)).toHaveLength(3));
  const [first, second, third] = marks(mounted) as [HTMLElement, HTMLElement, HTMLElement];
  expect(pad(first)).toBe(0);
  // fourteen days is seven times two: the distance is proportional to the gap
  expect(pad(third) / pad(second)).toBeCloseTo(7);
  expect(first.textContent).toContain("Intro, מועד א");
  expect(third.dataset.resit).toBe("true");
  expect(first.dataset.resit).toBe("false");
  expect(third.textContent).toContain(t("en", "examGap", { days: 14 }));
  // a list a screen reader reads in date order
  expect(rail(mounted)!.querySelector("ol")?.getAttribute("aria-label")).toBe(t("en", "examRailHeading"));
});

it("draws the gap the spacing Warning names in red, and says the Warning in words", async () => {
  install(PERIOD);
  const mounted = mount();

  await until(() => expect(marks(mounted)).toHaveLength(3));
  const [first, second, third] = marks(mounted) as [HTMLElement, HTMLElement, HTMLElement];
  expect([first.dataset.tight, second.dataset.tight, third.dataset.tight]).toEqual(["false", "true", "false"]);
  expect(getComputedStyle(second).borderInlineStartColor).not.toBe(getComputedStyle(third).borderInlineStartColor);
  expect(second.querySelector("[data-exam-spacing]")?.textContent).toBe(t("en", "examSpacingOne", { spacing: 3 }));
  expect(third.querySelector("[data-exam-spacing]")).toBeNull();
});

it("says an Exam Clash in words", async () => {
  install({
    sittings: [sitting("89-110", "מועד א", "2027-01-21", undefined), sitting("89-112", "מועד א", "2027-01-21", 0)],
    warnings: [
      {
        kind: "exam-clash",
        date: "2027-01-21",
        sittings: [
          { courseNumber: "89-110", moed: "מועד א", date: "2027-01-21", time: "09:00" },
          { courseNumber: "89-112", moed: "מועד א", date: "2027-01-21", time: "09:00" },
        ],
      },
    ],
    coursesWithUnknownExams: 0,
  });
  const mounted = mount();

  await until(() => expect(mounted.querySelector("[data-exam-clash]")).not.toBeNull());
  const date = new Date("2027-01-21T00:00:00Z").toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  expect(mounted.querySelector("[data-exam-clash]")!.textContent).toBe(
    t("en", "examClash", { date, first: "Intro", second: "Logic" }),
  );
});

it("admits in a sentence that picked Courses have no published Exams", async () => {
  install({ ...PERIOD, coursesWithUnknownExams: 2 });
  const mounted = mount();

  await until(() =>
    expect(mounted.querySelector("[data-exam-unknown]")?.textContent).toBe(t("en", "examUnknown", { count: 2 })),
  );
});

it("lists a Year-long Course's sittings apart, with no Semester recorded (#214)", async () => {
  install({
    sittings: [
      sitting("89-110", "מועד א", "2027-01-21", undefined),
      { ...sitting("89-112", "מועד א", "2027-06-30", undefined), yearLong: true },
    ],
    warnings: [],
    coursesWithUnknownExams: 0,
  });
  const mounted = mount();

  await until(() => expect(mounted.querySelector("[data-exam-year-long]")).not.toBeNull());
  const apart = mounted.querySelector<HTMLElement>("[data-exam-year-long]")!;
  expect(apart.textContent).toContain(t("en", "examYearLongHeading"));
  expect(apart.textContent).toContain("Logic, מועד א");
  // the Semester's rail holds only the Semester's sitting
  expect(marks(mounted)).toHaveLength(1);
});

it("follows a Pick without a reload", async () => {
  install(PERIOD);
  const mounted = mount();
  await until(() => expect(marks(mounted)).toHaveLength(3));

  // the server's exam period once Logic is no longer picked
  fake.exams = { sittings: [sitting("89-110", "מועד א", "2027-01-21", undefined)], warnings: [], coursesWithUnknownExams: 0 };
  // a click on Logic's ink removes its Pick
  const logic = [...mounted.querySelectorAll<HTMLElement>(".day-column .tile.is-picked")].find((tile) =>
    tile.textContent?.includes("Logic"),
  )!;
  logic.click();

  await until(() => expect(marks(mounted)).toHaveLength(1));
  expect(fake.labels).toEqual(["remove-pick"]);
});

it("never draws an exam period it could not read as an empty one (#184's ruling)", async () => {
  install("unreadable");
  const mounted = mount();

  await until(() => expect(mounted.querySelector("[data-exam-rail-unread]")).not.toBeNull());
  expect(rail(mounted)!.textContent).not.toContain(t("en", "examRailNone"));
  expect(marks(mounted)).toEqual([]);
});

it("draws no rail while nothing is picked, and leaves the side pane out", async () => {
  install(PERIOD, []);
  const mounted = mount();

  await until(() => expect(mounted.querySelector('[role="tab"][data-variant="A"]')).not.toBeNull());
  expect(rail(mounted)).toBeNull();
  // the Timetable's grid has no third column (the shell's own sidebar is an `aside` too)
  expect(mounted.querySelector('[class*="_16rem]"]')).toBeNull();
  expect(fake.sent.some((request) => request.pathname.endsWith("/exams"))).toBe(false);
});

it("says the rail in Hebrew, right to left", async () => {
  install(PERIOD);
  const mounted = mount("he");

  await until(() => expect(marks(mounted)).toHaveLength(3));
  expect(rail(mounted)!.querySelector("h2")?.textContent).toBe(t("he", "examRailHeading"));
  const second = marks(mounted)[1]!;
  expect(second.querySelector("[data-exam-spacing]")?.textContent).toBe(t("he", "examSpacingOne", { spacing: 3 }));
  expect(getComputedStyle(second).direction).toBe("rtl");
  // the rail line is on the start side, which is the right in Hebrew
  expect(getComputedStyle(second).borderRightWidth).toBe("2px");
});
