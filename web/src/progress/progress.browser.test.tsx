/// <reference types="@vitest/browser-playwright" />
/**
 * The Progress screen as a student meets it (#288): the Requirement tree with each node's status
 * and numbers, the lens toggle, Pinning and unpinning a Course, ticking a Manual Requirement, the
 * state with no Program chosen, Warnings, and the tree navigable from the keyboard. A browser,
 * because what is under test is a click, a key, a request and a re-render.
 *
 * The API is a fake `fetch` that keeps the Pins and ticks it was sent and answers with Progress
 * built from them, the way `server/src/api.ts` answers every edit with the evaluation afterwards.
 * Its evaluation is a stand-in — the real one is `core`'s and is tested there and over the real
 * API — so these tests are about what the screen does with an answer, not about the engine.
 *
 * The Program, its Requirements and the Courses are invented (ADR-0006).
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../index.css";
import { AppShell } from "../AppShell.tsx";
import { t, type Language } from "../i18n/strings.ts";
import { PROGRESS_SCREEN } from "./ProgressScreen.tsx";

const ROOT = document.documentElement;
const realFetch = globalThis.fetch;
let host: HTMLElement | undefined;
let root: Root | undefined;

let sent: Array<{ method: string; pathname: string; body: unknown }>;
let programs: Array<{ requirementsFile: string; track?: string }>;
let cohort: { academicYear: number; semester: string } | null;
let programWarnings: unknown[];
/** Every what-if the screen asked Progress for, as the Programs it carried (#289). */
let previews: unknown[];
/** Files the real read finds missing and a what-if's read, made later, finds there. */
let unreadableInReal: string[];
let pins: Array<{ courseNumber: string; requirementId: string }>;
let ticked: boolean;
let version: number;
let refuseNextEdit: string | undefined;
let stoppedEarly: boolean;
let onlyUnreadableFiles: boolean;
let canUndo: boolean;
let stateWarnings: unknown[];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The Requirements Files the fake's Workspace holds; a Program naming any other is missing. */
const KNOWN_FILES = ["cs-2027", "math-2027"];

/**
 * What the fake's stand-in evaluation makes of the Pins and the tick it holds, for the Programs it
 * is asked about: the stored ones, or a what-if's. Under the AI Track the electives are met and an
 * AI core is added, still to do, so a switch has something to compare.
 */
function progressBody(of: typeof programs = programs, real = true): unknown {
  const pinnedToElectives = pins.some((pin) => pin.courseNumber === "89-110" && pin.requirementId === "electives");
  const evaluation = (status: string, courses: string[], extra: object = {}) => ({ status, courses, ...extra });
  const tree = (track: string | undefined) => [
    {
      id: "intro",
      kind: "course",
      name: { he: "מבוא", en: "Introduction" },
      completed: evaluation(pinnedToElectives ? "missing" : "satisfied", pinnedToElectives ? [] : ["89-110"]),
      projected: evaluation(pinnedToElectives ? "missing" : "satisfied", pinnedToElectives ? [] : ["89-110"]),
      children: [],
    },
    {
      id: "electives",
      kind: "credits",
      name: { he: "בחירה", en: "Electives" },
      completed:
        track === "ai"
          ? evaluation("satisfied", ["89-110"], { credits: { counted: 5, needed: 5 } })
          : evaluation(pinnedToElectives ? "partial" : "missing", pinnedToElectives ? ["89-110"] : [], {
              credits: { counted: pinnedToElectives ? 5 : 0, needed: 6 },
            }),
      projected: evaluation("satisfied", pinnedToElectives ? ["89-110", "89-320"] : ["89-320"], {
        credits: { counted: pinnedToElectives ? 8 : 6, needed: 6 },
      }),
      children: [],
    },
    {
      id: "hebrew",
      kind: "manual",
      name: { he: "הבעה עברית", en: "Hebrew expression" },
      text: { he: "עמידה בבחינת הבעה", en: "Pass the expression exam" },
      ticked,
      completed: evaluation(ticked ? "satisfied" : "missing", []),
      projected: evaluation(ticked ? "satisfied" : "missing", []),
      children: [],
    },
    ...(track === "ai"
      ? [
          {
            id: "ai-core",
            kind: "course",
            name: { he: "ליבת בינה", en: "AI core" },
            completed: evaluation("missing", []),
            projected: evaluation("missing", []),
            children: [],
          },
        ]
      : []),
  ];
  return {
    cohort,
    programs: of.map(({ requirementsFile, track }) => {
      const named = { requirementsFile, ...(track === undefined ? {} : { track }) };
      if (!KNOWN_FILES.includes(requirementsFile) || (real && unreadableInReal.includes(requirementsFile))) {
        return { ...named, status: "missing" };
      }
      return {
        ...named,
        status: "evaluated",
        program: { id: "cs", name: { he: "מדעי המחשב", en: "Computer Science" } },
        progress: {
          requirements: tree(track),
          status: { completed: "partial", projected: ticked ? "satisfied" : "partial" },
          totalCredits: { completed: 5, projected: 11 },
          warnings: [{ kind: "course-unknown", courseNumber: "10-001" }],
        },
        pins,
        candidates: [
          { courseNumber: "89-110", requirementIds: ["intro", "electives"] },
          { courseNumber: "89-320", requirementIds: ["electives"] },
          { courseNumber: "10-001", requirementIds: [] },
        ],
      };
    }),
    stoppedEarly,
    solverWarnings: [],
    programWarnings,
    // the fake's Pins are all in cs-2027, so Programs without it leave each reaching nothing
    pinWarnings: of.some((program) => program.requirementsFile === "cs-2027")
      ? []
      : pins.map((pin) => ({ kind: "pin-file-not-chosen", ...pin, requirementsFile: "cs-2027" })),
    version: `v${version}`,
    warnings: stateWarnings,
  };
}

