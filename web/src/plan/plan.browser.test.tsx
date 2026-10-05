/// <reference types="@vitest/browser-playwright" />
/**
 * The Plan screen as a student meets it (#292): columns from the Cohort grouped by Academic Year,
 * Summer collapsed and opened, cards with their Course's number, name, credits, status and grade,
 * a drag and the keyboard's move, add, status, grade, retake and remove, Warnings on the card and
 * the column they point at, credit totals, right-to-left order — and New Plan from Suggested Layout
 * (#293), with its summary and what it needs. A browser, because what is under test is a drag, a
 * click, a request and a re-render.
 *
 * The API is a fake `fetch` that keeps the Attempts it was sent and answers every edit with the Plan
 * afterwards, the way `server/src/api.ts` does. Its Warnings are whatever a test arranges: the real
 * checks are `core`'s and tested there, so these tests are about what the screen does with an
 * answer. Course numbers, names and the Cohort are invented (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../index.css";
import { AppShell } from "../AppShell.tsx";
import { t, type Language } from "../i18n/strings.ts";
import { PLAN_SCREEN } from "./PlanScreen.tsx";

const ROOT = document.documentElement;
const realFetch = globalThis.fetch;
let host: HTMLElement | undefined;
let root: Root | undefined;

type FakeAttempt = {
  id: string;
  courseNumber: string;
  academicYear: number;
  semester: string;
  status: string;
  grade?: unknown;
};

let sent: Array<{ method: string; pathname: string; body: Record<string, unknown> | undefined }>;
let attempts: FakeAttempt[];
let cohort: { academicYear: number; semester: string } | null;
let attemptWarnings: unknown[];
let planWarnings: unknown[];
let version: number;
let nextId: number;
let refuseNextEdit: string | undefined;
/** What New Plan from Suggested Layout answers: Attempts it creates, or a reason it cannot. */
let layout: { create: FakeAttempt[]; skipped: unknown[] } | { unavailable: string };
let canUndo: boolean;

