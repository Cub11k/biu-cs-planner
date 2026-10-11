import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isStateFileRevision } from "@biu-cs-planner/app";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

/**
 * #395: **an edit whose save landed never answers 500 because its view threw.** `./answer.test.ts`
 * is the same promise for a read that fails after the save; this is the view's own computation —
 * the solver, a check — throwing, which no Workspace double can make happen. So one check the
 * Timetable view runs, `variantWarnings`, is made to throw on request, and is `core`'s own until then.
 *
 * Its own file because the mock is module-wide, and `./api.test.ts` should not run under it.
 */
const broken = vi.hoisted(() => ({ view: false }));
vi.mock("@biu-cs-planner/core", async (original) => {
  const core = await original<typeof import("@biu-cs-planner/core")>();
  return {
    ...core,
    variantWarnings: (...args: Parameters<typeof core.variantWarnings>) => {
      if (broken.view) throw new Error("a check failed");
      return core.variantWarnings(...args);
    },
  };
});

const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";
const bearer = { Authorization: `Bearer ${TOKEN}` };
const TIMETABLE = "/api/timetable/2027/fall";
/** Fixture data is invented; 89-110 is a real BIU course number, nothing else is. */
const LECTURE = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

const roots: string[] = [];
afterEach(async () => {
  broken.view = false;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("answers a Pick whose view throws with the landed revision and Warnings, not a 500", async () => {
  const root = await mkdtemp(join(tmpdir(), "biu-no-view-"));
  roots.push(root);
  const api = createApi({ workspace: fileSystemWorkspace(root), token: TOKEN, changes: { changeCount: () => 0 } });
  const send = (method: string, path: string, body?: unknown) =>
    api.request(path, {
      method,
      headers: body === undefined ? bearer : { "Content-Type": "application/json", ...bearer },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await send("POST", "/api/workspace", {})).status).toBe(200);

  broken.view = true;
  const answer = await send("POST", `${TIMETABLE}/picks`, { ...LECTURE, basedOn: undefined });

  expect(answer.status).toBe(200);
  const body = (await answer.json()) as { noView?: boolean; version?: string; warnings?: unknown[] };
  expect(body).toEqual({ noView: true, version: expect.any(String), warnings: [] });
  expect(isStateFileRevision(body.version)).toBe(true);

  // the edit landed, at the revision the answer named
  broken.view = false;
  const after = (await (await send("GET", TIMETABLE)).json()) as { version: string; picks: unknown[] };
  expect(after.version).toBe(body.version);
  expect(after.picks).toEqual([LECTURE]);
});
