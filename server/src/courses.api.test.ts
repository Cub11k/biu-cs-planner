import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

/**
 * `GET /api/courses` over a real temporary folder (#292): the Course names and credits the Plan
 * screen's cards draw, from a Requirements File first and the most recent Catalog after. Kept
 * beside `./api.test.ts` rather than in it, with the same harness, so the route this ticket adds is
 * tested without editing a file another lane holds. Course numbers and names are invented
 * (ADR-0006), except the one Raw Crawl row `./api.test.ts` imports too.
 */
let root: string;
let api: ReturnType<typeof createApi>;
const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";
const bearer = { Authorization: `Bearer ${TOKEN}` };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-courses-"));
  api = createApi({ workspace: fileSystemWorkspace(root), token: TOKEN, changes: { changeCount: () => 0 } });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const get = (path: string) => api.request(path, { headers: bearer });
const post = (path: string, body: unknown) =>
  api.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer },
    body: JSON.stringify(body),
  });

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

const CS = {
  schemaVersion: 1,
  program: { id: "cs", name: { he: "מדעי המחשב" } },
  courses: [
    { number: "89-110", credits: 6 },
    { number: "89-220", name: { he: "מבני נתונים", en: "Data Structures" }, credits: 5 },
  ],
  requirements: [],
};

it("knows no Course before there is a Workspace, and writes nothing", async () => {
  const answer = await get("/api/courses");

  expect(answer.status).toBe(200);
  await expect(answer.json()).resolves.toEqual({ courses: [] });
  expect(await readdir(root)).toEqual([]);
});

it("serves names and credits from a Requirements File, and a name it lacks from the Catalog", async () => {
  await post("/api/workspace", {});
  expect((await post("/api/requirements/import", { name: "cs-2027", file: CS })).status).toBe(200);
  expect((await post("/api/catalog/2027/import", CRAWL)).status).toBe(200);

  const answer = await get("/api/courses");

  expect(answer.status).toBe(200);
  await expect(answer.json()).resolves.toEqual({
    courses: [
      { courseNumber: "89-110", name: { he: "מבוא למדעי המחשב" }, credits: 6 },
      { courseNumber: "89-220", name: { he: "מבני נתונים", en: "Data Structures" }, credits: 5 },
    ],
  });
});

it("is refused without the launch token, and names no path", async () => {
  expect((await api.request("/api/courses")).status).toBe(401);

  await post("/api/workspace", {});
  await post("/api/requirements/import", { name: "cs-2027", file: CS });
  const text = await (await get("/api/courses")).text();
  expect(text).not.toContain(root);
  expect(text).not.toContain(await realpath(root));
  expect(text).not.toContain(".json");
});
