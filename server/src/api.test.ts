import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

let root: string;
let api: ReturnType<typeof createApi>;
/**
 * The Workspace's change counter, held by the test rather than by a real watcher: what the
 * route owes the page is the number it was given, and a real `fs.watch` would make that a
 * question about timing instead. The watcher itself is tested in ./workspace.fs.test.ts and
 * the settling in app/src/changes.test.ts.
 */
let changeCount: number;

/** Stands in for the launch token the CLI reads from the user config directory. */
const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-api-"));
  changeCount = 0;
  api = createApi({
    workspace: fileSystemWorkspace(root),
    token: TOKEN,
    changes: { changeCount: () => changeCount },
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
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

/** Every request the UI makes carries the token, so every request here does too. */
const bearer = { Authorization: `Bearer ${TOKEN}` };

const get = (path: string) => api.request(path, { headers: bearer });

const post = (path: string, body: unknown) =>
  api.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer },
    body: JSON.stringify(body),
  });

it("reports a folder that is not a Workspace, and creates it only when asked", async () => {
  const before = await get("/api/workspace");
  expect(before.status).toBe(200);
  await expect(before.json()).resolves.toEqual({
    ready: false,
    missing: ["catalogs", "requirements", "backups"],
  });

  const created = await post("/api/workspace", {});
  expect(created.status).toBe(200);
  await expect(created.json()).resolves.toEqual({ ready: true, missing: [] });
});

it("imports a Raw Crawl and then answers questions about the year", async () => {
  await post("/api/workspace", {});

  const imported = await post("/api/catalog/2027/import", CRAWL);
  expect(imported.status).toBe(200);
  await expect(imported.json()).resolves.toMatchObject({
    summary: { offerings: 1, groups: 1, meetings: 1, exams: 0 },
  });

  const listed = await get("/api/catalog/2027/offerings?semester=fall");
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as { offerings: Array<{ courseNumber: string }> };
  expect(body.offerings.map((o) => o.courseNumber)).toEqual(["89-110"]);

  const one = await get("/api/catalog/2027/offerings/89-110");
  expect(one.status).toBe(200);
  await expect(one.json()).resolves.toMatchObject({
    offering: { nameHebrew: "מבוא למדעי המחשב" },
  });
});

it("refuses to import into a folder that is not a Workspace yet", async () => {
  const response = await post("/api/catalog/2027/import", CRAWL);

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({ reason: "workspace-not-ready" });
});

it("says a year has no Catalog rather than pretending it is empty", async () => {
  await post("/api/workspace", {});

  const response = await get("/api/catalog/2030/offerings?semester=fall");

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    warnings: [{ kind: "no-catalog-for-year", academicYear: 2030 }],
  });
});

it("refuses a request body that is not the shape it expects", async () => {
  await post("/api/workspace", {});

  const response = await post("/api/catalog/2027/import", { rows: "not an array" });

  expect(response.status).toBe(400);
});

it("refuses a body carrying __proto__, whatever else it says", async () => {
  await post("/api/workspace", {});

  const response = await api.request("/api/catalog/2027/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer },
    body: '{"rows":[],"details":{},"__proto__":{"polluted":true}}',
  });

  expect(response.status).toBe(400);
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
});

it("refuses a body past the size cap", async () => {
  await post("/api/workspace", {});
  const huge = { rows: Array.from({ length: 200_000 }, () => CRAWL.rows[0]!), details: {} };

  const response = await post("/api/catalog/2027/import", huge);

  expect(response.status).toBe(413);
});

it("never names a file path in what it sends back", async () => {
  await post("/api/workspace", {});
  await post("/api/catalog/2027/import", CRAWL);
  await post("/api/timetable/2027/fall/picks", {
    courseNumber: "89-110",
    lessonType: "הרצאה",
    groupNumber: "01",
    meetings: [],
  });

  for (const path of [
    "/api/workspace",
    "/api/catalog/2027/offerings?semester=fall",
    "/api/catalog/2027/offerings/89-110",
    "/api/timetable/2027/fall",
  ]) {
    const text = await (await get(path)).text();
    expect(text).not.toContain(root);
    expect(text).not.toContain(".json");
    expect(text).not.toContain("catalogs/");
  }
});