const COURSES = [
  { courseNumber: "89-110", name: { he: "מבוא למדעי המחשב", en: "Introduction to CS" }, credits: 6 },
  { courseNumber: "89-111", name: { he: "מבני נתונים", en: "Data Structures" }, credits: 5 },
  { courseNumber: "89-220", name: { he: "אלגוריתמים" } },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const planBody = (extra: object = {}) => ({
  attempts,
  attemptWarnings,
  planWarnings,
  version: `v${version}`,
  warnings: [],
  ...extra,
});

beforeEach(() => {
  sent = [];
  attempts = [
    { id: "a1", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "passed", grade: { kind: "numeric", value: 91 } },
    { id: "a2", courseNumber: "89-111", academicYear: 2027, semester: "spring", status: "planned" },
  ];
  cohort = { academicYear: 2027, semester: "fall" };
  attemptWarnings = [];
  planWarnings = [];
  version = 1;
  nextId = 1;
  refuseNextEdit = undefined;
  layout = { create: [], skipped: [] };
  canUndo = false;
  ROOT.lang = "en";
  ROOT.dir = "ltr";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    const text = input instanceof Request ? await input.clone().text() : init?.body;
    const body = typeof text === "string" && text !== "" ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    sent.push({ method, pathname, body });

    if (pathname === "/api/history") return json({ canUndo, canRedo: false });
    if (pathname === "/api/history/undo") {
      canUndo = false;
      attempts = attempts.slice(0, -1);
      version += 1;
      return json({ label: "add-attempt", at: 1, version: `v${version}`, canUndo: false, canRedo: true, warnings: [] });
    }
    if (pathname === "/api/programs") return json({ cohort, programs: [], programWarnings: [], version: `v${version}`, warnings: [] });
    if (pathname === "/api/courses") return json({ courses: COURSES });
    if (pathname === "/api/plan" && method === "GET") return json(planBody());
    if (method !== "GET" && refuseNextEdit !== undefined) {
      const reason = refuseNextEdit;
      refuseNextEdit = undefined;
      version += 1; // somebody else wrote the file
      return json({ reason, warnings: [] }, 409);
    }
    if (pathname === "/api/plan/attempts" && method === "POST") {
      const { basedOn: _, ...fields } = body!;
      const id = `n${nextId++}`;
      attempts = [...attempts, { id, ...(fields as Omit<FakeAttempt, "id">) }];
      version += 1;
      return json(planBody({ added: id }));
    }
    if (pathname === "/api/plan/suggested-layout") {
      if ("unavailable" in layout) return json({ reason: layout.unavailable, version: `v${version}` }, 409);
      attempts = [...attempts, ...layout.create];
      version += 1;
      return json(
        planBody({
          summary: {
            created: layout.create.map(({ id, courseNumber, academicYear, semester }) => ({ id, courseNumber, academicYear, semester })),
            skipped: layout.skipped,
          },
        }),
      );
    }
    const named = /^\/api\/plan\/attempts\/([^/]+)(\/semester)?$/.exec(pathname);
    if (named !== null) {
      const id = decodeURIComponent(named[1]!);
      const { basedOn: _, ...change } = body!;
      if (method === "DELETE") attempts = attempts.filter((attempt) => attempt.id !== id);
      else {
        attempts = attempts.map((attempt) => {
          if (attempt.id !== id) return attempt;
          const next = { ...attempt, ...change } as FakeAttempt & { grade?: unknown };
          if (change.grade === null) delete next.grade;
          return next;
        });
      }
      version += 1;
      return json(planBody());
    }
    throw new Error(`the fake was not arranged for ${method} ${pathname}`);
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  ROOT.lang = "en";
  ROOT.dir = "ltr";
  globalThis.fetch = realFetch;
});

/** Opened on a day in the Academic Year 2027 Fall, so the add form starts at a column shown. */
const TODAY = new Date(2026, 9, 5);

async function mount(language: Language = "en", workspaceChanges = 0): Promise<HTMLElement> {
  if (host === undefined) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  root!.render(
    <AppShell
      screens={[PLAN_SCREEN]}
      language={language}
      onLanguage={() => {}}
      workspaceChanges={workspaceChanges}
      today={TODAY}
    />,
  );
  return host;
}

const card = (mounted: HTMLElement, id: string): HTMLElement | null =>
  mounted.querySelector<HTMLElement>(`article[data-attempt="${id}"]`);

const column = (mounted: HTMLElement, key: string): HTMLElement | null =>
  mounted.querySelector<HTMLElement>(`section[data-semester="${key}"]`);

/** Waits for the Plan to be drawn with its Course names, which arrive on their own read. */
async function served(mounted: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    if (card(mounted, "a1")?.querySelector("[data-course-name]") == null) throw new Error("the Plan was not drawn");
  });
}

const status = (mounted: HTMLElement): string => mounted.querySelector('[role="status"]')?.textContent ?? "";

const lastSent = (method: string, pathname: string) =>
  [...sent].reverse().find((request) => request.method === method && request.pathname === pathname);

/** Chooses an option of a `<select>` the way a student does, firing React's change. */
function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Types into an input the way React hears it, through the native value setter. */
function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("starts the columns at the Cohort, a column per Semester grouped by Academic Year", async () => {
  cohort = { academicYear: 2027, semester: "spring" };
  attempts = [{ id: "a1", courseNumber: "89-110", academicYear: 2027, semester: "spring", status: "planned" }];
  const mounted = await mount();
  await served(mounted);

  const years = [...mounted.querySelectorAll<HTMLElement>("section[data-year]")].map((year) => year.dataset.year);
  // a Spring Cohort's third study year ends in the Fall after it
  expect(years).toEqual(["2027", "2028", "2029", "2030"]);
  const first = mounted.querySelector<HTMLElement>('section[data-year="2027"]')!;
  expect(first.getAttribute("aria-label")).toBe(t("en", "academicYear", { first: "2026", second: "27" }));
  // nothing before the Cohort: its Academic Year starts at its Spring
  expect(column(mounted, "2027-fall")).toBeNull();
  expect(column(mounted, "2027-spring")).not.toBeNull();
  expect(column(mounted, "2028-fall")!.getAttribute("aria-label")).toBe(
    t("en", "planSemesterSaid", {
      semester: t("en", "semesterFall"),
      year: t("en", "academicYear", { first: "2027", second: "28" }),
    }),
  );
});

