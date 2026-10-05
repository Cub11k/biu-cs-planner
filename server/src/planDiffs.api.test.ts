import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CURRENT_CATALOG_SCHEMA_VERSION, type Offering, type Semester } from "@biu-cs-planner/core";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

/**
 * Plan Diffs over HTTP (#295), against a real temp-dir Workspace holding a fixture Catalog: served
 * with every Timetable answer for the Variant asked for, applied one at a time by kind and Course,
 * refused when stale, and undone in one step.
 *
 * Its own file beside `./api.test.ts`, which every Timetable ticket also writes in: the routes are
 * the same contract, and the setup below is the one that file uses.
 *
 * Fixture data is invented. 89-110, 89-210 and 89-230 are real BIU course numbers, which Semester
 * each is given in is not, and no crawled data is committed to this repo (ADR-0006).
 */
const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";
const bearer = { Authorization: `Bearer ${TOKEN}` };

let root: string;
let api: ReturnType<typeof createApi>;

const offering = (courseNumber: string, ...semesters: Semester[]): Offering => ({
  courseNumber,
  nameHebrew: courseNumber,
  credits: { known: true, total: 5 },
  semesters,
  groups: [{ number: "01", lessonType: "הרצאה", lecturers: [], meetings: [] }],
  exams: { known: false, sittings: [] },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-plan-diffs-"));
  const workspace = fileSystemWorkspace(root);
  api = createApi({ workspace, token: TOKEN, changes: { changeCount: () => 0 } });
  await post("/api/workspace", {});
  await workspace.write(
    { kind: "catalog", academicYear: 2027 },
    {
      schemaVersion: CURRENT_CATALOG_SCHEMA_VERSION,
      academicYear: 2027,
      sources: [],
      offerings: [offering("89-110", "fall"), offering("89-210", "fall"), offering("89-230", "spring")],
    },
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const get = (path: string) => api.request(path, { headers: bearer });

const send = (method: string, path: string, body: unknown) =>
  api.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...bearer },
    body: JSON.stringify(body),
  });
const post = (path: string, body: unknown) => send("POST", path, body);

const TIMETABLE = "/api/timetable/2027/fall";
const APPLY = `${TIMETABLE}/plan-diffs/apply`;

type View = { planDiffs: Array<{ kind: string; courseNumber: string }>; version?: string; tray: unknown[] };

const read = async (path = TIMETABLE): Promise<View> => (await (await get(path)).json()) as View;
const version = async () => (await read()).version;

/** A planned Attempt of this Course in this Semester of 2027, added the way the Plan screen adds one. */
async function plan(courseNumber: string, semester: Semester = "fall"): Promise<string> {
  const answer = await post("/api/plan/attempts", {
    courseNumber,
    academicYear: 2027,
    semester,
    status: "planned",
    basedOn: await version(),
  });
  return ((await answer.json()) as { added: string }).added;
}

const attempts = async () =>
  ((await (await get("/api/plan")).json()) as { attempts: Array<{ courseNumber: string; semester: string; status: string }> })
    .attempts.map((a) => [a.courseNumber, a.semester, a.status]);

const kinds = (view: View) => view.planDiffs.map((diff) => [diff.kind, diff.courseNumber]);

it("serves the Plan Diffs of the Variant asked for with the Timetable", async () => {
  await plan("89-110");
  await plan("89-230");
  await post(`${TIMETABLE}/tray`, { courseNumber: "89-210", basedOn: await version() });
  await post(`${TIMETABLE}/variants`, { name: "B", basedOn: await version() });

  expect(kinds(await read(`${TIMETABLE}?variant=A`))).toEqual([
    ["drop", "89-110"],
    ["move", "89-230"],
    ["add", "89-210"],
  ]);
  expect(kinds(await read(`${TIMETABLE}?variant=B`))).toEqual([
    ["drop", "89-110"],
    ["move", "89-230"],
  ]);
});

it("serves no Plan Diffs at all without a Plan, and the week exactly as before", async () => {
  await post(`${TIMETABLE}/tray`, { courseNumber: "89-210", basedOn: await version() });

  const view = await read();

  expect(view.planDiffs).toEqual([]);
  expect(view.tray).toHaveLength(1);
});

