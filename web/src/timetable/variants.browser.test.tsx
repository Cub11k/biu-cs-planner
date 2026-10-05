/// <reference types="@vitest/browser-playwright" />
/**
 * The Variant tabs (#281): tabs drawn with the primary marked, switching redraws the week, and
 * create, duplicate, rename, delete and make-primary reach the API with the screen following its
 * answer.
 *
 * A browser, because what is under test is a click, an effect and a re-render. The API is the
 * fake in `./fakeTimetableApi.ts`, which keeps the revision guard the real server keeps.
 *
 * Fixture data is invented: 89-110 is a real BIU course number, the name and the times are not,
 * and no crawled data is committed to this repo (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../index.css";
import { t, type Language } from "../i18n/strings.ts";
import type { Offering } from "./catalog.ts";
import { installFakeApi, type FakeApi, type FakeVariant } from "./fakeTimetableApi.ts";
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
  ],
  exams: { known: false, sittings: [] },
};

const pickOf = (groupNumber: string): GroupPick => {
  const group = OFFERING.groups.find((candidate) => candidate.number === groupNumber)!;
  return {
    courseNumber: OFFERING.courseNumber,
    lessonType: group.lessonType,
    groupNumber: group.number,
    meetings: [...group.meetings],
  };
};

/** A holds lecture 01 and B holds lecture 02; B is the primary, so the screen opens on B. */
const twoVariants = (): FakeVariant[] => [
  { name: "A", primary: false, picks: [pickOf("01")], tray: [] },
  { name: "B", primary: true, picks: [pickOf("02")], tray: [] },
];

let fake: FakeApi;
let host: HTMLElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  fake = installFakeApi({ offerings: [OFFERING], variants: twoVariants() });
});

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
  await vi.waitFor(() => {
    if (tabs(mounted).length === 0) throw new Error("no Variant tab was drawn");
  });
  return mounted;
}

const tabs = (mounted: HTMLElement): HTMLButtonElement[] => [
  ...mounted.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
];

const tabNames = (mounted: HTMLElement): string[] =>
  tabs(mounted).map((tab) => tab.dataset.variant ?? "");

const selectedTab = (mounted: HTMLElement): string | undefined =>
  tabs(mounted).find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.variant;

const primaryTab = (mounted: HTMLElement): string | undefined =>
  tabs(mounted).find((tab) => tab.dataset.primary === "true")?.dataset.variant;

const tab = (mounted: HTMLElement, name: string): HTMLButtonElement => {
  const found = tabs(mounted).find((candidate) => candidate.dataset.variant === name);
  if (found === undefined) throw new Error(`no tab named ${name}`);
  return found;
};

const action = (mounted: HTMLElement, which: string): HTMLButtonElement => {
  const found = mounted.querySelector<HTMLButtonElement>(`button[data-variant-action="${which}"]`);
  if (found === null) throw new Error(`no ${which} control`);
  return found;
};

/** The groups drawn in ink on the week, by number. */
const inked = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll<HTMLElement>(".day-column .tile.is-picked")].map(
    (tile) => /· (\d\d)/.exec(tile.textContent ?? "")?.[1] ?? "",
  );

const until = (check: () => void) => vi.waitFor(check);

/** The naming field, once the form a click opened has rendered. */
const nameField = (mounted: HTMLElement): Promise<HTMLInputElement> =>
  vi.waitFor(() => {
    const found = mounted.querySelector<HTMLInputElement>("form input");
    if (found === null) throw new Error("the naming form did not open");
    return found;
  });

const saves = () => fake.sent.filter((request) => request.method !== "GET");

it("draws a tab per Variant, marks the primary, and opens on it", async () => {
  const mounted = await openWeek();

  expect(tabNames(mounted)).toEqual(["A", "B"]);
  expect(primaryTab(mounted)).toBe("B");
  expect(tab(mounted, "B").textContent).toContain(t("en", "variantPrimaryMark"));
  expect(tab(mounted, "A").textContent).not.toContain(t("en", "variantPrimaryMark"));
  await until(() => expect(selectedTab(mounted)).toBe("B"));
  expect(inked(mounted)).toEqual(["02"]);
});