it("collapses an empty Summer, opens one that holds an Attempt, and opens and closes on request", async () => {
  attempts = [
    ...attempts,
    { id: "s1", courseNumber: "89-220", academicYear: 2028, semester: "summer", status: "planned" },
  ];
  const mounted = await mount();
  await served(mounted);

  // an empty Summer is a toggle and no column; one holding an Attempt is open and stays so
  expect(column(mounted, "2027-summer")).toBeNull();
  expect(card(column(mounted, "2028-summer")!, "s1")).not.toBeNull();
  expect(column(mounted, "2028-summer")!.querySelector("[data-summer-toggle]")).toBeNull();

  mounted.querySelector<HTMLButtonElement>('button[data-summer-toggle="2027"]')!.click();
  const opened = await vi.waitFor(() => {
    const found = column(mounted, "2027-summer");
    if (found === null) throw new Error("the Summer did not open");
    return found;
  });
  expect(sent.some((request) => request.method !== "GET")).toBe(false);

  opened.querySelector<HTMLButtonElement>("[data-summer-toggle]")!.click();
  await vi.waitFor(() => {
    if (column(mounted, "2027-summer") !== null) throw new Error("the Summer did not close");
  });
});

it("draws each card with its Course's number, name, credits, status and grade", async () => {
  attempts = [
    ...attempts,
    { id: "a3", courseNumber: "89-220", academicYear: 2028, semester: "fall", status: "exempt" },
    { id: "a4", courseNumber: "10-001", academicYear: 2028, semester: "fall", status: "failed", grade: { kind: "pass-fail", passed: false } },
  ];
  const mounted = await mount();
  await served(mounted);

  const passed = card(column(mounted, "2027-fall")!, "a1")!;
  expect(passed.dataset.status).toBe("passed");
  expect(passed.textContent).toContain("89-110");
  expect(passed.textContent).toContain("Introduction to CS");
  expect(passed.querySelector("[data-card-credits]")!.textContent).toBe(t("en", "planCardCredits", { credits: 6 }));
  expect(passed.querySelector("[data-status-badge]")!.textContent).toBe(t("en", "planStatusPassed"));
  expect(passed.querySelector("[data-card-grade]")!.textContent).toBe("91");

  // a Course with no English name is named in Hebrew; one no file knows is its number alone
  expect(card(mounted, "a3")!.textContent).toContain("אלגוריתמים");
  expect(card(mounted, "a3")!.querySelector("[data-card-credits]")!.textContent).toBe(t("en", "planCardNoCredits"));
  expect(card(mounted, "a4")!.querySelector("[data-course-name]")).toBeNull();
  expect(card(mounted, "a4")!.querySelector("[data-card-grade]")!.textContent).toBe(t("en", "planGradeFail"));

  // each status reads apart, in a hue of its own drawn from the tokens
  const stripe = (id: string) => getComputedStyle(card(mounted, id)!).borderInlineStartColor;
  expect(new Set(["a1", "a2", "a3", "a4"].map(stripe)).size).toBe(4);
});

it("moves a card dragged to another column, and draws the Plan the server answers with", async () => {
  const mounted = await mount();
  await served(mounted);
  const dragged = card(mounted, "a2")!;
  const target = column(mounted, "2028-fall")!;
  const transfer = new DataTransfer();

  dragged.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
  target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));

  await vi.waitFor(() => {
    if (card(column(mounted, "2028-fall")!, "a2") === null) throw new Error("the card did not move");
  });
  expect(lastSent("PUT", "/api/plan/attempts/a2/semester")?.body).toEqual({
    academicYear: 2028,
    semester: "fall",
    basedOn: "v1",
  });
  expect(card(column(mounted, "2027-spring")!, "a2")).toBeNull();
});

it("moves a card from the keyboard, by its own Move to, through the same route", async () => {
  const mounted = await mount();
  await served(mounted);
  const select = card(mounted, "a2")!.querySelector<HTMLSelectElement>("select[data-attempt-move]")!;
  expect(select.value).toBe("2027-spring");

  select.focus();
  choose(select, "2029-spring");

  await vi.waitFor(() => {
    if (card(column(mounted, "2029-spring")!, "a2") === null) throw new Error("the card did not move");
  });
  expect(lastSent("PUT", "/api/plan/attempts/a2/semester")?.body).toEqual({
    academicYear: 2029,
    semester: "spring",
    basedOn: "v1",
  });
});