it("applies each kind to the Plan, answering with the Timetable and the Plan Diffs left", async () => {
  await plan("89-110");
  await plan("89-230");
  await post(`${TIMETABLE}/tray`, { courseNumber: "89-210", basedOn: await version() });

  const added = await post(APPLY, { variant: "A", kind: "add", courseNumber: "89-210", basedOn: await version() });
  expect(added.status).toBe(200);
  expect(kinds((await added.json()) as View)).toEqual([
    ["drop", "89-110"],
    ["move", "89-230"],
  ]);

  const moved = await post(APPLY, { variant: "A", kind: "move", courseNumber: "89-230", basedOn: await version() });
  expect(kinds((await moved.json()) as View)).toEqual([["drop", "89-110"]]);

  const dropped = await post(APPLY, { variant: "A", kind: "drop", courseNumber: "89-110", basedOn: await version() });
  expect(dropped.status).toBe(200);
  expect(((await dropped.json()) as View).planDiffs).toEqual([]);

  expect(await attempts()).toEqual([
    ["89-230", "spring", "planned"],
    ["89-210", "fall", "planned"],
  ]);
});

it("never edits the Timetable when it applies a Plan Diff", async () => {
  await plan("89-110");
  await post(`${TIMETABLE}/tray`, { courseNumber: "89-210", basedOn: await version() });
  const before = await read();

  await post(APPLY, { kind: "add", courseNumber: "89-210", basedOn: before.version });
  await post(APPLY, { kind: "drop", courseNumber: "89-110", basedOn: await version() });

  const after = (await read()) as View & { picks: unknown; variants: unknown; blockedTimes: unknown };
  const { picks, variants, blockedTimes } = before as typeof after;
  expect({ picks: after.picks, variants: after.variants, blockedTimes: after.blockedTimes }).toEqual({
    picks,
    variants,
    blockedTimes,
  });
});

it("refuses a Plan Diff that is no longer there as stale, with the revision the file still holds", async () => {
  await plan("89-110");
  const basedOn = await version();

  const stale = await post(APPLY, { kind: "add", courseNumber: "89-110", basedOn });

  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toEqual({ reason: "plan-diff-stale", version: basedOn, warnings: [] });
  expect(await version()).toBe(basedOn);
  await expect((await get("/api/history")).json()).resolves.toMatchObject({ canUndo: true });
});

it("refuses an apply based on a revision the file no longer holds", async () => {
  await plan("89-110");
  const basedOn = await version();
  await plan("89-210");

  const refused = await post(APPLY, { kind: "drop", courseNumber: "89-110", basedOn });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ reason: "state-file-changed" });
});

it("undoes an apply in one step, under a label naming its kind", async () => {
  await plan("89-110");
  await plan("89-230");
  const before = await attempts();

  await post(APPLY, { kind: "move", courseNumber: "89-230", basedOn: await version() });
  const undone = await post("/api/history/undo", { basedOn: await version() });

  expect(undone.status).toBe(200);
  await expect(undone.json()).resolves.toMatchObject({ label: "apply-plan-diff-move" });
  expect(await attempts()).toEqual(before);
  expect(kinds(await read())).toEqual([
    ["drop", "89-110"],
    ["move", "89-230"],
  ]);
});

it("names a request that is not an apply as a 400, a not-offered kind among them", async () => {
  for (const body of [
    { kind: "not-offered", courseNumber: "89-110" },
    { kind: "add" },
    { kind: "add", courseNumber: "" },
    { kind: "rename", courseNumber: "89-110" },
  ]) {
    const answer = await post(APPLY, { ...body, basedOn: await version() });
    expect(answer.status).toBe(400);
    await expect(answer.json()).resolves.toEqual({ error: "not-a-plan-diff" });
  }
  const badYear = await post("/api/timetable/nope/fall/plan-diffs/apply", { kind: "add", courseNumber: "89-110" });
  expect(badYear.status).toBe(400);
});
