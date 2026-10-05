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
let programs: string[];
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

/** What the fake's stand-in evaluation makes of the Pins and the tick it holds. */
function progressBody(): unknown {
  const pinnedToElectives = pins.some((pin) => pin.courseNumber === "89-110" && pin.requirementId === "electives");
  const evaluation = (status: string, courses: string[], extra: object = {}) => ({ status, courses, ...extra });
  const tree = [
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
      completed: evaluation(pinnedToElectives ? "partial" : "missing", pinnedToElectives ? ["89-110"] : [], {
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
  ];
  return {
    programs: programs.map((requirementsFile) => ({
      requirementsFile,
      status: "evaluated",
      program: { id: "cs", name: { he: "מדעי המחשב", en: "Computer Science" } },
      progress: {
        requirements: tree,
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
    })),
    stoppedEarly,
    solverWarnings: [],
    programWarnings: [],
    pinWarnings: [],
    version: `v${version}`,
    warnings: stateWarnings,
  };
}

beforeEach(() => {
  sent = [];
  programs = ["cs-2027"];
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
    const { pathname } = new URL(url, location.href);
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
          { name: "notes", status: "not-requirements", warnings: [{ kind: "file-unreadable" }] },
        ],
      });
    }
    if (method !== "GET" && refuseNextEdit !== undefined) {
      const reason = refuseNextEdit;
      refuseNextEdit = undefined;
      version += 1; // somebody else wrote the file
      return json({ reason, warnings: [] }, 409);
    }
    if (pathname === "/api/programs" && method === "PUT") {
      programs = (body?.programs as Array<{ requirementsFile: string }>).map((p) => p.requirementsFile);
      version += 1;
      return json({ cohort: null, programs: body?.programs, programWarnings: [], version: `v${version}`, warnings: [] });
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
  expect([...file.options].map((option) => option.value)).toEqual(["", "cs-2027"]);
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
  programs = ["cs-2027", "math-2027"];
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