it("adds a Course to a Semester by its name, as a planned Attempt", async () => {
  const mounted = await mount();
  await served(mounted);
  const form = mounted.querySelector<HTMLFormElement>("form[data-plan-add]")!;

  type(form.querySelector<HTMLInputElement>("input[data-plan-add-course]")!, "data structures");
  choose(form.querySelector<HTMLSelectElement>("select[data-plan-add-semester]")!, "2028-spring");
  await vi.waitFor(() => {
    if (form.querySelector<HTMLButtonElement>("button[data-plan-add-submit]")!.disabled) throw new Error("not offered");
  });
  form.querySelector<HTMLButtonElement>("button[data-plan-add-submit]")!.click();

  await vi.waitFor(() => {
    if (card(column(mounted, "2028-spring")!, "n1") === null) throw new Error("the card was not added");
  });
  expect(lastSent("POST", "/api/plan/attempts")?.body).toEqual({
    courseNumber: "89-111",
    academicYear: 2028,
    semester: "spring",
    status: "planned",
    basedOn: "v1",
  });
  expect(card(mounted, "n1")!.textContent).toContain("Data Structures");
});

it("adds a Course no file knows by the number typed, into this Semester by default", async () => {
  const mounted = await mount();
  await served(mounted);
  const form = mounted.querySelector<HTMLFormElement>("form[data-plan-add]")!;
  // opened in October 2026: Academic Year 2027, Fall
  expect(form.querySelector<HTMLSelectElement>("select[data-plan-add-semester]")!.value).toBe("2027-fall");

  type(form.querySelector<HTMLInputElement>("input[data-plan-add-course]")!, " 10-001 ");
  await vi.waitFor(() => {
    if (form.querySelector<HTMLButtonElement>("button[data-plan-add-submit]")!.disabled) throw new Error("not offered");
  });
  form.querySelector<HTMLButtonElement>("button[data-plan-add-submit]")!.click();

  await vi.waitFor(() => {
    if (card(column(mounted, "2027-fall")!, "n1") === null) throw new Error("the card was not added");
  });
  expect(lastSent("POST", "/api/plan/attempts")?.body).toMatchObject({ courseNumber: "10-001", semester: "fall" });
});

it("changes a card's status and its grade, and clears the grade", async () => {
  const mounted = await mount();
  await served(mounted);

  choose(card(mounted, "a2")!.querySelector<HTMLSelectElement>("select[data-attempt-status]")!, "passed");
  await vi.waitFor(() => {
    if (card(mounted, "a2")!.dataset.status !== "passed") throw new Error("the status did not change");
  });
  expect(lastSent("PATCH", "/api/plan/attempts/a2")?.body).toEqual({ status: "passed", basedOn: "v1" });

  type(card(mounted, "a2")!.querySelector<HTMLInputElement>("input[data-attempt-grade]")!, "77");
  card(mounted, "a2")!.querySelector<HTMLButtonElement>("button[data-attempt-grade-set]")!.click();
  await vi.waitFor(() => {
    if (card(mounted, "a2")!.querySelector("[data-card-grade]")?.textContent !== "77") throw new Error("no grade");
  });
  expect(lastSent("PATCH", "/api/plan/attempts/a2")?.body).toEqual({ grade: { kind: "numeric", value: 77 }, basedOn: "v2" });

  type(card(mounted, "a2")!.querySelector<HTMLInputElement>("input[data-attempt-grade]")!, "");
  card(mounted, "a2")!.querySelector<HTMLButtonElement>("button[data-attempt-grade-set]")!.click();
  await vi.waitFor(() => {
    if (card(mounted, "a2")!.querySelector("[data-card-grade]") !== null) throw new Error("the grade stayed");
  });
  expect(lastSent("PATCH", "/api/plan/attempts/a2")?.body).toEqual({ grade: null, basedOn: "v3" });
});