it("redraws the week for the tab clicked, and asks for that Variant by name", async () => {
  const mounted = await openWeek();
  await until(() => expect(inked(mounted)).toEqual(["02"]));

  tab(mounted, "A").click();

  await until(() => expect(inked(mounted)).toEqual(["01"]));
  expect(selectedTab(mounted)).toBe("A");
  expect(fake.sent.some((request) => request.search === "?variant=A")).toBe(true);
  // showing a tab is view state, never a State File edit
  expect(saves()).toEqual([]);
});

it("picks into the Variant shown, naming it", async () => {
  const mounted = await openWeek();
  tab(mounted, "A").click();
  await until(() => expect(selectedTab(mounted)).toBe("A"));

  // a click on ink removes the Pick
  mounted.querySelector<HTMLElement>(".day-column .tile.is-picked")!.click();

  await until(() => expect(inked(mounted)).toEqual([]));
  expect(saves()[0]).toMatchObject({ method: "DELETE", body: { variant: "A" } });
  expect(fake.variants.find((v) => v.name === "B")?.picks).toHaveLength(1);
});

it("creates a Variant with the name typed, and shows it", async () => {
  const mounted = await openWeek();
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  action(mounted, "create").click();
  await userEvent.fill(await nameField(mounted), "Sunday off");
  action(mounted, "save").click();

  await until(() => expect(selectedTab(mounted)).toBe("Sunday off"));
  expect(tabNames(mounted)).toEqual(["A", "B", "Sunday off"]);
  expect(inked(mounted)).toEqual([]);
  expect(saves()[0]).toMatchObject({
    method: "POST",
    pathname: "/api/timetable/2027/fall/variants",
    body: { name: "Sunday off", basedOn: "v0" },
  });
});

it("creates a Variant named by the server when the name is left empty", async () => {
  const mounted = await openWeek();
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  action(mounted, "create").click();
  await nameField(mounted);
  action(mounted, "save").click();

  await until(() => expect(selectedTab(mounted)).toBe("C"));
  expect(saves()[0]?.body).toEqual({ basedOn: "v0" });
});

it("duplicates the Variant shown, Picks and all, and shows the copy", async () => {
  const mounted = await openWeek();
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  action(mounted, "duplicate").click();

  await until(() => expect(selectedTab(mounted)).toBe("C"));
  expect(tabNames(mounted)).toEqual(["A", "B", "C"]);
  expect(inked(mounted)).toEqual(["02"]);
  expect(saves()[0]).toMatchObject({ body: { variant: "B" } });
});

it("renames the Variant shown, starting from its name", async () => {
  const mounted = await openWeek();
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  action(mounted, "rename").click();
  const input = await nameField(mounted);
  expect(input.value).toBe("B");
  await userEvent.fill(input, "Mornings");
  action(mounted, "save").click();

  await until(() => expect(selectedTab(mounted)).toBe("Mornings"));
  expect(tabNames(mounted)).toEqual(["A", "Mornings"]);
  expect(saves()[0]).toMatchObject({ body: { variant: "B", name: "Mornings" } });
});

it("says, as a Warning, that a name is already used, and keeps the edit", async () => {
  const mounted = await openWeek();
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  action(mounted, "rename").click();
  await userEvent.fill(await nameField(mounted), "A");
  action(mounted, "save").click();

  await until(() =>
    expect(mounted.textContent).toContain(t("en", "variantNameNotUnique", { name: "A" })),
  );
  expect(tabNames(mounted)).toEqual(["A", "A"]);
});

it("marks the Variant shown as primary, and the mark moves", async () => {
  const mounted = await openWeek();
  tab(mounted, "A").click();
  await until(() => expect(selectedTab(mounted)).toBe("A"));

  action(mounted, "primary").click();

  await until(() => expect(primaryTab(mounted)).toBe("A"));
  expect(tabs(mounted).filter((candidate) => candidate.dataset.primary === "true")).toHaveLength(1);
  // the primary cannot be made primary again, so the control says so
  expect(action(mounted, "primary").disabled).toBe(true);
});