beforeEach(() => {
  sent = [];
  programs = [{ requirementsFile: "cs-2027" }];
  cohort = null;
  programWarnings = [];
  previews = [];
  unreadableInReal = [];
  pins = [];
  ticked = false;
  version = 1;
  refuseNextEdit = undefined;
  stoppedEarly = false;
  onlyUnreadableFiles = false;
  canUndo = false;
  stateWarnings = [];
  ROOT.lang = "en";
  ROOT.dir = "ltr";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname, searchParams } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    const text = input instanceof Request ? await input.clone().text() : init?.body;
    const body = typeof text === "string" && text !== "" ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    sent.push({ method, pathname, body });

    if (pathname === "/api/history") return json({ canUndo, canRedo: false });
    if (pathname === "/api/history/undo") {
      canUndo = false;
      version += 1;
      return json({ label: "pin-course", at: 1, version: `v${version}`, canUndo: false, canRedo: true, warnings: [] });
    }
    if (pathname === "/api/progress" && searchParams.has("whatIf")) {
      const whatIf = JSON.parse(searchParams.get("whatIf")!) as typeof programs;
      previews.push(whatIf);
      return json(progressBody(whatIf, false));
    }
    if (pathname === "/api/progress") return json(progressBody());
    if (pathname === "/api/requirements" && onlyUnreadableFiles) {
      return json({ files: [{ name: "notes", status: "not-requirements", warnings: [{ kind: "file-unreadable" }] }] });
    }
    if (pathname === "/api/requirements") {
      return json({
        files: [
          {
            name: "cs-2027",
            status: "read",
            program: { id: "cs", name: { he: "מדעי המחשב", en: "Computer Science" } },
            cohorts: [],
            tracks: [{ id: "ai", name: { he: "בינה מלאכותית", en: "AI" } }],
            warnings: [],
          },
          {
            name: "math-2027",
            status: "read",
            program: { id: "math", name: { he: "מתמטיקה", en: "Mathematics" } },
            cohorts: [],
            tracks: [],
            warnings: [],
          },
          { name: "notes", status: "not-requirements", warnings: [{ kind: "file-unreadable" }] },
        ],
      });
    }
    // #326's reason, which is not the claim that nothing was written: the fake makes the edit, as
    // the server did, and then cannot say the revision it wrote (#344)
    if (method !== "GET" && refuseNextEdit === "save-revision-unreadable" && pathname === "/api/progress/ticks") {
      refuseNextEdit = undefined;
      ticked = method === "POST";
      version += 1;
      return json({ reason: "save-revision-unreadable", warnings: [] }, 409);
    }
    if (method !== "GET" && refuseNextEdit !== undefined) {
      const reason = refuseNextEdit;
      refuseNextEdit = undefined;
      version += 1; // somebody else wrote the file
      return json({ reason, warnings: [] }, 409);
    }
    if (pathname === "/api/programs" && method === "PUT") {
      programs = body?.programs as typeof programs;
      programWarnings = [];
      version += 1;
      return json({ cohort, programs, programWarnings, version: `v${version}`, warnings: [] });
    }
    if (pathname === "/api/cohort" && method === "PUT") {
      cohort = body?.cohort as typeof cohort;
      version += 1;
      return json({ cohort, programs, programWarnings, version: `v${version}`, warnings: [] });
    }
    if (pathname === "/api/progress/pins") {
      const pin = { courseNumber: body?.courseNumber as string, requirementId: body?.requirementId as string };
      pins = pins.filter((held) => held.courseNumber !== pin.courseNumber);
      if (method === "POST") pins.push(pin);
      version += 1;
      return json(progressBody());
    }
    if (pathname === "/api/progress/ticks") {
      ticked = method === "POST";
      version += 1;
      return json(progressBody());
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

async function mount(language: Language = "en", workspaceChanges = 0): Promise<HTMLElement> {
  if (host === undefined) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  root!.render(
    <AppShell
      screens={[PROGRESS_SCREEN]}
      language={language}
      onLanguage={() => {}}
      workspaceChanges={workspaceChanges}
    />,
  );
  return host;
}

const treeItem = (mounted: HTMLElement, id: string): HTMLElement => {
  const found = mounted.querySelector<HTMLElement>(`[role="treeitem"][data-requirement="${id}"]`);
  if (found === null) throw new Error(`the tree has no node ${id}`);
  return found;
};

async function served(mounted: HTMLElement): Promise<void> {
  await vi.waitFor(() => treeItem(mounted, "intro"));
}

const lastSent = (pathname: string) => [...sent].reverse().find((request) => request.pathname === pathname);

it("draws each Requirement with its status and numbers, in the completed lens first", async () => {
  const mounted = await mount();
  await served(mounted);

  expect(treeItem(mounted, "intro").dataset.status).toBe("satisfied");
  expect(treeItem(mounted, "intro").textContent).toContain(t("en", "progressSatisfied"));
  expect(treeItem(mounted, "intro").textContent).toContain("89-110");
  expect(treeItem(mounted, "electives").dataset.status).toBe("missing");
  expect(treeItem(mounted, "electives").textContent).toContain(
    t("en", "progressCredits", { counted: 0, needed: 6 }),
  );
  expect(mounted.textContent).toContain("Computer Science");
  expect(mounted.textContent).toContain(t("en", "progressTotalCredits", { credits: 5 }));
});

it("toggles to the lens of the Plan holding, and back", async () => {
  const mounted = await mount();
  await served(mounted);
  const projected = mounted.querySelector<HTMLButtonElement>('button[data-lens="projected"]')!;
  expect(projected.getAttribute("aria-pressed")).toBe("false");

  projected.click();

  await vi.waitFor(() => {
    if (treeItem(mounted, "electives").dataset.status !== "satisfied") throw new Error("the lens did not change");
  });
  expect(projected.getAttribute("aria-pressed")).toBe("true");
  expect(treeItem(mounted, "electives").textContent).toContain(
    t("en", "progressCredits", { counted: 6, needed: 6 }),
  );
  expect(mounted.textContent).toContain(t("en", "progressTotalCredits", { credits: 11 }));

  mounted.querySelector<HTMLButtonElement>('button[data-lens="completed"]')!.click();
  await vi.waitFor(() => {
    if (treeItem(mounted, "electives").dataset.status !== "missing") throw new Error("the lens did not change back");
  });
});

it("pins a Course to another Requirement it can count toward, and marks it pinned", async () => {
  const mounted = await mount();
  await served(mounted);
  const select = mounted.querySelector<HTMLSelectElement>('select[data-pin-course="89-110"]')!;
  // only what the engine said the Course can count toward is offered, plus "decided for you"
  expect([...select.options].map((option) => option.value)).toEqual(["", "intro", "electives"]);

  select.value = "electives";
  select.dispatchEvent(new Event("change", { bubbles: true }));

  await vi.waitFor(() => {
    const chip = treeItem(mounted, "electives").querySelector('[data-course="89-110"]');
    if (chip?.getAttribute("data-pinned") !== "true") throw new Error("the Pin was not drawn");
  });
  expect(lastSent("/api/progress/pins")).toEqual({
    method: "POST",
    pathname: "/api/progress/pins",
    body: { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "electives", basedOn: "v1" },
  });
  expect(treeItem(mounted, "electives").textContent).toContain(t("en", "progressPinned"));
});

it("removes a Pin, so the solver decides again", async () => {
  pins = [{ courseNumber: "89-110", requirementId: "electives" }];
  const mounted = await mount();
  await served(mounted);

  mounted.querySelector<HTMLButtonElement>('button[data-unpin="89-110"]')!.click();

  await vi.waitFor(() => {
    if (mounted.querySelector('button[data-unpin="89-110"]') !== null) throw new Error("still pinned");
  });
  expect(lastSent("/api/progress/pins")).toMatchObject({
    method: "DELETE",
    body: { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "electives" },
  });
  expect(treeItem(mounted, "intro").textContent).toContain("89-110");
});

it("ticks a Manual Requirement, showing its own text, and unticks it", async () => {
  const mounted = await mount();
  await served(mounted);
  expect(treeItem(mounted, "hebrew").textContent).toContain("Pass the expression exam");
  const box = (): HTMLInputElement => mounted.querySelector<HTMLInputElement>('input[data-tick="hebrew"]')!;

  box().click();
  await vi.waitFor(() => {
    if (!box().checked || treeItem(mounted, "hebrew").dataset.status !== "satisfied") {
      throw new Error("the tick was not drawn");
    }
  });
  expect(lastSent("/api/progress/ticks")).toMatchObject({
    method: "POST",
    body: { requirementsFile: "cs-2027", requirementId: "hebrew", basedOn: "v1" },
  });

  box().click();
  await vi.waitFor(() => {
    if (box().checked) throw new Error("the untick was not drawn");
  });
  expect(lastSent("/api/progress/ticks")).toMatchObject({ method: "DELETE", body: { basedOn: "v2" } });
});

it("says when no Program is chosen, and lets the student choose one", async () => {
  programs = [];
  const mounted = await mount();

  await vi.waitFor(() => {
    if (!(mounted.textContent ?? "").includes(t("en", "progressNoProgram"))) throw new Error("not said");
  });
  const file = await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLSelectElement>('select[data-choose="file"]');
    if (found === null) throw new Error("no Program to choose from");
    return found;
  });
  // a file that is not a Requirements File is not offered as a Program
  expect([...file.options].map((option) => option.value)).toEqual(["", "cs-2027", "math-2027"]);
  file.value = "cs-2027";
  file.dispatchEvent(new Event("change", { bubbles: true }));
  const track = await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLSelectElement>('select[data-choose="track"]');
    if (found === null) throw new Error("no Track to choose from");
    return found;
  });
  track.value = "ai";
  track.dispatchEvent(new Event("change", { bubbles: true }));
  mounted.querySelector<HTMLButtonElement>('button[data-choose="submit"]')!.click();

  await served(mounted);
  expect(lastSent("/api/programs")).toEqual({
    method: "PUT",
    pathname: "/api/programs",
    body: { programs: [{ requirementsFile: "cs-2027", track: "ai" }], basedOn: "v1" },
  });
});