it("takes a pass typed as a word, and says what is not a grade without sending it", async () => {
  const mounted = await mount();
  await served(mounted);
  const grade = () => card(mounted, "a1")!.querySelector<HTMLInputElement>("input[data-attempt-grade]")!;
  const set = () => card(mounted, "a1")!.querySelector<HTMLButtonElement>("button[data-attempt-grade-set]")!;

  type(grade(), "very good");
  set().click();
  await vi.waitFor(() => {
    if (!status(mounted).includes(t("en", "planGradeNotAGrade", { text: "very good", pass: "Pass", fail: "Fail" }))) {
      throw new Error("not said");
    }
  });
  expect(sent.some((request) => request.method === "PATCH")).toBe(false);

  type(grade(), "pass");
  set().click();
  await vi.waitFor(() => {
    if (card(mounted, "a1")!.querySelector("[data-card-grade]")?.textContent !== t("en", "planGradePass")) {
      throw new Error("no pass");
    }
  });
  expect(lastSent("PATCH", "/api/plan/attempts/a1")?.body).toEqual({
    grade: { kind: "pass-fail", passed: true },
    basedOn: "v1",
  });
});

it("offers a retake of a failed Course, in the next Fall or Spring, keeping both tries", async () => {
  attempts = [{ id: "f1", courseNumber: "89-110", academicYear: 2027, semester: "spring", status: "failed" }];
  const mounted = await mount();
  await vi.waitFor(() => {
    if (card(mounted, "f1") === null) throw new Error("not drawn");
  });
  // a planned Attempt is not one to retake
  attempts.push({ id: "p1", courseNumber: "89-111", academicYear: 2027, semester: "spring", status: "planned" });

  card(mounted, "f1")!.querySelector<HTMLButtonElement>("button[data-attempt-retake]")!.click();

  await vi.waitFor(() => {
    if (card(column(mounted, "2028-fall")!, "n1") === null) throw new Error("no retake");
  });
  expect(lastSent("POST", "/api/plan/attempts")?.body).toEqual({
    courseNumber: "89-110",
    academicYear: 2028,
    semester: "fall",
    status: "planned",
    basedOn: "v1",
  });
  expect(card(mounted, "f1")).not.toBeNull();
  expect(card(mounted, "p1")!.querySelector("[data-attempt-retake]")).toBeNull();
});

it("removes a card", async () => {
  const mounted = await mount();
  await served(mounted);

  card(mounted, "a2")!.querySelector<HTMLButtonElement>("button[data-attempt-remove]")!.click();

  await vi.waitFor(() => {
    if (card(mounted, "a2") !== null) throw new Error("the card stayed");
  });
  expect(lastSent("DELETE", "/api/plan/attempts/a2")?.body).toEqual({ basedOn: "v1" });
});

it("draws each Warning on the card or the column it points at, and a Program's above, blocking nothing", async () => {
  planWarnings = [
    {
      kind: "prerequisite-unmet",
      target: { kind: "attempt", id: "a2" },
      requirementsFile: "cs-2027",
      courseNumber: "89-111",
      missing: ["89-109"],
      reliesOn: ["a1"],
    },
    { kind: "credit-load", target: { kind: "semester", academicYear: 2027, semester: "spring" }, credits: 30, limit: 24 },
    { kind: "requirements-missing", target: { kind: "program", requirementsFile: "cs-2027" }, requirementIds: ["electives"] },
  ];
  attemptWarnings = [{ kind: "grade-out-of-range", target: { kind: "attempt", id: "a1" }, value: 191 }];
  const mounted = await mount();
  await served(mounted);

  const onA2 = card(mounted, "a2")!.querySelector("[data-card-warnings]")!.textContent;
  expect(onA2).toContain(t("en", "planWarnPrerequisite", { courses: "89-109" }));
  expect(onA2).toContain(t("en", "planWarnAssuming", { courses: "89-110" }));
  expect(card(mounted, "a1")!.querySelector("[data-card-warnings]")!.textContent).toBe(
    t("en", "planWarnGradeRange", { value: 191 }),
  );
  expect(column(mounted, "2027-spring")!.querySelector("[data-column-warnings]")!.textContent).toBe(
    t("en", "planWarnCreditLoad", { credits: 30, limit: 24 }),
  );
  expect(column(mounted, "2027-fall")!.querySelector("[data-column-warnings]")).toBeNull();
  expect(mounted.querySelector("[data-plan-warnings]")!.textContent).toContain(
    t("en", "planWarnRequirementsMissing", { file: "cs-2027", requirements: "electives" }),
  );

  // a Warning never disables the card it is on
  expect(card(mounted, "a2")!.querySelector<HTMLSelectElement>("select[data-attempt-move]")!.disabled).toBe(false);
  expect(card(mounted, "a2")!.draggable).toBe(true);
});