it("deletes the Variant shown, and lands on the primary that is left", async () => {
  const mounted = await openWeek();
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  action(mounted, "delete").click();

  await until(() => expect(tabNames(mounted)).toEqual(["A"]));
  expect(selectedTab(mounted)).toBe("A");
  expect(primaryTab(mounted)).toBe("A");
  expect(inked(mounted)).toEqual(["01"]);
  expect(saves()[0]).toMatchObject({ method: "DELETE", body: { variant: "B" } });
});

it("keeps the tab chosen when the Workspace changes and the week is read again", async () => {
  const mounted = await openWeek();
  tab(mounted, "A").click();
  await until(() => expect(selectedTab(mounted)).toBe("A"));

  render("en", 1);

  await until(() =>
    expect(fake.sent.filter((request) => request.search === "?variant=A").length).toBe(2),
  );
  expect(selectedTab(mounted)).toBe("A");
});

it("falls back to the primary when another window deleted the tab chosen", async () => {
  const mounted = await openWeek();
  tab(mounted, "A").click();
  await until(() => expect(selectedTab(mounted)).toBe("A"));

  fake.variants = fake.variants.filter((variant) => variant.name !== "A");
  render("en", 1);

  await until(() => expect(tabNames(mounted)).toEqual(["B"]));
  expect(selectedTab(mounted)).toBe("B");
  // and stops asking for the Variant that is gone
  render("en", 2);
  await until(() => expect(fake.sent.at(-1)?.search).toBe(""));
});

it("refuses a Variant edit made on a stale page, and says so", async () => {
  const mounted = await openWeek();
  await until(() => expect(selectedTab(mounted)).toBe("B"));
  fake.changeUnderneath = true;

  action(mounted, "duplicate").click();

  await until(() => expect(mounted.textContent).toContain(t("en", "picksStale")));
  expect(fake.variants.map((v) => v.name)).toEqual(["A", "B"]);
});

it("moves between tabs with the arrow keys and shows one with Enter", async () => {
  const mounted = await openWeek();
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  // one Tab stop for the row: the tab shown
  expect(tab(mounted, "B").tabIndex).toBe(0);
  expect(tab(mounted, "A").tabIndex).toBe(-1);

  tab(mounted, "B").focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(tab(mounted, "A"));
  await userEvent.keyboard("{Enter}");

  await until(() => expect(selectedTab(mounted)).toBe("A"));
});

it("reverses the arrows in Hebrew, where the next tab is to the left", async () => {
  const mounted = await openWeek("he");
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  tab(mounted, "A").focus();
  await userEvent.keyboard("{ArrowLeft}");

  expect(document.activeElement).toBe(tab(mounted, "B"));
});

it("draws the tabs right to left in Hebrew, with every word around the names translated", async () => {
  const mounted = await openWeek("he");
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  const [first, second] = tabs(mounted).map((candidate) => candidate.getBoundingClientRect());
  // the first Variant in file order is the start of the row, which is the right in Hebrew
  expect(first!.left).toBeGreaterThan(second!.left);
  expect(tab(mounted, "B").textContent).toContain(t("he", "variantPrimaryMark"));
  expect(action(mounted, "create").textContent).toBe(t("he", "variantNew"));
});

/**
 * #324: the tab pattern is complete — every tab names the week in `aria-controls`, and the week is
 * the `tabpanel`, labelled by the tab shown, which follows a switch.
 */
it("makes the week the tabpanel the tabs control, labelled by the tab shown", async () => {
  const mounted = await openWeek();
  await until(() => expect(selectedTab(mounted)).toBe("B"));

  const panel = mounted.querySelector<HTMLElement>('[role="tabpanel"]');
  expect(panel).not.toBeNull();
  expect(panel!.contains(mounted.querySelector(".day-column"))).toBe(true);
  for (const each of tabs(mounted)) expect(each.getAttribute("aria-controls")).toBe(panel!.id);
  expect(panel!.getAttribute("aria-labelledby")).toBe(tab(mounted, "B").id);

  tab(mounted, "A").click();

  await until(() => expect(panel!.getAttribute("aria-labelledby")).toBe(tab(mounted, "A").id));
  expect(tab(mounted, "A").id).not.toBe(tab(mounted, "B").id);
});