it("shows both Programs of a double major", async () => {
  programs = [{ requirementsFile: "cs-2027" }, { requirementsFile: "math-2027" }];
  const mounted = await mount();
  await served(mounted);

  expect(mounted.querySelectorAll("[data-program]")).toHaveLength(2);
  expect(mounted.querySelectorAll('[role="tree"]')).toHaveLength(2);
});

it("shows the Warnings and a solver that stopped early, and blocks nothing", async () => {
  stoppedEarly = true;
  const mounted = await mount();
  await served(mounted);

  expect(mounted.textContent).toContain(t("en", "progressWarnCourseUnknown", { course: "10-001" }));
  expect(mounted.querySelector('[role="status"]')?.textContent).toContain(t("en", "progressStoppedEarly"));
  expect(mounted.querySelector<HTMLInputElement>('input[data-tick="hebrew"]')!.disabled).toBe(false);
});

it("says a Pin was refused over a stale view, and reads the screen again", async () => {
  const mounted = await mount();
  await served(mounted);
  refuseNextEdit = "state-file-changed";
  const reads = sent.filter((request) => request.pathname === "/api/progress").length;

  mounted.querySelector<HTMLInputElement>('input[data-tick="hebrew"]')!.click();

  await vi.waitFor(() => {
    if (!(mounted.querySelector('[role="status"]')?.textContent ?? "").includes(t("en", "progressStale"))) {
      throw new Error("the refusal was not said");
    }
  });
  await vi.waitFor(() => {
    if (sent.filter((request) => request.pathname === "/api/progress").length <= reads) {
      throw new Error("the screen did not read again");
    }
  });
});