it("totals each column's credits, leaving out exempt Attempts and counting the ones without credits", async () => {
  attempts = [
    { id: "a1", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "passed" },
    { id: "a2", courseNumber: "89-111", academicYear: 2027, semester: "fall", status: "planned" },
    { id: "a3", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "exempt" },
    { id: "a4", courseNumber: "89-220", academicYear: 2027, semester: "fall", status: "planned" },
  ];
  const mounted = await mount();
  await served(mounted);

  expect(column(mounted, "2027-fall")!.querySelector("[data-column-credits]")!.textContent).toBe(
    `${t("en", "planColumnCredits", { credits: 11 })} · ${t("en", "planColumnUnknown", { count: 1 })}`,
  );
  expect(column(mounted, "2027-spring")!.querySelector("[data-column-credits]")!.textContent).toBe(
    t("en", "planColumnCredits", { credits: 0 }),
  );
});

it("speaks Hebrew right to left, the first Academic Year and Semester at the right", async () => {
  const mounted = await mount("he");
  await served(mounted);

  expect(mounted.firstElementChild?.getAttribute("dir")).toBe("rtl");
  const first = mounted.querySelector<HTMLElement>('section[data-year="2027"]')!.getBoundingClientRect();
  const second = mounted.querySelector<HTMLElement>('section[data-year="2028"]')!.getBoundingClientRect();
  expect(first.left).toBeGreaterThan(second.left);
  expect(column(mounted, "2027-fall")!.getBoundingClientRect().left).toBeGreaterThan(
    column(mounted, "2027-spring")!.getBoundingClientRect().left,
  );
  expect(card(mounted, "a1")!.textContent).toContain("מבוא למדעי המחשב");
  expect(card(mounted, "a1")!.textContent).toContain(t("he", "planStatusPassed"));
  expect(mounted.querySelector("button[data-plan-layout]")!.textContent).toBe(t("he", "planLayoutAction"));
});

it("fills the Plan from the Suggested Layout, drawing the new cards and the summary", async () => {
  layout = {
    create: [{ id: "l1", courseNumber: "89-220", academicYear: 2028, semester: "fall", status: "planned" }],
    skipped: [
      { courseNumber: "89-110", reason: "attempted" },
      { courseNumber: "89-111", reason: "listed-twice" },
    ],
  };
  const mounted = await mount();
  await served(mounted);

  mounted.querySelector<HTMLButtonElement>("button[data-plan-layout]")!.click();

  await vi.waitFor(() => {
    if (card(column(mounted, "2028-fall")!, "l1") === null) throw new Error("no new card");
  });
  expect(lastSent("POST", "/api/plan/suggested-layout")?.body).toEqual({ basedOn: "v1" });
  const summary = mounted.querySelector('[role="status"] [data-plan-summary]')!.textContent;
  expect(summary).toContain(t("en", "planLayoutCreated", { count: 1 }));
  expect(summary).toContain(t("en", "planLayoutSkippedAttempted", { course: "89-110" }));
  expect(summary).toContain(t("en", "planLayoutSkippedTwice", { course: "89-111" }));
});

it("says the Suggested Layout added nothing when every Course is already there", async () => {
  layout = { create: [], skipped: [{ courseNumber: "89-110", reason: "attempted" }] };
  const mounted = await mount("he");
  await served(mounted);

  mounted.querySelector<HTMLButtonElement>("button[data-plan-layout]")!.click();

  await vi.waitFor(() => {
    if (!status(mounted).includes(t("he", "planLayoutNothing"))) throw new Error("not said");
  });
  expect(status(mounted)).toContain(t("he", "planLayoutSkippedAttempted", { course: "89-110" }));
});