it("answers a health check with no Workspace and no token, so a launcher can probe it", async () => {
  const response = await api.request("/api/health");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, catalogSchemaVersion: 1 });
});

it("says a folder with no Workspace has no Catalog, rather than failing", async () => {
  const response = await get("/api/catalog/2027/offerings?semester=fall");

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    warnings: [{ kind: "no-catalog-for-year", academicYear: 2027 }],
  });
});

it("404s an unknown route", async () => {
  expect((await get("/api/nope")).status).toBe(404);
});

it("carries a crawl's sections and meta through the schema, not just its rows", async () => {
  // The request schema strips unknown keys, so a Raw Crawl field it does not name is
  // dropped on the way in. This is the guard for that: credits and an English name can
  // only come from `sections`, and provenance only from `meta`.
  await post("/api/workspace", {});

  const imported = await post("/api/catalog/2027/import", {
    ...CRAWL,
    sections: { "808655": { points: "3.00", code: "89110-01", name_en: "Intro to Computers" } },
    meta: { scraped_at: "2026-09-13T13:53:03.017Z", label: "2027-cs", reported_total: 513 },
  });
  expect(imported.status).toBe(200);
  // provenance came from the meta block, so nothing is missing
  await expect(imported.json()).resolves.toMatchObject({ warnings: [] });

  const one = await get("/api/catalog/2027/offerings/89-110");
  await expect(one.json()).resolves.toMatchObject({
    offering: {
      nameEnglish: "Intro to Computers",
      credits: { known: true, total: 3 },
    },
  });
});