/**
 * #344: a save whose revision could not be read may have landed (#326), so the screen says so and
 * reads the file again, as the Timetable does — rather than keeping a view that may be stale and a
 * revision the next edit would be refused on. The fake lands the tick, so the re-read is what
 * draws it: the box turning checked is the visible change this waits on.
 */
it("reads the screen again when a tick may have been saved and its revision could not be read", async () => {
  const mounted = await mount();
  await served(mounted);
  refuseNextEdit = "save-revision-unreadable";
  const box = (): HTMLInputElement => mounted.querySelector<HTMLInputElement>('input[data-tick="hebrew"]')!;
  expect(box().checked).toBe(false);

  box().click();

  await vi.waitFor(() => {
    if (!(mounted.querySelector('[role="status"]')?.textContent ?? "").includes(t("en", "saveUnconfirmed"))) {
      throw new Error("the sentence was not said");
    }
  });
  await vi.waitFor(() => {
    if (!box().checked || treeItem(mounted, "hebrew").dataset.status !== "satisfied") {
      throw new Error("the screen did not read the landed tick again");
    }
  });
  // and the next edit is based on the revision the re-read brought, not the spent one
  box().click();
  await vi.waitFor(() => {
    if (box().checked) throw new Error("the untick was not drawn");
  });
  expect(lastSent("/api/progress/ticks")).toMatchObject({ method: "DELETE", body: { basedOn: "v2" } });
});

it("moves between the nodes of the tree with the arrow keys", async () => {
  const mounted = await mount();
  await served(mounted);
  const first = treeItem(mounted, "intro");
  // one tab stop for the whole tree, on the first node
  expect(first.tabIndex).toBe(0);
  expect(treeItem(mounted, "electives").tabIndex).toBe(-1);
  first.focus();

  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(treeItem(mounted, "electives"));
  await userEvent.keyboard("{End}");
  expect(document.activeElement).toBe(treeItem(mounted, "hebrew"));
  await userEvent.keyboard("{Home}");
  expect(document.activeElement).toBe(treeItem(mounted, "intro"));
  expect(treeItem(mounted, "intro").getAttribute("aria-level")).toBe("1");
});

it("speaks Hebrew right to left, with the Requirement names from the file in Hebrew", async () => {
  const mounted = await mount("he");
  await served(mounted);

  expect(mounted.firstElementChild?.getAttribute("dir")).toBe("rtl");
  expect(treeItem(mounted, "intro").textContent).toContain("מבוא");
  expect(treeItem(mounted, "intro").textContent).toContain(t("he", "progressSatisfied"));
  expect(mounted.textContent).toContain("מדעי המחשב");
  const lens = mounted.querySelector<HTMLButtonElement>('button[data-lens="completed"]')!;
  const projected = mounted.querySelector<HTMLButtonElement>('button[data-lens="projected"]')!;
  // the first lens sits at the start, which is the right in Hebrew
  expect(lens.getBoundingClientRect().left).toBeGreaterThan(projected.getBoundingClientRect().left);
});

it("reads Progress again when the Workspace changes, from another tab or an editor", async () => {
  const mounted = await mount();
  await served(mounted);
  const reads = sent.filter((request) => request.pathname === "/api/progress").length;
  ticked = true; // what another tab saved

  await mount("en", 1);

  await vi.waitFor(() => {
    if (treeItem(mounted, "hebrew").dataset.status !== "satisfied") throw new Error("not read again");
  });
  expect(sent.filter((request) => request.pathname === "/api/progress").length).toBe(reads + 1);
});

it("says there is nothing to choose a Program from when no file in the folder is a Requirements File", async () => {
  programs = [];
  onlyUnreadableFiles = true;
  const mounted = await mount();

  await vi.waitFor(() => {
    if (!(mounted.textContent ?? "").includes(t("en", "progressNoRequirementsFiles"))) {
      throw new Error("the empty folder was not said");
    }
  });
  expect(mounted.querySelector('select[data-choose="file"]')).toBeNull();
});

