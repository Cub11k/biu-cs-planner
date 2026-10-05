import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Workspace } from "@biu-cs-planner/app";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

/**
 * The Plan routes over HTTP, against a real temp-dir Workspace: what #352 added — each Semester's
 * credit total in the Plan answer, and New Plan from Suggested Layout for either Program of a double
 * major — and the `requirements-unlisted` marker #357 gave the Plan answer.
 *
 * Its own file beside `./api.test.ts`, which most tickets also write in: the routes are the same
 * contract, and the setup below is the one that file uses.
 *
 * Requirements Files and layouts are invented (ADR-0006); 89-110 and 89-120 are real BIU course
 * numbers and nothing else said of them here is.
 */
const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";
const bearer = { Authorization: `Bearer ${TOKEN}` };

let root: string;
let api: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-plan-api-"));
  api = createApi({ workspace: fileSystemWorkspace(root), token: TOKEN, changes: { changeCount: () => 0 } });
  expect((await send("POST", "/api/workspace", {})).status).toBe(200);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown) =>
  api.request(path, {
    method,
    headers: body === undefined ? bearer : { "Content-Type": "application/json", ...bearer },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type PlanBody = {
  attempts: { courseNumber: string; academicYear: number; semester: string }[];
  planWarnings: { kind: string; target: { semester?: string }; credits?: number }[];
  semesterCredits: { academicYear: number; semester: string; credits: number; unknown: number }[];
  version?: string;
};

const plan = async (): Promise<PlanBody> => (await (await send("GET", "/api/plan")).json()) as PlanBody;
const version = async () => (await plan()).version;

/** Imports a Requirements File the way the Workspace screen does. */
async function requirements(name: string, file: Record<string, unknown>): Promise<void> {
  const imported = await send("POST", "/api/requirements/import", {
    name,
    file: { schemaVersion: 1, program: { id: name, name: { he: name } }, ...file },
  });
  expect(imported.status).toBe(200);
}

async function choose(programs: { requirementsFile: string }[]): Promise<void> {
  expect((await send("PUT", "/api/programs", { programs, basedOn: await version() })).status).toBe(200);
}

it("serves each Semester's credit total, the number the credit-load Warning is about", async () => {
  await requirements("cs-2027", {
    courses: [
      { number: "89-110", credits: 5 },
      { number: "89-120", credits: 8, offeringPattern: "year-long" },
    ],
  });
  await choose([{ requirementsFile: "cs-2027" }]);
  expect((await send("PATCH", "/api/settings", { creditLoadLimit: 1, basedOn: await version() })).status).toBe(200);
  for (const [courseNumber, semester] of [
    ["89-120", "fall"],
    ["89-120", "spring"],
    ["89-110", "fall"],
  ] as const) {
    const added = await send("POST", "/api/plan/attempts", {
      courseNumber,
      academicYear: 2027,
      semester,
      status: "planned",
      basedOn: await version(),
    });
    expect(added.status).toBe(200);
  }

  const body = await plan();

  // the cards would say 8 + 5 and 8; the Year-long Course's halves share the year's 8
  expect(body.semesterCredits).toEqual([
    { academicYear: 2027, semester: "fall", credits: 9, unknown: 0 },
    { academicYear: 2027, semester: "spring", credits: 4, unknown: 0 },
  ]);
  expect(
    body.planWarnings.filter((w) => w.kind === "credit-load").map((w) => [w.target.semester, w.credits]),
  ).toEqual(body.semesterCredits.map((s) => [s.semester, s.credits]));
});

it("runs New Plan from Suggested Layout for either Program of a double major, the first by default", async () => {
  await requirements("cs-2027", { suggestedLayout: [{ studyYear: 1, semester: "fall", courses: ["89-110"] }] });
  await requirements("math-2027", { suggestedLayout: [{ studyYear: 1, semester: "spring", courses: ["88-101"] }] });
  await choose([{ requirementsFile: "cs-2027" }, { requirementsFile: "math-2027" }]);
  const cohort = { cohort: { academicYear: 2027, semester: "fall" }, basedOn: await version() };
  expect((await send("PUT", "/api/cohort", cohort)).status).toBe(200);

  const second = await send("POST", "/api/plan/suggested-layout", {
    requirementsFile: "math-2027",
    basedOn: await version(),
  });
  expect(second.status).toBe(200);
  expect(((await second.json()) as PlanBody).attempts.map((a) => [a.courseNumber, a.semester])).toEqual([
    ["88-101", "spring"],
  ]);

  const first = await send("POST", "/api/plan/suggested-layout", { basedOn: await version() });
  expect(first.status).toBe(200);
  expect(((await first.json()) as PlanBody).attempts.map((a) => [a.courseNumber, a.semester])).toEqual([
    ["88-101", "spring"],
    ["89-110", "fall"],
  ]);

  // a file that is not one of the student's Programs is not run, and nothing is written
  const before = await version();
  const other = await send("POST", "/api/plan/suggested-layout", { requirementsFile: "bio-2027", basedOn: before });
  expect(other.status).toBe(409);
  await expect(other.json()).resolves.toEqual({ reason: "program-not-chosen", version: before });
});

/**
 * #357: after a landed save whose `requirements/` read then fails, the Plan answer carries the new
 * revision (#344) and marks the folder unlisted, as the Programs and Progress answers do — on an
 * Attempt edit and on New Plan from Suggested Layout alike. The plain read marks a refused listing
 * too, and nothing when the folder lists.
 */
it("marks requirements/ unlisted on a Plan answer whose read of it failed after the save landed", async () => {
  const real = fileSystemWorkspace(root);
  // Armed, requirements/ fails from the moment the guarded writer reads the State File: New Plan
  // from Suggested Layout reads requirements/ before its edit too, and a failure there is a 500
  // that changed nothing. Between that read and the save the edit touches nothing that fails here,
  // so every failure this arms is one after the save has landed.
  let armed = false;
  let failing = false;
  const flaky: Workspace = new Proxy(real, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      if (property === "readStateFile") {
        return async (...args: unknown[]): Promise<unknown> => {
          const read = await (method as (...args: unknown[]) => Promise<unknown>).apply(target, args);
          if (armed) failing = true;
          return read;
        };
      }
      if (property !== "read" && property !== "list") return method;
      return async (...args: unknown[]): Promise<unknown> => {
        if (failing) throw new Error("the disk is failing");
        return (method as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  api = createApi({ workspace: flaky, token: TOKEN, changes: { changeCount: () => 0 } });
  await requirements("cs-2027", { suggestedLayout: [{ studyYear: 1, semester: "fall", courses: ["89-110"] }] });
  await choose([{ requirementsFile: "cs-2027" }]);
  expect((await send("PUT", "/api/cohort", { cohort: { academicYear: 2027, semester: "fall" }, basedOn: await version() })).status).toBe(200);
  await expect((await send("GET", "/api/plan")).json()).resolves.toMatchObject({ programWarnings: [] });

  for (const [method, path, body] of [
    ["POST", "/api/plan/attempts", { courseNumber: "88-101", academicYear: 2027, semester: "fall", status: "planned" }],
    ["POST", "/api/plan/suggested-layout", {}],
  ] as const) {
    failing = false;
    const basedOn = await version();
    armed = true;
    const answer = await send(method, path, { ...body, basedOn });

    expect(answer.status, path).toBe(200);
    const served = (await answer.json()) as PlanBody & { programWarnings: unknown[] };
    expect(served.programWarnings, path).toEqual([{ kind: "requirements-unlisted" }]);
    expect(served.version, path).not.toBe(basedOn);
    armed = false;
    failing = false;
    expect(await version(), path).toBe(served.version);
  }
});
