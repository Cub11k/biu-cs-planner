import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { isStateFileRevision, type Workspace } from "@biu-cs-planner/app";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

/**
 * #324: **an edit whose save landed never answers 5xx because of a read made afterwards.**
 *
 * A Timetable edit builds its answer after the save, and the Tray's chips read the Catalog. A
 * Catalog read that fails with something other than a refusal used to propagate out of the route
 * as a 500, although the edit had been written — and the page then told the student it failed.
 * Here the adapter answers everything honestly until it is told to, and then throws on every
 * Catalog read, the way a failing disk or an adapter bug would.
 *
 * Its own file rather than a test in `./api.test.ts`, which another lane holds in the run this was
 * written in; it builds the API the same way that file does.
 */

const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";
const bearer = { Authorization: `Bearer ${TOKEN}` };

/** Fixture data is invented; 89-110 is a real BIU course number, nothing else is. */
const CRAWL = {
  rows: [
    {
      code: "89110",
      name: "מבוא למדעי המחשב",
      group: "01",
      teachers: "פרופ' נועה אגמון",
      kind: "הרצאה",
      semester: "סמסטר א'",
      day: "ג'",
      hours: "15:00 - 18:00",
      lid: "808655",
    },
  ],
  details: {},
};
const LECTURE = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};
const TIMETABLE = "/api/timetable/2027/fall";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function stage() {
  const root = await mkdtemp(join(tmpdir(), "biu-answer-"));
  roots.push(root);
  const real = fileSystemWorkspace(root);
  let failing = false;
  // Only the Catalog read fails, and not with a refusal: `read` is the port's method for every
  // file but the State File, which has its own, so the save itself goes through untouched.
  const workspace: Workspace = new Proxy(real, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (property !== "read" || typeof method !== "function") return method;
      return async (...args: unknown[]): Promise<unknown> => {
        if (failing) throw new Error("the disk is failing");
        return (method as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const api = createApi({ workspace, token: TOKEN, changes: { changeCount: () => 0 } });
  const send = async (method: string, path: string, body?: unknown): Promise<Response> =>
    await api.request(path, {
      method,
      headers: body === undefined ? bearer : { "Content-Type": "application/json", ...bearer },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const read = async () =>
    (await (await send("GET", TIMETABLE)).json()) as {
      version: string;
      picks: { groupNumber: string }[];
      tray: { courseNumber: string; known: boolean }[];
    };

  expect((await send("POST", "/api/workspace", {})).status).toBe(200);
  expect((await send("POST", "/api/catalog/2027/import", CRAWL)).status).toBe(200);
  expect((await send("POST", `${TIMETABLE}/picks`, { ...LECTURE, basedOn: undefined })).status).toBe(200);
  // the honest Tray, read off the Catalog, so `known: false` below is the failure's doing
  expect((await read()).tray).toEqual([expect.objectContaining({ courseNumber: "89-110", known: true })]);

  return { send, read, fail: () => (failing = true), recover: () => (failing = false) };
}

it("answers an edit that landed with its revision and an unknown Tray when the Catalog then throws", async () => {
  const { send, read, fail, recover } = await stage();
  const basedOn = (await read()).version;

  fail();
  const answer = await send("POST", `${TIMETABLE}/picks`, { ...LECTURE, groupNumber: "02", basedOn });

  expect(answer.status).toBe(200);
  const body = (await answer.json()) as Awaited<ReturnType<typeof read>>;
  expect(isStateFileRevision(body.version)).toBe(true);
  expect(body.version).not.toBe(basedOn);
  expect(body.picks).toEqual([expect.objectContaining({ groupNumber: "02" })]);
  // the part it could not read is marked, not left out and not made up
  expect(body.tray).toEqual([expect.objectContaining({ courseNumber: "89-110", known: false })]);

  // and the edit did land: the file holds it, at the revision the answer said
  recover();
  const after = await read();
  expect(after.version).toBe(body.version);
  expect(after.picks).toEqual([expect.objectContaining({ groupNumber: "02" })]);
});

it("does the same for every other Timetable edit, a Tray edit among them", async () => {
  const { send, read, fail } = await stage();
  const basedOn = (await read()).version;

  fail();
  const answer = await send("POST", `${TIMETABLE}/tray`, { courseNumber: "89-210", basedOn });

  expect(answer.status).toBe(200);
  expect(((await answer.json()) as { tray: { known: boolean }[] }).tray.every((e) => !e.known)).toBe(true);
});

/**
 * #344: the same, for the Programs and Progress edits. Each builds its answer by reading
 * `requirements/` after the save — listing it, then reading each file — and a read that fails with
 * something other than a refusal used to answer 500 for an edit that had been written.
 *
 * Here only those two port methods fail once told to; the State File has its own and the save goes
 * through untouched.
 */
const CS_REQUIREMENTS = {
  schemaVersion: 1,
  program: { id: "cs", name: { he: "מדעי המחשב", en: "Computer Science" } },
  cohorts: [{ academicYear: 2027, semester: "fall" }],
  courses: [{ number: "89-110", credits: 5 }],
  requirements: [
    { id: "intro", kind: "course", course: "89-110" },
    { id: "hebrew", kind: "manual", description: { he: "עברית", en: "Hebrew" } },
  ],
  tracks: [],
};

async function stageRequirements() {
  const root = await mkdtemp(join(tmpdir(), "biu-answer-"));
  roots.push(root);
  const real = fileSystemWorkspace(root);
  let failing = false;
  const workspace: Workspace = new Proxy(real, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if ((property !== "read" && property !== "list") || typeof method !== "function") return method;
      return async (...args: unknown[]): Promise<unknown> => {
        if (failing) throw new Error("the disk is failing");
        return (method as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const api = createApi({ workspace, token: TOKEN, changes: { changeCount: () => 0 } });
  const send = async (method: string, path: string, body?: unknown): Promise<Response> =>
    await api.request(path, {
      method,
      headers: body === undefined ? bearer : { "Content-Type": "application/json", ...bearer },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const version = async (): Promise<string> =>
    ((await (await send("GET", "/api/programs")).json()) as { version: string }).version;

  expect((await send("POST", "/api/workspace", {})).status).toBe(200);
  const imported = await send("POST", "/api/requirements/import", { name: "cs-2027", file: CS_REQUIREMENTS });
  expect(imported.status).toBe(200);
  const chosen = await send("PUT", "/api/programs", {
    programs: [{ requirementsFile: "cs-2027" }],
    basedOn: undefined,
  });
  expect(chosen.status).toBe(200);
  // the honest answer, so what follows is the failure's doing
  const honest = (await (await send("GET", "/api/progress")).json()) as { programs: { status: string }[] };
  expect(honest.programs.map((program) => program.status)).toEqual(["evaluated"]);

  return { send, version, fail: () => (failing = true), recover: () => (failing = false) };
}

it("answers a Programs or Cohort edit that landed with its revision when requirements/ then throws", async () => {
  const { send, version, fail, recover } = await stageRequirements();

  for (const [path, body] of [
    ["/api/programs", { programs: [{ requirementsFile: "cs-2027", track: "none-such" }] }],
    ["/api/cohort", { cohort: { academicYear: 2027, semester: "fall" } }],
  ] as const) {
    recover();
    const basedOn = await version();
    fail();
    const answer = await send("PUT", path, { ...body, basedOn });

    expect(answer.status, path).toBe(200);
    const served = (await answer.json()) as { version: string; programWarnings: { kind: string }[] };
    expect(isStateFileRevision(served.version), path).toBe(true);
    expect(served.version, path).not.toBe(basedOn);
    // the listing it could not make is marked, not left out and not made up
    expect(served.programWarnings, path).toEqual([{ kind: "requirements-unlisted" }]);

    // and the edit did land, at the revision the answer said
    recover();
    expect(await version(), path).toBe(served.version);
  }
});

it("answers a Pin or tick that landed with its revision when requirements/ then throws", async () => {
  const { send, version, fail, recover } = await stageRequirements();
  const pin = { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "intro" };
  const tick = { requirementsFile: "cs-2027", requirementId: "hebrew" };

  for (const [method, path, body] of [
    ["POST", "/api/progress/pins", pin],
    ["DELETE", "/api/progress/pins", pin],
    ["POST", "/api/progress/ticks", tick],
    ["DELETE", "/api/progress/ticks", tick],
  ] as const) {
    const where = `${method} ${path}`;
    recover();
    const basedOn = await version();
    fail();
    const answer = await send(method, path, { ...body, basedOn });

    expect(answer.status, where).toBe(200);
    const served = (await answer.json()) as { version: string; programWarnings: { kind: string }[] };
    expect(isStateFileRevision(served.version), where).toBe(true);
    expect(served.version, where).not.toBe(basedOn);
    expect(served.programWarnings, where).toEqual([{ kind: "requirements-unlisted" }]);

    recover();
    expect(await version(), where).toBe(served.version);
  }
});