it("offers undo on the Progress screen, based on the revision it shows, and reads again after it", async () => {
  canUndo = true;
  const mounted = await mount();
  await served(mounted);
  const reads = sent.filter((request) => request.pathname === "/api/progress").length;

  const undo = await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLButtonElement>('button[data-history="undo"]');
    if (found === null || found.disabled) throw new Error("undo was never offered");
    return found;
  });
  undo.click();

  await vi.waitFor(() => {
    if (sent.filter((request) => request.pathname === "/api/progress").length <= reads) {
      throw new Error("the screen did not read again after the undo");
    }
  });
  expect(lastSent("/api/history/undo")?.body).toEqual({ basedOn: "v1" });
  expect(mounted.querySelector('[role="status"]')?.textContent).toContain(
    t("en", "undoneEdit", { edit: t("en", "editPinCourse") }),
  );
});

it("puts the Pin back in the solver's hands when \"decided for you\" is chosen", async () => {
  pins = [{ courseNumber: "89-110", requirementId: "electives" }];
  const mounted = await mount();
  await served(mounted);
  const select = mounted.querySelector<HTMLSelectElement>('select[data-pin-course="89-110"]')!;
  expect(select.value).toBe("electives");

  select.value = "";
  select.dispatchEvent(new Event("change", { bubbles: true }));

  await vi.waitFor(() => {
    if (mounted.querySelector('button[data-unpin="89-110"]') !== null) throw new Error("still pinned");
  });
  expect(lastSent("/api/progress/pins")).toMatchObject({
    method: "DELETE",
    body: { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "electives" },
  });
});

it("shows what reading the saved file had to leave out", async () => {
  stateWarnings = [
    { kind: "entry-dropped", at: "pins[0]", field: "requirementId" },
    { kind: "cohort-unreadable", field: "semester" },
  ];
  const mounted = await mount();
  await served(mounted);

  expect(mounted.textContent).toContain(t("en", "progressWarnEntryDropped", { at: "pins[0]" }));
  expect(mounted.textContent).toContain(t("en", "progressWarnCohortUnreadable"));
});

it("offers a Requirements File dropped into the folder while the chooser is open", async () => {
  programs = [];
  onlyUnreadableFiles = true;
  const mounted = await mount();
  await vi.waitFor(() => {
    if (!(mounted.textContent ?? "").includes(t("en", "progressNoRequirementsFiles"))) throw new Error("not said");
  });

  onlyUnreadableFiles = false; // a file arrived, and the watcher moved the change count
  await mount("en", 1);

  await vi.waitFor(() => {
    if (mounted.querySelector('select[data-choose="file"]') === null) throw new Error("the new file was not offered");
  });
});

/* #331: the student's Programs and Cohort, changed from the screen. */

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const found = <T extends Element>(mounted: HTMLElement, selector: string): Promise<T> =>
  vi.waitFor(() => {
    const element = mounted.querySelector<T>(selector);
    if (element === null) throw new Error(`nothing matches ${selector}`);
    return element;
  });

/** Waits for the screen to show a read made after the save it just sent, the revision moved on. */
async function readAfter(pathname: string): Promise<void> {
  await vi.waitFor(() => {
    const saved = sent.findLastIndex((request) => request.pathname === pathname);
    const read = sent.findLastIndex((request) => request.pathname === "/api/progress");
    if (saved < 0 || read < saved) throw new Error(`Progress was not read after ${pathname}`);
  });
}

it("changes a Program's Track, sending the whole list to the Programs route", async () => {
  const mounted = await mount();
  await served(mounted);
  const track = await found<HTMLSelectElement>(mounted, 'select[data-program-track="0"]');
  expect([...track.options].map((option) => option.value)).toEqual(["", "ai"]);

  choose(track, "ai");

  await readAfter("/api/programs");
  expect(lastSent("/api/programs")).toEqual({
    method: "PUT",
    pathname: "/api/programs",
    body: { programs: [{ requirementsFile: "cs-2027", track: "ai" }], basedOn: "v1" },
  });
  await vi.waitFor(() => {
    if (mounted.querySelector<HTMLSelectElement>('select[data-program-track="0"]')?.value !== "ai") {
      throw new Error("the new Track was not drawn");
    }
  });
});

it("changes a Program's file, and the Track of the old file goes with it", async () => {
  programs = [{ requirementsFile: "cs-2027", track: "ai" }];
  const mounted = await mount();
  await served(mounted);
  const file = await found<HTMLSelectElement>(mounted, 'select[data-program-file="0"]');
  expect(file.value).toBe("cs-2027");
  // only Requirements Files this build could read are offered
  expect([...file.options].map((option) => option.value)).toEqual(["cs-2027", "math-2027"]);

  choose(file, "math-2027");

  await readAfter("/api/programs");
  expect(lastSent("/api/programs")?.body).toEqual({
    programs: [{ requirementsFile: "math-2027" }],
    basedOn: "v1",
  });
});

it("adds a double major's second Program, and removes it", async () => {
  const mounted = await mount();
  await served(mounted);

  choose(await found<HTMLSelectElement>(mounted, "select[data-program-add]"), "math-2027");
  (await found<HTMLButtonElement>(mounted, "button[data-program-add-submit]")).click();

  await readAfter("/api/programs");
  expect(lastSent("/api/programs")?.body).toEqual({
    programs: [{ requirementsFile: "cs-2027" }, { requirementsFile: "math-2027" }],
    basedOn: "v1",
  });
  const removeSecond = await found<HTMLButtonElement>(mounted, 'button[data-program-remove="1"]');
  // a double major is two Programs: there is no third to add
  expect(mounted.querySelector("select[data-program-add]")).toBeNull();

  await vi.waitFor(() => {
    if (removeSecond.disabled) throw new Error("still sending");
  });
  removeSecond.click();

  await vi.waitFor(() => {
    if ((lastSent("/api/programs")?.body as { basedOn?: string }).basedOn !== "v2") throw new Error("not removed");
  });
  expect(lastSent("/api/programs")?.body).toEqual({ programs: [{ requirementsFile: "cs-2027" }], basedOn: "v2" });
  await vi.waitFor(() => {
    if (mounted.querySelector('[data-program-row="1"]') !== null) throw new Error("the second row stayed");
  });
});