it("reports a Catalog that resolves outside the Workspace, rather than failing", async () => {
  const outside = await mkdtemp(join(tmpdir(), "biu-api-outside-"));
  try {
    await post("/api/workspace", {});
    await writeFile(join(outside, "secret.json"), JSON.stringify({ secret: "leaked" }));
    await symlink(join(outside, "secret.json"), join(root, "catalogs", "2027.json"));

    const listed = await get("/api/catalog/2027/offerings?semester=fall");
    expect(listed.status).toBe(409);
    const body = await listed.text();
    expect(JSON.parse(body)).toMatchObject({ warnings: [{ kind: "workspace-refused" }] });
    // and the refusal never hands back what was out there
    expect(body).not.toContain("leaked");

    const imported = await post("/api/catalog/2027/import", CRAWL);
    expect(imported.status).toBe(409);
    await expect(imported.json()).resolves.toEqual({ reason: "workspace-refused" });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it("reports a refusal the same way for one Offering as for a list", async () => {
  const outside = await mkdtemp(join(tmpdir(), "biu-api-outside-"));
  try {
    await post("/api/workspace", {});
    await writeFile(join(outside, "secret.json"), "{}");
    await symlink(join(outside, "secret.json"), join(root, "catalogs", "2027.json"));

    const one = await get("/api/catalog/2027/offerings/89-110");

    expect(one.status).toBe(409);
    await expect(one.json()).resolves.toMatchObject({
      warnings: [{ kind: "workspace-refused" }],
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it("caps the body on every write route, not only the import", async () => {
  const response = await api.request("/api/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer },
    body: JSON.stringify({ pad: "x".repeat(20 * 1024 * 1024) }),
  });

  expect(response.status).toBe(413);
});

it("says what is wrong with a stored Catalog it will not overwrite", async () => {
  await post("/api/workspace", {});
  await writeFile(join(root, "catalogs", "2027.json"), '{"hand":"edited badly"}');

  const response = await post("/api/catalog/2027/import", CRAWL);

  expect(response.status).toBe(409);
  // the reason alone leaves the student nothing to act on
  await expect(response.json()).resolves.toEqual({
    reason: "stored-catalog-unreadable",
    warnings: [{ kind: "file-unreadable" }],
  });
});

it("refuses every route but the health probe to a request with no token", async () => {
  await post("/api/workspace", {});

  for (const path of [
    "/api/workspace",
    "/api/catalog/2027/offerings?semester=fall",
    "/api/catalog/2027/offerings/89-110",
  ]) {
    const response = await api.request(path);
    expect(response.status, path).toBe(401);
  }

  const wrote = await api.request("/api/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(wrote.status).toBe(401);
});

it("refuses a request carrying somebody else's token", async () => {
  const response = await api.request("/api/workspace", {
    headers: { Authorization: "Bearer not-the-token-this-server-was-started-with" },
  });

  expect(response.status).toBe(401);
});

it("refuses a write from another site, and a write that is not JSON", async () => {
  const cross = await api.request("/api/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example", ...bearer },
    body: "{}",
  });
  expect(cross.status).toBe(403);

  const form = await api.request("/api/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...bearer },
    body: "x=1",
  });
  expect(form.status).toBe(415);

  // and the folder is still not a Workspace, so neither write went through
  await expect((await get("/api/workspace")).json()).resolves.toMatchObject({ ready: false });
});

it("never writes the token into the Workspace, which may be synced or committed", async () => {
  await post("/api/workspace", {});
  await post("/api/catalog/2027/import", CRAWL);

  const files = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const contents = await readFile(join(entry.parentPath, entry.name), "utf8");
    expect(contents, entry.name).not.toContain(TOKEN);
  }
});

/**
 * How the page hears that the Workspace changed under it. One integer behind the same guard
 * as everything else, asked for over the same typed client — see the route's own comment in
 * ./api.ts for why that, and not Server-Sent Events or a websocket.
 */
it("reports the Workspace's change count, and reports it again once it has moved", async () => {
  const before = await get("/api/workspace/changes");

  expect(before.status).toBe(200);
  await expect(before.json()).resolves.toEqual({ changeCount: 0 });

  changeCount = 3;
  const after = await get("/api/workspace/changes");

  await expect(after.json()).resolves.toEqual({ changeCount: 3 });
});

/** Not an open route: the count says the Workspace moved, which is the student's business. */
it("refuses the change count to a request with no launch token", async () => {
  const answer = await api.request("/api/workspace/changes");

  expect(answer.status).toBe(401);
});

/**
 * Picking a Group, through the API and onto the disk.
 *
 * The one that matters is the restart: a Pick is worth nothing if it lives in the server's
 * memory, so the API is built again over the same folder — which is all a restart is here,
 * since the server holds nothing but the Workspace path — and asked what it has.
 *
 * Fixture data is invented. 89-110 and 89-210 are real BIU course numbers, the Meetings are
 * not, and no crawled data is committed to this repo (ADR-0006).
 */
const LECTURE = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};
const OTHER_LECTURE = { ...LECTURE, groupNumber: "02" };
/** Overlaps LECTURE on Tuesday afternoon, so picking both is a Clash. */
const CLASHING = {
  courseNumber: "89-210",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "16:00", end: "17:00" }],
};

const TIMETABLE = "/api/timetable/2027/fall";
const PICKS = `${TIMETABLE}/picks`;

const remove = (path: string, body: unknown) =>
  api.request(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...bearer },
    body: JSON.stringify(body),
  });

/** A new server over the same folder: nothing of the old one's memory survives it. */
const restart = (): void => {
  api = createApi({
    workspace: fileSystemWorkspace(root),
    token: TOKEN,
    changes: { changeCount: () => changeCount },
  });
};

it("keeps a Pick across a restart, which is the whole point of a State File", async () => {
  await post("/api/workspace", {});

  const picked = await post(PICKS, LECTURE);
  expect(picked.status).toBe(200);
  await expect(picked.json()).resolves.toMatchObject({ picks: [LECTURE] });

  restart();

  const after = await get(TIMETABLE);
  expect(after.status).toBe(200);
  await expect(after.json()).resolves.toMatchObject({
    variantName: "A",
    picks: [LECTURE],
    clashes: [],
  });
});