it("says what the Suggested Layout needs, by reason, and guesses nothing", async () => {
  const mounted = await mount();
  await served(mounted);
  const cards = mounted.querySelectorAll("article[data-attempt]").length;

  for (const [reason, key] of [
    ["cohort-not-chosen", "planLayoutCohortNotChosen"],
    ["program-not-chosen", "planLayoutProgramNotChosen"],
    ["requirements-file-unavailable", "planLayoutFileUnavailable"],
    ["no-suggested-layout", "planLayoutNone"],
  ] as const) {
    layout = { unavailable: reason };
    mounted.querySelector<HTMLButtonElement>("button[data-plan-layout]")!.click();
    await vi.waitFor(() => {
      if (!status(mounted).includes(t("en", key))) throw new Error(`${reason} was not said`);
    });
  }
  expect(mounted.querySelectorAll("article[data-attempt]")).toHaveLength(cards);
  expect(mounted.querySelector("[data-plan-summary]")).toBeNull();
});

it("tells a stale revision from what the Suggested Layout needs, and reads the Plan again", async () => {
  const mounted = await mount();
  await served(mounted);
  refuseNextEdit = "state-file-changed";
  const reads = sent.filter((request) => request.pathname === "/api/plan").length;

  mounted.querySelector<HTMLButtonElement>("button[data-plan-layout]")!.click();

  await vi.waitFor(() => {
    if (!status(mounted).includes(t("en", "planStale"))) throw new Error("the refusal was not said");
  });
  await vi.waitFor(() => {
    if (sent.filter((request) => request.method === "GET" && request.pathname === "/api/plan").length <= reads) {
      throw new Error("the screen did not read again");
    }
  });
});

it("reads the Plan again when the Workspace changes, from another tab or an editor", async () => {
  const mounted = await mount();
  await served(mounted);
  attempts = [...attempts, { id: "x1", courseNumber: "89-220", academicYear: 2029, semester: "fall", status: "planned" }];

  await mount("en", 1);

  await vi.waitFor(() => {
    if (card(column(mounted, "2029-fall")!, "x1") === null) throw new Error("not read again");
  });
});

it("offers undo based on the revision it shows, names the edit, and reads again after it", async () => {
  const mounted = await mount();
  await served(mounted);
  canUndo = true;
  const form = mounted.querySelector<HTMLFormElement>("form[data-plan-add]")!;
  type(form.querySelector<HTMLInputElement>("input[data-plan-add-course]")!, "89-220");
  await vi.waitFor(() => {
    if (form.querySelector<HTMLButtonElement>("button[data-plan-add-submit]")!.disabled) throw new Error("not offered");
  });
  form.querySelector<HTMLButtonElement>("button[data-plan-add-submit]")!.click();
  await vi.waitFor(() => {
    if (card(mounted, "n1") === null) throw new Error("not added");
  });

  const undo = await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLButtonElement>('button[data-history="undo"]');
    if (found === null || found.disabled) throw new Error("undo was never offered");
    return found;
  });
  undo.click();

  await vi.waitFor(() => {
    if (card(mounted, "n1") !== null) throw new Error("the undo was not read back");
  });
  expect(lastSent("POST", "/api/history/undo")?.body).toEqual({ basedOn: "v2" });
  expect(status(mounted)).toContain(t("en", "undoneEdit", { edit: t("en", "editAddAttempt") }));
});

it("says when no Cohort is chosen, and starts at the first Attempt", async () => {
  cohort = null;
  attempts = [{ id: "a1", courseNumber: "89-110", academicYear: 2028, semester: "spring", status: "planned" }];
  const mounted = await mount();
  await served(mounted);

  expect(mounted.textContent).toContain(t("en", "planNoCohort"));
  expect(mounted.querySelector("section[data-year]")!.getAttribute("data-year")).toBe("2028");
  expect(column(mounted, "2028-fall")).toBeNull();
});

it("shows another Academic Year when asked, so a card can go further than a standard degree", async () => {
  const mounted = await mount();
  await served(mounted);
  expect(mounted.querySelector('section[data-year="2030"]')).toBeNull();

  mounted.querySelector<HTMLButtonElement>("button[data-plan-add-year]")!.click();

  await vi.waitFor(() => {
    if (mounted.querySelector('section[data-year="2030"]') === null) throw new Error("no year added");
  });
  expect(
    [...card(mounted, "a2")!.querySelector<HTMLSelectElement>("select[data-attempt-move]")!.options].some(
      (option) => option.value === "2030-fall",
    ),
  ).toBe(true);
});