it("sets the Cohort, says it, and clears it", async () => {
  const mounted = await mount();
  await served(mounted);
  expect((await found(mounted, "[data-cohort-said]")).textContent).toBe(t("en", "progressCohortNone"));
  expect(mounted.querySelector("button[data-cohort-clear]")).toBeNull();

  const year = await found<HTMLSelectElement>(mounted, "select[data-cohort-year]");
  // the Academic Year is offered as the span it is, never as a bare year to guess the meaning of
  expect(year.querySelector('option[value="2026"]')?.textContent).toBe(
    t("en", "academicYear", { first: "2025", second: "26" }),
  );
  choose(year, "2026");
  choose(await found<HTMLSelectElement>(mounted, "select[data-cohort-semester]"), "spring");
  (await found<HTMLButtonElement>(mounted, "button[data-cohort-set]")).click();

  await readAfter("/api/cohort");
  expect(lastSent("/api/cohort")).toEqual({
    method: "PUT",
    pathname: "/api/cohort",
    body: { cohort: { academicYear: 2026, semester: "spring" }, basedOn: "v1" },
  });
  await vi.waitFor(() => {
    const said = mounted.querySelector("[data-cohort-said]")?.textContent;
    if (
      said !==
      t("en", "progressCohortSaid", {
        year: t("en", "academicYear", { first: "2025", second: "26" }),
        semester: t("en", "semesterSpring"),
      })
    ) {
      throw new Error(`the Cohort said ${said}`);
    }
  });

  const clear = await found<HTMLButtonElement>(mounted, "button[data-cohort-clear]");
  await vi.waitFor(() => {
    if (clear.disabled) throw new Error("still sending");
  });
  clear.click();

  await vi.waitFor(() => {
    if (lastSent("/api/cohort")?.body === undefined || (lastSent("/api/cohort")!.body as { cohort: unknown }).cohort !== null) {
      throw new Error("not cleared");
    }
  });
  expect(lastSent("/api/cohort")?.body).toEqual({ cohort: null, basedOn: "v2" });
});

it("draws a missing file's Warning on its row, which offers another file and the remove", async () => {
  programs = [{ requirementsFile: "gone-2026" }];
  programWarnings = [{ kind: "program-file-missing", index: 0, requirementsFile: "gone-2026" }];
  const mounted = await mount();

  const row = await found<HTMLElement>(mounted, '[data-program-row="0"]');
  await vi.waitFor(() => {
    if (!(row.textContent ?? "").includes(t("en", "progressWarnFileMissing", { file: "gone-2026" }))) {
      throw new Error("the Warning is not on the row");
    }
  });
  // the file held is still what the select says, and the row's own controls are what fix it
  const file = row.querySelector<HTMLSelectElement>('select[data-program-file="0"]')!;
  expect(file.value).toBe("gone-2026");
  expect(file.selectedOptions[0]?.textContent).toBe(t("en", "progressFileNotOffered", { file: "gone-2026" }));
  expect(row.querySelector('button[data-program-remove="0"]')).not.toBeNull();
  // and the Warning is said once, there, not again in the list above
  expect(mounted.querySelector("[data-progress-warnings]")?.textContent ?? "").not.toContain("gone-2026");

  choose(file, "cs-2027");

  await readAfter("/api/programs");
  expect(lastSent("/api/programs")?.body).toEqual({ programs: [{ requirementsFile: "cs-2027" }], basedOn: "v1" });
});

it("draws an unknown Track's Warning on its row, which offers the Tracks the file has", async () => {
  programs = [{ requirementsFile: "cs-2027", track: "robotics" }];
  programWarnings = [{ kind: "program-track-unknown", index: 0, requirementsFile: "cs-2027", track: "robotics" }];
  const mounted = await mount();
  await served(mounted);

  const row = await found<HTMLElement>(mounted, '[data-program-row="0"]');
  expect(row.querySelector('[data-program-warnings="0"]')?.textContent).toContain(
    t("en", "progressWarnTrackUnknown", { file: "cs-2027", track: "robotics" }),
  );
  const track = row.querySelector<HTMLSelectElement>('select[data-program-track="0"]')!;
  expect(track.value).toBe("robotics");
  expect([...track.options].map((option) => option.value)).toEqual(["", "robotics", "ai"]);

  choose(track, "ai");

  await readAfter("/api/programs");
  expect(lastSent("/api/programs")?.body).toEqual({
    programs: [{ requirementsFile: "cs-2027", track: "ai" }],
    basedOn: "v1",
  });
});

it("says the Programs and the Cohort in Hebrew, right to left", async () => {
  cohort = { academicYear: 2026, semester: "fall" };
  const mounted = await mount("he");
  await served(mounted);

  expect(mounted.querySelector("[data-programs]")?.textContent).toContain(t("he", "progressProgramsHeading"));
  expect(mounted.querySelector("[data-cohort-said]")?.textContent).toBe(
    t("he", "progressCohortSaid", {
      year: t("he", "academicYear", { first: "2025", second: "26" }),
      semester: t("he", "semesterFall"),
    }),
  );
  const file = mounted.querySelector<HTMLElement>('select[data-program-file="0"]')!;
  const remove = mounted.querySelector<HTMLElement>('button[data-program-remove="0"]')!;
  // the row starts at the right: the file's select, then the remove to its left
  expect(file.getBoundingClientRect().left).toBeGreaterThan(remove.getBoundingClientRect().left);
});