it("serves an empty week before anything is picked, rather than failing", async () => {
  await post("/api/workspace", {});

  const response = await get(TIMETABLE);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ picks: [], clashes: [] });
});

it("replaces the Pick for a Lesson Type already picked", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);

  const again = await post(PICKS, OTHER_LECTURE);

  await expect(again.json()).resolves.toMatchObject({ picks: [OTHER_LECTURE] });
});

it("records a Pick that Clashes and reports the Clash, refusing nothing", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);

  const clashing = await post(PICKS, CLASHING);

  expect(clashing.status).toBe(200);
  const body = (await clashing.json()) as { picks: unknown[]; clashes: Array<{ kind: string }> };
  expect(body.picks).toHaveLength(2);
  expect(body.clashes).toHaveLength(1);
  expect(body.clashes[0]?.kind).toBe("meeting-meeting");
});

it("removes a Pick, and says so again when there is none left to remove", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);

  const slot = { courseNumber: LECTURE.courseNumber, lessonType: LECTURE.lessonType };
  const removed = await remove(PICKS, slot);
  expect(removed.status).toBe(200);
  await expect(removed.json()).resolves.toMatchObject({ picks: [] });

  const again = await remove(PICKS, slot);
  expect(again.status).toBe(200);
  await expect(again.json()).resolves.toMatchObject({ picks: [] });
});

/**
 * Every rejection this API makes is a named error with an explicit status, and there is no
 * unnamed 500 anywhere in it. The writer throws `StateFileUnwritableError` on a value its
 * schema would reject, and this is what keeps that unreachable: a body that is not a Pick
 * never reaches the domain, so no `State` is ever built from one (#80).
 */
it("names every bad Pick request as a 400, and never lets one become a 500", async () => {
  await post("/api/workspace", {});

  const bad: Array<[string, Response]> = [
    ["not-a-pick", await post(PICKS, { courseNumber: "89-110" })],
    ["not-a-pick", await post(PICKS, { ...LECTURE, meetings: [{ day: "funday" }] })],
    ["not-a-pick", await post(PICKS, "a string")],
    ["not-a-pick-slot", await remove(PICKS, { courseNumber: 89110 })],
    ["bad-year", await post("/api/timetable/nineteen/fall/picks", LECTURE)],
    ["bad-semester", await post("/api/timetable/2027/winter/picks", LECTURE)],
    ["bad-semester", await get("/api/timetable/2027/winter")],
  ];

  for (const [error, response] of bad) {
    expect(response.status, error).toBe(400);
    await expect(response.json(), error).resolves.toEqual({ error });
  }

  // and nothing was written: the State File does not exist
  expect((await readdir(root)).filter((name) => name.endsWith(".state.json"))).toEqual([]);
});

it("refuses a Pick body carrying __proto__ before the schema ever sees it", async () => {
  await post("/api/workspace", {});

  const response = await api.request(PICKS, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer },
    body: '{"courseNumber":"89-110","lessonType":"הרצאה","groupNumber":"01","meetings":[],"__proto__":{"polluted":true}}',
  });

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "unsafe-keys" });
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
});

it("will not overwrite a State File it could not read", async () => {
  await post("/api/workspace", {});
  // a hand edit, a half-synced file, or another tool's output
  await writeFile(join(root, "me.state.json"), '{"schemaVersion":99}', "utf8");

  const response = await post(PICKS, LECTURE);

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    reason: "state-file-unreadable",
    warnings: [{ kind: "schema-version-too-new", found: 99 }],
  });
  expect(await readFile(join(root, "me.state.json"), "utf8")).toBe('{"schemaVersion":99}');
});

it("refuses a Pick to a request with no launch token", async () => {
  await post("/api/workspace", {});

  const answer = await api.request(PICKS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(LECTURE),
  });

  expect(answer.status).toBe(401);
});
