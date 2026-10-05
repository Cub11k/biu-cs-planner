/// <reference types="@vitest/browser-playwright" />
/**
 * Blocked Times on the Timetable screen (#282): drawn hatched with their label, a pencil option
 * overlapping one hatched, a Pick overlapping one in red pen and in the Clashes strip, the
 * editor's add, edit, remove and copy reaching the API, and Friday appearing.
 *
 * A browser, because hatching and a Day column are what a student sees. The API is the fake in
 * `./fakeTimetableApi.ts`, which keeps the revision guard and the wrap rule as far as a page can
 * see them.
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the times are not (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import "../index.css";
import { t, type Language } from "../i18n/strings.ts";
import type { Offering } from "./catalog.ts";
import {
  installFakeApi,
  type FakeApi,
  type FakeBlockedTime,
  type FakeVariant,
} from "./fakeTimetableApi.ts";
import { TimetableScreen } from "./TimetableScreen.tsx";

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

const WORK: FakeBlockedTime = {
  semester: "fall",
  day: "tuesday",
  start: "13:00",
  end: "17:00",
  label: "work",
};

let fake: FakeApi;
let host: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  fake.restore();
});

async function openWeek(
  setUp: { blockedTimes?: FakeBlockedTime[]; variants?: FakeVariant[] } = {},
  language: Language = "en",
): Promise<HTMLElement> {
  fake = installFakeApi({ offerings: [OFFERING], ...setUp });
  const mounted = document.createElement("div");
  host = mounted;
  document.body.append(mounted);
  root = createRoot(mounted);
  root.render(
    <TimetableScreen language={language} onLanguage={() => {}} today={TODAY} workspaceChanges={0} />,
  );
  await vi.waitFor(() => {
    if (mounted.querySelector('button[data-blocked-action="new"]:not([disabled])') === null) {
      throw new Error("the Blocked Time editor is not ready");
    }
  });
  return mounted;
}

const until = (check: () => void) => vi.waitFor(check);

const blocks = (mounted: HTMLElement): HTMLElement[] => [
  ...mounted.querySelectorAll<HTMLElement>(".blocked-block"),
];

const rows = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll<HTMLElement>(".blocked-row")].map((row) =>
    (row.querySelector("span")?.textContent ?? "").trim(),
  );

const dayHeads = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll<HTMLElement>(".week-head")].map((head) => head.textContent ?? "");

const tile = (mounted: HTMLElement, groupNumber: string): HTMLElement => {
  const found = [...mounted.querySelectorAll<HTMLElement>(".day-column .tile")].find((candidate) =>
    candidate.textContent?.includes(`89-110 · Lecture · ${groupNumber}`),
  );
  if (found === undefined) throw new Error(`no tile for ${groupNumber}`);
  return found;
};

const chooseCourse = async (mounted: HTMLElement): Promise<void> => {
  const chooser = await vi.waitFor(() => {
    const found = [...mounted.querySelectorAll("aside button")].find((button) =>
      button.textContent?.includes("89-110"),
    );
    if (found === undefined) throw new Error("no Course to choose");
    return found as HTMLButtonElement;
  });
  chooser.click();
  await until(() => tile(mounted, "01"));
};

const blockedAction = (mounted: HTMLElement, which: string, row?: number): HTMLButtonElement => {
  const scope = row === undefined ? mounted : mounted.querySelector(`[data-blocked-row="${row}"]`)!;
  return scope.querySelector<HTMLButtonElement>(`button[data-blocked-action="${which}"]`)!;
};

const field = (mounted: HTMLElement, label: string): Promise<HTMLInputElement | HTMLSelectElement> =>
  vi.waitFor(() => {
    const labelled = [...mounted.querySelectorAll("label")].find((l) => l.textContent === label);
    const found = labelled === undefined ? null : document.getElementById(labelled.htmlFor);
    if (found === null) throw new Error(`no field labelled ${label}`);
    return found as HTMLInputElement | HTMLSelectElement;
  });

it("draws each Blocked Time hatched on its Day, with its label", async () => {
  const mounted = await openWeek({ blockedTimes: [WORK] });

  await until(() => expect(blocks(mounted)).toHaveLength(1));
  const block = blocks(mounted)[0]!;
  expect(block.textContent).toContain("work");
  expect(block.textContent).toContain("13:00–17:00");
  expect(getComputedStyle(block).backgroundImage).toContain("repeating-linear-gradient");
  // in Tuesday's column, the third of the week
  const columns = [...mounted.querySelectorAll(".day-column")];
  expect(columns.findIndex((column) => column.contains(block))).toBe(2);
});

it("hatches a pencil option that overlaps a Blocked Time, and only that one", async () => {
  const mounted = await openWeek({ blockedTimes: [WORK] });
  await chooseCourse(mounted);

  await until(() => expect(tile(mounted, "01").classList.contains("is-hatched")).toBe(true));
  expect(tile(mounted, "02").classList.contains("is-hatched")).toBe(false);
  expect(getComputedStyle(tile(mounted, "01")).backgroundImage).toContain("repeating-linear-gradient");
});

it("draws a Pick over a Blocked Time in red pen and names the Blocked Time in the Clashes strip", async () => {
  const mounted = await openWeek({ blockedTimes: [WORK] });
  await chooseCourse(mounted);

  tile(mounted, "01").click();

  await until(() => expect(tile(mounted, "01").classList.contains("is-clashing")).toBe(true));
  // recorded all the same: a Clash is a Warning and never stops a Pick
  expect(tile(mounted, "01").classList.contains("is-picked")).toBe(true);
  expect(mounted.querySelector('[role="status"]')?.textContent).toContain(
    t("en", "clashWithBlocked", {
      group: "Introduction to Computer Science Lecture 01",
      label: "work",
    }),
  );
});

it("adds a Blocked Time from the form, and a night shift comes back as two rows", async () => {
  const mounted = await openWeek();
  expect(mounted.textContent).toContain(t("en", "blockedNone"));

  blockedAction(mounted, "new").click();
  await userEvent.selectOptions(await field(mounted, t("en", "blockedDay")), "monday");
  await userEvent.fill(await field(mounted, t("en", "blockedStart")), "23:00");
  await userEvent.fill(await field(mounted, t("en", "blockedEnd")), "01:00");
  await userEvent.fill(await field(mounted, t("en", "blockedLabel")), "shift");
  blockedAction(mounted, "save").click();

  await until(() => expect(rows(mounted)).toHaveLength(2));
  expect(fake.sent.find((request) => request.method === "POST")).toMatchObject({
    pathname: "/api/timetable/2027/fall/blocked-times",
    body: { day: "monday", start: "23:00", end: "01:00", label: "shift", basedOn: "v0" },
  });
  expect(rows(mounted)[0]).toContain("Monday");
  expect(rows(mounted)[1]).toContain("Tuesday");
});

it("edits a Blocked Time, starting from what it says, and sends its position", async () => {
  const mounted = await openWeek({ blockedTimes: [WORK, { ...WORK, day: "sunday", label: "gym" }] });
  await until(() => expect(rows(mounted)).toHaveLength(2));

  blockedAction(mounted, "edit", 1).click();
  const label = await field(mounted, t("en", "blockedLabel"));
  expect(label.value).toBe("gym");
  await userEvent.fill(label, "pool");
  blockedAction(mounted, "save").click();

  await until(() => expect(rows(mounted)[1]).toContain("pool"));
  expect(fake.sent.find((request) => request.method === "PUT")?.body).toMatchObject({
    index: 1,
    day: "sunday",
    label: "pool",
  });
});

it("removes a Blocked Time, and its hatching leaves the week", async () => {
  const mounted = await openWeek({ blockedTimes: [WORK] });
  await until(() => expect(blocks(mounted)).toHaveLength(1));

  blockedAction(mounted, "remove", 0).click();

  await until(() => expect(blocks(mounted)).toHaveLength(0));
  expect(fake.labels).toEqual(["remove-blocked-time"]);
});

it("copies every Blocked Time to the Semester chosen", async () => {
  const mounted = await openWeek({ blockedTimes: [WORK] });
  await until(() => expect(rows(mounted)).toHaveLength(1));

  await userEvent.selectOptions(await field(mounted, t("en", "blockedCopyTarget")), "summer");
  blockedAction(mounted, "copy").click();

  await until(() => expect(fake.copied.get("2027/summer")).toEqual([{ ...WORK, semester: "summer" }]));
});

it("shows Friday when time is blocked on Friday, though no Group meets then", async () => {
  const mounted = await openWeek({ blockedTimes: [{ ...WORK, day: "friday" }] });

  await until(() => expect(dayHeads(mounted)).toContain(t("en", "friday")));
});

it("keeps Blocked Times on screen whichever Variant is shown", async () => {
  const mounted = await openWeek({
    blockedTimes: [WORK],
    variants: [
      { name: "A", primary: true, picks: [], tray: [] },
      { name: "B", primary: false, picks: [], tray: [] },
    ],
  });
  await until(() => expect(blocks(mounted)).toHaveLength(1));

  mounted.querySelector<HTMLButtonElement>('[role="tab"][data-variant="B"]')!.click();

  await until(() =>
    expect(mounted.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-variant")).toBe("B"),
  );
  expect(blocks(mounted)).toHaveLength(1);
});

it("says a Blocked Time that keeps no time free does so, beside its row", async () => {
  const mounted = await openWeek({ blockedTimes: [{ ...WORK, end: "13:00" }] });

  await until(() => expect(rows(mounted)[0]).toContain(t("en", "blockedDoesNotAdvance")));
  // and draws no sliver for it
  expect(blocks(mounted)).toHaveLength(0);
});

it("explains hatching in the legend, in both languages", async () => {
  const mounted = await openWeek({}, "he");

  expect(mounted.querySelector(".legend-swatch.is-hatched")).not.toBeNull();
  expect(mounted.textContent).toContain(t("he", "legendHatched"));
  expect(mounted.textContent).toContain(t("he", "blockedHeading"));
});

it("names an unlabelled Blocked Time on the week as the editor does", async () => {
  const mounted = await openWeek({ blockedTimes: [{ ...WORK, label: "" }] });

  await until(() => expect(blocks(mounted)[0]?.textContent).toContain(t("en", "blockedUnlabelled")));
  expect(rows(mounted)[0]).toContain(t("en", "blockedUnlabelled"));
});

/**
 * #324: a refused save leaves the form open with what was typed, and says why beside it. The form
 * used to close as the request left, so a stale revision — the ordinary refusal — lost the input.
 * The second press goes out on the revision the re-read brought, lands, and closes the form.
 */
it("keeps the form open with its input when the save is refused, and closes it once one lands", async () => {
  const mounted = await openWeek();

  blockedAction(mounted, "new").click();
  await userEvent.fill(await field(mounted, t("en", "blockedLabel")), "night class");
  fake.changeUnderneath = true;
  blockedAction(mounted, "save").click();

  await until(() => {
    expect(mounted.querySelector("[data-blocked-not-saved]")?.textContent).toContain(
      t("en", "blockedNotSaved"),
    );
  });
  expect(mounted.querySelector("[data-blocked-not-saved]")?.textContent).toContain(t("en", "picksStale"));
  expect((await field(mounted, t("en", "blockedLabel"))).value).toBe("night class");
  expect(rows(mounted)).toHaveLength(0);

  // pressed at once: if the re-read the refusal asked for is still on its way, the save waits
  // for it and goes out on the revision it brings (#334)
  const before = fake.version;
  blockedAction(mounted, "save").click();

  await until(() => expect(rows(mounted)).toHaveLength(1));
  expect(fake.version).toBe(before + 1);
  expect(rows(mounted)[0]).toContain("night class");
  expect(mounted.querySelector("form.blocked-form")).toBeNull();
});