/* #289: "what if I switched Track", evaluated and never saved. */

/** Every request that is not a read: a preview must add none. */
const writes = () => sent.filter((request) => request.method !== "GET");

async function startWhatIf(mounted: HTMLElement): Promise<HTMLElement> {
  (await found<HTMLButtonElement>(mounted, 'button[data-what-if="start"]')).click();
  return found<HTMLElement>(mounted, "section[data-what-if]");
}

async function previewShown(mounted: HTMLElement): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const view = mounted.querySelector<HTMLElement>("[data-what-if-view]");
    if (view === null || view.querySelector('[role="tree"]') === null) throw new Error("no preview drawn");
    return view;
  });
}

const changed = (view: HTMLElement, which: string): string[] =>
  [...view.querySelectorAll(`[data-what-if-change="${which}"] [data-requirement-changed]`)].map(
    (element) => element.getAttribute("data-requirement-changed")!,
  );

it("previews another Track, marked as a what-if, with what would change, and writes nothing", async () => {
  const mounted = await mount();
  await served(mounted);
  const whatIf = await startWhatIf(mounted);
  // nothing tried yet is the real choice, so nothing is asked and the real Progress stays
  expect(mounted.textContent).toContain(t("en", "progressWhatIfSame"));
  expect(previews).toEqual([]);

  choose(whatIf.querySelector<HTMLSelectElement>('select[data-program-track="0"]')!, "ai");

  const view = await previewShown(mounted);
  expect(previews).toEqual([[{ requirementsFile: "cs-2027", track: "ai" }]]);
  expect(view.querySelector("[data-what-if-mark]")?.textContent).toBe(t("en", "progressWhatIfHeading"));
  expect(changed(view, "satisfied")).toEqual(["electives"]);
  expect(changed(view, "missing")).toEqual(["ai-core"]);
  expect(changed(view, "dropped")).toEqual([]);
  expect(view.textContent).toContain(t("en", "progressWhatIfSatisfied"));
  expect(view.querySelector('[role="treeitem"][data-requirement="ai-core"]')).not.toBeNull();
  // nothing in a what-if edits: no Pin control, and the tick is shown and not offered
  expect(view.querySelector("select[data-pin-course]")).toBeNull();
  expect(view.querySelector<HTMLInputElement>('input[data-tick="hebrew"]')!.disabled).toBe(true);
  // the real tree is not on screen beside it, so the two cannot be mistaken for each other
  expect(mounted.querySelectorAll('[role="tree"]')).toHaveLength(1);
  expect(writes()).toEqual([]);
});

it("compares in the lens shown", async () => {
  const mounted = await mount();
  await served(mounted);
  choose((await startWhatIf(mounted)).querySelector<HTMLSelectElement>('select[data-program-track="0"]')!, "ai");
  await previewShown(mounted);

  mounted.querySelector<HTMLButtonElement>('button[data-lens="projected"]')!.click();

  // with the Plan holding, the electives are met either way: only the AI core is new
  await vi.waitFor(() => {
    const view = mounted.querySelector<HTMLElement>("[data-what-if-view]")!;
    if (changed(view, "satisfied").length !== 0) throw new Error("still compared in the completed lens");
    expect(changed(view, "missing")).toEqual(["ai-core"]);
  });
});

it("adopts the previewed Track with one set-Programs edit, and shows the real Progress again", async () => {
  const mounted = await mount();
  await served(mounted);
  choose((await startWhatIf(mounted)).querySelector<HTMLSelectElement>('select[data-program-track="0"]')!, "ai");
  await previewShown(mounted);

  (await found<HTMLButtonElement>(mounted, 'button[data-what-if="adopt"]')).click();

  await readAfter("/api/programs");
  expect(writes()).toEqual([
    {
      method: "PUT",
      pathname: "/api/programs",
      body: { programs: [{ requirementsFile: "cs-2027", track: "ai" }], basedOn: "v1" },
    },
  ]);
  await vi.waitFor(() => {
    if (mounted.querySelector("section[data-what-if]") !== null) throw new Error("still in the what-if");
  });
  expect(mounted.querySelector("[data-what-if-view]")).toBeNull();
  expect(mounted.querySelector("[data-what-if-mark]")).toBeNull();
  expect(mounted.querySelector<HTMLSelectElement>('select[data-program-track="0"]')!.value).toBe("ai");
  expect(treeItem(mounted, "ai-core")).not.toBeNull();
});

it("stays in the what-if when adopting it is refused, and says why", async () => {
  const mounted = await mount();
  await served(mounted);
  choose((await startWhatIf(mounted)).querySelector<HTMLSelectElement>('select[data-program-track="0"]')!, "ai");
  await previewShown(mounted);
  refuseNextEdit = "state-file-changed";

  (await found<HTMLButtonElement>(mounted, 'button[data-what-if="adopt"]')).click();

  await vi.waitFor(() => {
    if (!(mounted.querySelector('[role="status"]')?.textContent ?? "").includes(t("en", "progressStale"))) {
      throw new Error("the refusal was not said");
    }
  });
  expect(mounted.querySelector("section[data-what-if]")).not.toBeNull();
});

it("leaves the what-if, back to the real Progress, having written nothing", async () => {
  const mounted = await mount();
  await served(mounted);
  choose((await startWhatIf(mounted)).querySelector<HTMLSelectElement>('select[data-program-track="0"]')!, "ai");
  await previewShown(mounted);

  (await found<HTMLButtonElement>(mounted, 'button[data-what-if="leave"]')).click();

  await vi.waitFor(() => {
    if (mounted.querySelector("[data-what-if-view]") !== null) throw new Error("the preview stayed");
  });
  expect(mounted.querySelector("section[data-what-if]")).toBeNull();
  expect(mounted.querySelector('[role="treeitem"][data-requirement="ai-core"]')).toBeNull();
  expect(mounted.querySelector("select[data-pin-course]")).not.toBeNull();
  expect(writes()).toEqual([]);
});

it("previews another Program, comparing nothing across files, and shows the Pins it would strand", async () => {
  pins = [{ courseNumber: "89-110", requirementId: "electives" }];
  const mounted = await mount();
  await served(mounted);

  choose((await startWhatIf(mounted)).querySelector<HTMLSelectElement>('select[data-program-file="0"]')!, "math-2027");

  const view = await previewShown(mounted);
  expect(previews).toEqual([[{ requirementsFile: "math-2027" }]]);
  expect(view.querySelector('[data-what-if-changes="math-2027"]')?.textContent).toBe(
    t("en", "progressWhatIfOtherProgram", { file: "math-2027" }),
  );
  expect(view.textContent).toContain(
    t("en", "progressWarnPinFileNotChosen", { course: "89-110", file: "cs-2027" }),
  );
  expect(writes()).toEqual([]);
});

it("marks the what-if in Hebrew, right to left", async () => {
  const mounted = await mount("he");
  await served(mounted);
  const whatIf = await startWhatIf(mounted);
  expect(whatIf.textContent).toContain(t("he", "progressWhatIfNote"));

  choose(whatIf.querySelector<HTMLSelectElement>('select[data-program-track="0"]')!, "ai");

  const view = await previewShown(mounted);
  expect(view.querySelector("[data-what-if-mark]")?.textContent).toBe(t("he", "progressWhatIfHeading"));
  expect(view.textContent).toContain(t("he", "progressWhatIfSatisfied"));
  const adopt = mounted.querySelector<HTMLElement>('button[data-what-if="adopt"]')!;
  const leave = mounted.querySelector<HTMLElement>('button[data-what-if="leave"]')!;
  // adopting comes first, which is the right in Hebrew
  expect(adopt.getBoundingClientRect().left).toBeGreaterThan(leave.getBoundingClientRect().left);
});

it("drops an open what-if once no Program is chosen any more, as after an undo", async () => {
  const mounted = await mount();
  await served(mounted);
  choose((await startWhatIf(mounted)).querySelector<HTMLSelectElement>('select[data-program-track="0"]')!, "ai");
  await previewShown(mounted);
  programs = []; // what another tab saved

  await mount("en", 1);

  await found(mounted, 'select[data-choose="file"]');
  expect(mounted.querySelector("[data-what-if-view]")).toBeNull();
  programs = [{ requirementsFile: "cs-2027" }];
  await mount("en", 2);
  await served(mounted);
  expect(mounted.querySelector("section[data-what-if]")).toBeNull();
});

it("offers a Cohort held further back than the form's years, as what it is", async () => {
  cohort = { academicYear: 1999, semester: "summer" };
  const mounted = await mount();
  await served(mounted);

  const year = await found<HTMLSelectElement>(mounted, "select[data-cohort-year]");
  expect(year.value).toBe("1999");
  expect(mounted.querySelector<HTMLSelectElement>("select[data-cohort-semester]")!.value).toBe("summer");
});

it("keeps a what-if's last Program, and offers adopting only what has been shown", async () => {
  const mounted = await mount();
  await served(mounted);
  const whatIf = await startWhatIf(mounted);
  // a what-if of no Program at all is not one: its last Program is changed, never removed
  expect(whatIf.querySelector<HTMLButtonElement>('button[data-program-remove="0"]')!.disabled).toBe(true);
  // nothing tried yet, so nothing to adopt
  expect(mounted.querySelector<HTMLButtonElement>('button[data-what-if="adopt"]')!.disabled).toBe(true);

  choose(whatIf.querySelector<HTMLSelectElement>('select[data-program-track="0"]')!, "ai");
  await previewShown(mounted);

  expect(mounted.querySelector<HTMLButtonElement>('button[data-what-if="adopt"]')!.disabled).toBe(false);
});

it("says a what-if of a Program held but not evaluated has nothing to compare with, not that it is not held", async () => {
  // the file could not be read for the real Progress, and could by the time the what-if was asked
  unreadableInReal = ["math-2027"];
  programs = [{ requirementsFile: "math-2027" }];
  const mounted = await mount();
  await found(mounted, '[data-program-row="0"]');
  const whatIf = await startWhatIf(mounted);

  choose(whatIf.querySelector<HTMLSelectElement>("select[data-program-add]")!, "cs-2027");
  whatIf.querySelector<HTMLButtonElement>("button[data-program-add-submit]")!.click();

  await previewShown(mounted);
  expect(mounted.querySelector('[data-what-if-changes="math-2027"]')?.textContent).toBe(
    t("en", "progressWhatIfNotEvaluated", { file: "math-2027" }),
  );
  expect(mounted.querySelector('[data-what-if-changes="cs-2027"]')?.textContent).toBe(
    t("en", "progressWhatIfOtherProgram", { file: "cs-2027" }),
  );
});
