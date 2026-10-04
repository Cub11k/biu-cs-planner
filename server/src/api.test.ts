import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { settingsSchema } from "@biu-cs-planner/core";
import { createApi, savedSettingsSchema } from "./api.ts";
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

/**
 * #141, and the answer to the **first thing a student ever does with the app**.
 *
 * `create` cannot make a folder whose name a plain file already holds — `mkdir` answers
 * `EEXIST` — and until #141 nothing caught that: `createWorkspace` threw, the route had no arm,
 * and Hono's default handler answered a 500 with no body of this app's own. Measured on `dev`
 * at `8284a25` before the fix, this exact request was `500 Internal Server Error`.
 *
 * **Reachable with no permission trick**, which is why this is the case the ticket names: one
 * part of the layout is a plain file and another is genuinely missing, so `status` reports
 * not-ready, the student is offered the layout, and accepting it lands on the file. A read-only
 * folder and a full disk arrive at the same arm, and are what a `skipIf` would be needed for.
 *
 * Asserted through the routes rather than at the port, because the claim is about what a page
 * receives, and the GET either side of the POST is #141's fourth point: the same layout probe,
 * answering 200 before and after a refusal.
 *
 * The file's bytes afterwards prove that a refused create **replaced** nothing. They do not
 * prove that nothing was *made* — `create` has no rollback — and the comment on the assertion
 * below says exactly how far that second claim reaches.
 */
it("answers a create that cannot make the layout with a named 409, not a 500", async () => {
  await writeFile(join(root, "catalogs"), "not a folder");

  // the setup asserted rather than assumed: a Workspace this is offered the layout for, which
  // is what makes the create below the thing a student actually clicks
  const before = await get("/api/workspace");
  expect(before.status).toBe(200);
  await expect(before.json()).resolves.toEqual({
    ready: false,
    missing: ["requirements", "backups"],
  });

  const created = await post("/api/workspace", {});

  expect(created.status).toBe(409);
  await expect(created.json()).resolves.toEqual({ reason: "workspace-refused" });

  // The file is untouched, which is the part that holds for every refused create: `create`
  // never replaces what is already standing there.
  expect(await readFile(join(root, "catalogs"), "utf8")).toBe("not a folder");

  // And nothing was made — but **because `catalogs` is first in `WORKSPACE_LAYOUT`**. `create`
  // loops the layout with no rollback, so a refusal on a later part leaves the earlier ones
  // created. This asserts what a refused create does *here*, not a transactional promise the
  // adapter does not make; reorder the layout and this is the line that says so.
  const after = await get("/api/workspace");
  await expect(after.json()).resolves.toEqual({
    ready: false,
    missing: ["requirements", "backups"],
  });
});

/**
 * #130, and the api-level half of #121, whose comment on #130 wrote this test out with the
 * numbers measured rather than predicted.
 *
 * A Workspace can be **ready** and still be one a write cannot land in: `usablePath` asks
 * whether each folder of the layout resolves inside the Workspace and not what it is, so a
 * `catalogs` that is a plain file passes and `status` says ready. The write used to meet a raw
 * `ENOTDIR` under that file, which is a 500 — the one answer this API has no arm for. Asserted
 * through the routes rather than at the port, because the claim is about what a page receives,
 * and `server/src/workspace.fs.test.ts`'s sweep deliberately cannot make it: the backstop it
 * added wraps the `ENOTDIR` into a refusal too, so the sweep proves "nothing leaves untyped"
 * and not "this guard exists".
 *
 * It needs no permission trick either, so it runs everywhere rather than skipping visibly.
 */
it("answers a Catalog write into a ready Workspace whose catalogs is a file with a 409", async () => {
  await mkdir(join(root, "requirements"));
  await mkdir(join(root, ".backups"));
  await writeFile(join(root, "catalogs"), "not a folder");

  // the setup asserted rather than assumed: this is what makes the import below reachable
  const status = await get("/api/workspace");
  expect(status.status).toBe(200);
  await expect(status.json()).resolves.toEqual({ ready: true, missing: [] });

  const imported = await post("/api/catalog/2027/import", CRAWL);

  expect(imported.status).toBe(409);
  await expect(imported.json()).resolves.toEqual({ reason: "workspace-refused" });

  // and the file it would have written below is exactly as it was: the bytes, not just the
  // status code
  expect(await readFile(join(root, "catalogs"), "utf8")).toBe("not a folder");
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
    "/api/timetable/2027/fall/exams",
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

/**
 * #130's second half, and the Catalog's version of the test below the Picks. The one above is a
 * stored Catalog whose bytes are not a Catalog — `stored-catalog-unreadable`, with the file
 * Warnings that say what is wrong with it — and this is one whose bytes cannot be read, which is
 * the port's refusal and arrives as `workspace-refused` with nothing added. #116 closed the hole:
 * an unreadable stored Catalog used to read as a year with none, and an import would then merge
 * into nothing and write the result over a Catalog it had never read.
 *
 * Both routes that reach the file, for the reason the State File test gives: the import's arm and
 * the query's `notServed` are two different lines, and `notServed` is also where a refusal is
 * told from absence — a 404 here would be the API claiming a refused Catalog simply was not
 * there.
 *
 * A directory in the file's place again, so nothing is skipped on any runner (#130).
 */
it("answers a stored Catalog it cannot read with a 409, and never a 500 or a 404", async () => {
  await post("/api/workspace", {});
  await mkdir(join(root, "catalogs", "2027.json"));
  await writeFile(join(root, "catalogs", "2027.json", "inside.txt"), "a year's Offerings", "utf8");

  const imported = await post("/api/catalog/2027/import", CRAWL);
  expect(imported.status).toBe(409);
  await expect(imported.json()).resolves.toEqual({ reason: "workspace-refused" });

  const listed = await get("/api/catalog/2027/offerings?semester=fall");
  expect(listed.status).toBe(409);
  await expect(listed.json()).resolves.toMatchObject({
    warnings: [{ kind: "workspace-refused" }],
  });

  // the bytes, not just the status code: the import wrote nothing over what it could not read
  expect(await readdir(join(root, "catalogs", "2027.json"))).toEqual(["inside.txt"]);
  expect(await readFile(join(root, "catalogs", "2027.json", "inside.txt"), "utf8")).toBe(
    "a year's Offerings",
  );
});

it("refuses every route but the health probe to a request with no token", async () => {
  await post("/api/workspace", {});

  for (const path of [
    "/api/workspace",
    "/api/catalog/2027/offerings?semester=fall",
    "/api/catalog/2027/offerings/89-110",
    "/api/timetable/2027/fall/exams",
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

/**
 * Which revision of the State File the page is showing, read off the route that serves the
 * week. Every save carries one (docs/design.md, "External edits"), so every save below asks
 * for it the way the page does rather than assuming what it is.
 */
const currentVersion = async (): Promise<string | undefined> =>
  ((await (await get(TIMETABLE)).json()) as { version?: string }).version;

/** A save made the way the page makes one: on the revision the last answer carried. */
const save = async (path: string, body: object) =>
  post(path, { ...body, basedOn: await currentVersion() });

const unsave = async (path: string, body: object) =>
  remove(path, { ...body, basedOn: await currentVersion() });

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

  const again = await save(PICKS, OTHER_LECTURE);

  await expect(again.json()).resolves.toMatchObject({ picks: [OTHER_LECTURE] });
});

it("records a Pick that Clashes and reports the Clash, refusing nothing", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);

  const clashing = await save(PICKS, CLASHING);

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
  const removed = await unsave(PICKS, slot);
  expect(removed.status).toBe(200);
  await expect(removed.json()).resolves.toMatchObject({ picks: [] });

  const again = await unsave(PICKS, slot);
  expect(again.status).toBe(200);
  await expect(again.json()).resolves.toMatchObject({ picks: [] });
});

/**
 * The external-edit guard, over HTTP (#90). `docs/design.md`, "External edits": each save
 * carries the file version it was based on, and the server refuses the overwrite when the
 * file changed on disk meanwhile.
 */
it("serves the revision a page has to hand back, and takes it on the save", async () => {
  await post("/api/workspace", {});

  const empty = (await (await get(TIMETABLE)).json()) as { version?: string };
  // there is no file yet, so there is no revision: a first save is based on its absence
  expect(empty.version).toBeUndefined();

  const picked = await post(PICKS, { ...LECTURE, basedOn: undefined });
  expect(picked.status).toBe(200);
  const saved = (await picked.json()) as { version?: string };
  // the answer carries the revision it wrote, so the next click needs no re-read
  expect(saved.version).toMatch(/^[0-9a-f]{64}$/);
  expect(saved.version).toBe(await currentVersion());

  const second = await post(PICKS, { ...OTHER_LECTURE, basedOn: saved.version });
  expect(second.status).toBe(200);
});

it("refuses a save based on a revision the file no longer holds", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  const stale = await currentVersion();
  // Dropbox, git, an editor, or the other tab
  const file = join(root, "me.state.json");
  const fromOutside = await readFile(file, "utf8");
  await writeFile(file, fromOutside.replace('"01"', '"09"'), "utf8");

  const refused = await post(PICKS, { ...CLASHING, basedOn: stale });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toEqual({ reason: "state-file-changed", warnings: [] });
  // the other writer's Pick is the one in the file: nothing of theirs was overwritten
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({
    picks: [{ ...LECTURE, groupNumber: "09" }],
  });
});

/**
 * A save that names no revision is the claim that there is no file, so it can create one and
 * can never overwrite one. That is what makes a client which forgets to send the revision
 * fail closed, which is the only direction this may fail in.
 */
it("refuses a save that names no revision when a State File is already there", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);

  const forgetful = await post(PICKS, CLASHING);

  expect(forgetful.status).toBe(409);
  await expect(forgetful.json()).resolves.toMatchObject({ reason: "state-file-changed" });
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({ picks: [LECTURE] });
});

/** Removing a Pick is a save, so it is guarded identically rather than nearly so. */
it("guards removing a Pick exactly as it guards recording one", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);

  const refused = await remove(PICKS, {
    courseNumber: LECTURE.courseNumber,
    lessonType: LECTURE.lessonType,
    basedOn: "a revision this file never held",
  });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ reason: "state-file-changed" });
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({ picks: [LECTURE] });
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

it("will not overwrite a State File that is not even JSON", async () => {
  await post("/api/workspace", {});
  // a half-written file, or a sync that stopped mid-copy. The adapter hands back what it
  // found rather than inventing a stand-in, so the reader says "file-unreadable" and the
  // edit is refused — the one shape that could otherwise lose a whole Plan silently
  await writeFile(join(root, "me.state.json"), "{ not json at all", "utf8");

  const response = await post(PICKS, LECTURE);

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    reason: "state-file-unreadable",
    warnings: [{ kind: "file-unreadable" }],
  });
  expect(await readFile(join(root, "me.state.json"), "utf8")).toBe("{ not json at all");
});

/**
 * #130, and the last of #109's chain. The two tests above are a State File whose **bytes** are
 * not a State File; this is one whose bytes cannot be got at at all — and the two take different
 * paths. A file the schema rejects is `state-file-unreadable` from the reader, while a file the
 * port cannot read is the port's own `WorkspaceRefusedError`, which `app/src/edit.ts` maps to
 * `workspace-refused`. Reported as absent, that refusal let a save based on there being no file
 * overwrite one that was there all along (#109), and #109's second criterion — "the refusal is
 * one the API already turns into a 409 or a Warning rather than a 500" — was verified by reading
 * the four port call sites rather than by a test. Nothing failed if the boundary dropped its
 * `catch`, which is what this closes.
 *
 * **Every route the one file reaches**, because the arm is per route and not per file: the two
 * reads and the write each have their own, and a 409 on the write says nothing about the GET
 * beside it.
 *
 * A **directory in the file's place** rather than a mode bit, which is #130's own instruction:
 * it needs no permission trick, so this runs everywhere instead of skipping visibly as the
 * `chmod` tests in `./token.test.ts` and `./workspace.fs.test.ts` must. Root reads a file
 * whatever its mode says and reads no directory as a file, so there is no runner this passes
 * vacuously on.
 */
it("answers a State File it cannot read at all with a 409 on every route, not a 500", async () => {
  await post("/api/workspace", {});
  await mkdir(join(root, "me.state.json"));
  await writeFile(join(root, "me.state.json", "inside.txt"), "a student's data, somehow", "utf8");

  const picked = await post(PICKS, LECTURE);
  expect(picked.status).toBe(409);
  await expect(picked.json()).resolves.toEqual({ reason: "workspace-refused", warnings: [] });

  // the week and the preferences are read through two more call sites of the same port, and a
  // refused write would not tell us what either of them answers
  const week = await get(TIMETABLE);
  expect(week.status).toBe(409);
  await expect(week.json()).resolves.toEqual({ reason: "workspace-refused", warnings: [] });

  const settings = await get(SETTINGS);
  expect(settings.status).toBe(409);
  await expect(settings.json()).resolves.toEqual({ reason: "workspace-refused", warnings: [] });

  // and the exam period, which is the fourth route reaching this one file (#164). Listed here
  // rather than beside its own tests, because what is being swept is the file and not the route.
  const exams = await get(EXAMS);
  expect(exams.status).toBe(409);
  await expect(exams.json()).resolves.toEqual({ reason: "workspace-refused", warnings: [] });

  // the bytes and not just the status code: what stood where the State File belongs is exactly
  // as it was, which is the whole of what #109 was filed to protect
  expect(await readdir(join(root, "me.state.json"))).toEqual(["inside.txt"]);
  expect(await readFile(join(root, "me.state.json", "inside.txt"), "utf8")).toBe(
    "a student's data, somehow",
  );
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

it("refuses to record a Pick into a folder that is not a Workspace yet", async () => {
  const response = await post(PICKS, LECTURE);

  // a named 409, the way the import route answers it — never an unnamed 500
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({
    reason: "workspace-not-ready",
    warnings: [],
  });
});

/**
 * Undo and redo over HTTP, which is what #73 has to be demoable as: an edit, an undo and a
 * redo driven through the API and asserted against the file on disk.
 *
 * The stacks themselves — the bounds, invalidation, one history per State File — are
 * `./history.test.ts`. What is tested here is the contract: the paths name no file, the
 * answer says what moved and what is still available, and the revision comes back so the next
 * click needs no re-read.
 */
const UNDO = "/api/history/undo";
const REDO = "/api/history/redo";

/** An undo or a redo asked for the way a page asks: on the revision it is showing. */
const step = async (path: string) => post(path, { basedOn: await currentVersion() });

it("undoes an edit and redoes it, saying each time what moved and what is left", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  await expect((await get("/api/history")).json()).resolves.toEqual({
    canUndo: true,
    canRedo: false,
  });

  const undone = await step(UNDO);

  expect(undone.status).toBe(200);
  const answer = (await undone.json()) as { label: string; version?: string; at: number };
  // the label the use case supplied, for the UI to translate — never a sentence from here
  expect(answer.label).toBe("pick-group");
  expect(answer.version).toBe(await currentVersion());
  expect(answer.at).toEqual(expect.any(Number));
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({ picks: [] });
  await expect((await get("/api/history")).json()).resolves.toEqual({
    canUndo: false,
    canRedo: true,
  });

  const redone = await step(REDO);

  expect(redone.status).toBe(200);
  await expect(redone.json()).resolves.toMatchObject({
    label: "pick-group",
    canUndo: true,
    canRedo: false,
  });
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({ picks: [LECTURE] });
});

/**
 * ADR-0013: "The stack belongs to the State File, not to a browser tab … Two tabs on one file
 * share one history, which is the truth rather than a compromise." There is nothing to key a
 * stack to a tab by — `./token.ts` is one launch token for all of them — and this is that
 * being a feature: the second tab can undo what the first one did.
 */
it("shares one history between two clients on one State File", async () => {
  await post("/api/workspace", {});
  // the first tab picks, twice
  await post(PICKS, LECTURE);
  await save(PICKS, CLASHING);

  // the second tab, which has sent no edit of its own, sees both undos waiting and makes one
  await expect((await get("/api/history")).json()).resolves.toEqual({
    canUndo: true,
    canRedo: false,
  });
  const undoneByTheSecondTab = await step(UNDO);

  expect(undoneByTheSecondTab.status).toBe(200);
  await expect(undoneByTheSecondTab.json()).resolves.toMatchObject({
    label: "pick-group",
    canUndo: true,
    canRedo: true,
  });

  // the first tab sees the second one's undo: the redo it never asked for is offered to it,
  // and taking it walks the one stack back the other way
  await expect((await get("/api/history")).json()).resolves.toEqual({
    canUndo: true,
    canRedo: true,
  });
  const redoneByTheFirstTab = await step(REDO);

  expect(redoneByTheFirstTab.status).toBe(200);
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({
    picks: [LECTURE, CLASHING],
  });
  // and one stack, not two: the second undo is the first tab's earlier Pick, reachable from
  // either tab, and there is nothing under it
  await expect(step(UNDO)).resolves.toHaveProperty("status", 200);
  await expect(step(UNDO)).resolves.toHaveProperty("status", 200);
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({ picks: [] });
  const nothing = await step(UNDO);
  expect(nothing.status).toBe(409);
  await expect(nothing.json()).resolves.toMatchObject({ reason: "nothing-to-undo" });
});

/**
 * The same laundering `./history.test.ts` pins, over HTTP, because this is the shape that
 * costs a student somebody else's work: Dropbox writes while the page is idle, the change
 * poll reloads the view, they pick once more, and then they undo twice.
 */
it("empties the history when an edit follows a State File changed on disk", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  const file = join(root, "me.state.json");
  const fromOutside = (await readFile(file, "utf8")).replace('"01"', '"09"');
  await writeFile(file, fromOutside, "utf8");

  // the page reloads and picks again, which no guard refuses
  const picked = await save(PICKS, CLASHING);
  expect(picked.status).toBe(200);

  // only that Pick is on the stack now
  await expect((await get("/api/history")).json()).resolves.toEqual({
    canUndo: true,
    canRedo: false,
  });
  expect((await step(UNDO)).status).toBe(200);
  // the other writer's Pick is what the undo left behind, and there is nothing under it
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({
    picks: [{ ...LECTURE, groupNumber: "09" }],
  });
  const again = await step(UNDO);
  expect(again.status).toBe(409);
  await expect(again.json()).resolves.toMatchObject({ reason: "nothing-to-undo" });
});

/**
 * ADR-0013: "It does not survive a restart. The stack is in memory, and `.backups/` is the
 * durable record." The Pick does survive — that is what a State File is for — and the undo
 * of it does not.
 */
it("keeps the Pick across a restart and loses the undo of it", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);

  restart();

  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({ picks: [LECTURE] });
  await expect((await get("/api/history")).json()).resolves.toEqual({
    canUndo: false,
    canRedo: false,
  });
  const refused = await step(UNDO);
  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toEqual({
    reason: "nothing-to-undo",
    canUndo: false,
    canRedo: false,
    warnings: [],
  });
});

/**
 * A State File written from outside empties both stacks and nothing is written, so the change
 * the external-edit guard exists to protect survives an undo the student asks for after
 * reloading — the one case their own revision cannot catch, because it is current.
 */
it("refuses an undo after the State File changed on disk, and overwrites nothing", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  // Dropbox, git, an editor, or another tool
  const file = join(root, "me.state.json");
  const fromOutside = (await readFile(file, "utf8")).replace('"01"', '"09"');
  await writeFile(file, fromOutside, "utf8");

  // the page reloads first, so the revision it sends is the current one
  const refused = await step(UNDO);

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toEqual({
    reason: "history-invalidated",
    canUndo: false,
    canRedo: false,
    warnings: [],
  });
  expect(await readFile(file, "utf8")).toBe(fromOutside);
});

/** An undo is a save, so it is guarded on the revision the page was showing, exactly as one. */
it("refuses an undo based on a revision the file no longer holds", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  const stale = await currentVersion();
  await save(PICKS, OTHER_LECTURE);

  const refused = await post(UNDO, { basedOn: stale });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({
    reason: "state-file-changed",
    // the history is intact: it was the caller's view that was stale, not the file
    canUndo: true,
  });
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({ picks: [OTHER_LECTURE] });
});

it("names a bad undo request as a 400, and refuses one with no launch token", async () => {
  await post("/api/workspace", {});

  const notTheShape = await post(UNDO, { basedOn: 7 });
  expect(notTheShape.status).toBe(400);
  await expect(notTheShape.json()).resolves.toEqual({ error: "not-a-history-step" });

  const noToken = await api.request(UNDO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(noToken.status).toBe(401);
});

/**
 * The student's preferences over HTTP (#115): the two fields `core`'s `settingsSchema` has held
 * since the schema was written, reachable at last.
 *
 * The one that matters is the restart, exactly as it is for a Pick: a language that lives in a
 * page's `useState` is the bug this ticket is about, so the API is built again over the same
 * folder and asked what it holds. `docs/adr/0014-where-a-preference-is-kept.md` is why the
 * answer is in the State File rather than in the browser.
 */
const SETTINGS = "/api/settings";

const patch = (path: string, body: unknown) =>
  api.request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bearer },
    body: JSON.stringify(body),
  });

/** The revision the settings route serves, which a change made on them has to be based on. */
const settingsVersion = async (): Promise<string | undefined> =>
  ((await (await get(SETTINGS)).json()) as { version?: string }).version;

/** A change made the way a page makes one: on the revision the last answer carried. */
const choose = async (body: object) => patch(SETTINGS, { ...body, basedOn: await settingsVersion() });

it("serves the schema's defaults before any State File exists, and writes none", async () => {
  await post("/api/workspace", {});

  const response = await get(SETTINGS);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    language: "en",
    examSpacingDays: 3,
    warnings: [],
  });
  // reading created nothing: `version` was absent above, and the folder is still empty
  expect((await readdir(root)).sort()).toEqual([".backups", "catalogs", "requirements"]);
});

it("keeps a language across a restart, which is the whole of what #115 is about", async () => {
  await post("/api/workspace", {});

  const chosen = await choose({ language: "he" });

  expect(chosen.status).toBe(200);
  await expect(chosen.json()).resolves.toMatchObject({ language: "he" });

  restart();

  await expect((await get(SETTINGS)).json()).resolves.toMatchObject({ language: "he" });
});

it("serves the same revision the week does, since one file holds both", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);

  expect(await settingsVersion()).toBe(await currentVersion());
});

it("changes the preference named and leaves the other where it was", async () => {
  await post("/api/workspace", {});
  await choose({ examSpacingDays: 9 });

  await choose({ language: "he" });

  await expect((await get(SETTINGS)).json()).resolves.toMatchObject({
    language: "he",
    examSpacingDays: 9,
  });
});

/**
 * `examSpacingDays` is readable and writable by the same mechanism as the language, which was
 * #115's second criterion. What it reaches is asserted below, through the exam route #164 added.
 */
it("reads and writes the Exam spacing by the same route as the language", async () => {
  await post("/api/workspace", {});

  const chosen = await choose({ examSpacingDays: 14 });

  expect(chosen.status).toBe(200);
  await expect(chosen.json()).resolves.toMatchObject({ examSpacingDays: 14 });
  restart();
  await expect((await get(SETTINGS)).json()).resolves.toMatchObject({ examSpacingDays: 14 });
});

/**
 * #164's bound, at the edge it is a bound on.
 *
 * `examSpacingDays` is a count of calendar days, so the values a day count cannot have are
 * refused rather than stored: `savedSettingsSchema` takes each field's *type* from `core`'s own
 * `settingsSchema`, which now says whole and not negative, so a body carrying `-5` is not a
 * settings body and `bodyAs` answers the 400 every malformed settings body gets. **Not a named
 * 409 and not a clamp**: a clamp would store a number the student did not choose, and a refusal
 * of its own would be a reason `web`'s screen has to have a sentence for in both languages for a
 * control that does not exist yet (`docs/design.md` puts no Settings screen in front of this).
 * What a page reads today is `settingsNotDone` — "Your preference was not changed." / "ההעדפה לא
 * שונתה." — which `web/src/settings.ts` gives every answer that is not `ok` and carries no
 * reason, and which is true of this one.
 *
 * `0` is allowed, and `core/src/timetable/exams.test.ts` is where what it means is asserted: a
 * threshold of zero raises no spacing Warning, which is the student turning it off.
 */
it("refuses an Exam spacing a number of days cannot be, and stores nothing", async () => {
  await post("/api/workspace", {});

  // `-5` and `-1` are the Warning nothing could raise, `2.5` compares against whole-day gaps,
  // and `null` is what `JSON.stringify` writes for an infinity — the nearest a request body can
  // come to one, since JSON can write neither it nor `NaN`. The schema refuses those directly,
  // in `core/src/state/schema.test.ts`, which is the only place they can arrive at all.
  for (const examSpacingDays of [-5, -1, 2.5, null]) {
    const response = await choose({ examSpacingDays });
    expect(response.status, String(examSpacingDays)).toBe(400);
    await expect(response.json(), String(examSpacingDays)).resolves.toEqual({
      error: "not-settings",
    });
  }

  // nothing was stored by any of them: there is still no State File to have a revision, and the
  // preference reads as the default rather than as the last value refused
  expect(await settingsVersion()).toBeUndefined();
  await expect((await get(SETTINGS)).json()).resolves.toMatchObject({ examSpacingDays: 3 });

  // and zero goes through, because it is a threshold and not a mistake
  const off = await choose({ examSpacingDays: 0 });
  expect(off.status).toBe(200);
  await expect(off.json()).resolves.toMatchObject({ examSpacingDays: 0 });
});

/**
 * A State File that already holds a value the bound refuses still **opens** (#164's second
 * criterion). A bound in the schema is not a reason to lose a student's file: `core`'s reader
 * takes the settings one field at a time, so the field keeps its default and the read says which
 * field it could not read — exactly as it does for a spacing written as `"three"`, asserted
 * below. The Warning is the whole difference between this and a preference silently back at its
 * default.
 */
it("opens a State File holding an Exam spacing the bound refuses, and says which field", async () => {
  await post("/api/workspace", {});
  await writeFile(
    join(root, "me.state.json"),
    JSON.stringify({ schemaVersion: 1, settings: { language: "he", examSpacingDays: -5 } }),
  );

  const response = await get(SETTINGS);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    language: "he",
    examSpacingDays: 3,
    warnings: [{ kind: "settings-unreadable", field: "examSpacingDays" }],
  });
  // the file is the student's and was not rewritten by the reading of it
  expect(JSON.parse(await readFile(join(root, "me.state.json"), "utf8"))).toMatchObject({
    settings: { examSpacingDays: -5 },
  });
});

/**
 * A crawl whose detail records carry Exams, two days apart. The rows are the two Courses
 * `LECTURE` and `CLASHING` pick, so the Picks below are the ones the rest of this file makes.
 * Invented, as every fixture here is: no crawled data is committed to this repo (ADR-0006).
 */
const examCrawl = (secondExam: string) => ({
  rows: [
    CRAWL.rows[0]!,
    { ...CRAWL.rows[0]!, code: "89210", name: "אלגברה לינארית", lid: "900001" },
  ],
  details: {
    "89110|סמסטר א'": { terms: [{ type: "מועד א'", date: "21/01/2027", hour: "09:00" }] },
    "89210|סמסטר א'": { terms: [{ type: "מועד א'", date: secondExam, hour: "09:00" }] },
  },
});

const EXAMS = `${TIMETABLE}/exams`;

/**
 * The two Courses picked, with their Exams `gap` days apart, and the exam period readable
 * afterwards.
 *
 * The gap is a parameter because each direction of the threshold needs its own: a pair two days
 * apart is warned about at three and silent at two, and a pair five days apart is silent at three
 * and warned about at seven. A test that widened the threshold over a pair already inside it
 * would pass whether the stored threshold reached the check or not.
 */
const examPeriodAfterPicking = async (gap: { secondExam: string }): Promise<void> => {
  await post("/api/workspace", {});
  const imported = await post("/api/catalog/2027/import", examCrawl(gap.secondExam));
  expect(imported.status).toBe(200);
  await expect(imported.json()).resolves.toMatchObject({ summary: { exams: 2 } });

  expect((await post(PICKS, LECTURE)).status).toBe(200);
  expect((await save(PICKS, CLASHING)).status).toBe(200);
};

/** Two days apart: a spacing Warning at the design's three, silent at two. */
const TWO_DAYS = { secondExam: "23/01/2027" };
/** Five days apart: silent at three, a spacing Warning once a student asks for a week. */
const FIVE_DAYS = { secondExam: "26/01/2027" };

/**
 * **The criterion the whole of #164 turns on**: a student's stored threshold reaches
 * `checkExams`. `docs/design.md` has said "fewer than 3 days apart (adjustable in settings)"
 * since the design was written, and until this route the adjustment changed nothing a student
 * could see — the setting was readable and writable (#115) and no caller passed it to the check.
 *
 * Two Exams two days apart are a spacing Warning at three days and nothing at all at two, and
 * the only thing that changes between the two reads is the preference in the State File.
 */
it("checks the Exams at the threshold the student stored, and changes when they change it", async () => {
  await examPeriodAfterPicking(TWO_DAYS);

  const atThree = await get(EXAMS);
  expect(atThree.status).toBe(200);
  await expect(atThree.json()).resolves.toMatchObject({
    // the Variant this rail is about, so a page can see it is the one the grid shows
    variantName: "A",
    spacingDays: 3,
    exams: {
      sittings: [
        // the first sitting has nothing before it, which `RailSitting` spells as `undefined` —
        // and JSON has no `undefined`, so the key is simply absent rather than being sent as a
        // `null` a page would then have to read as a second way of saying the same thing
        { courseNumber: "89-110", date: "2027-01-21" },
        { courseNumber: "89-210", date: "2027-01-23", daysSincePrevious: 2 },
      ],
      warnings: [{ kind: "exam-spacing" }, { kind: "exam-spacing" }],
      coursesWithUnknownExams: 0,
    },
    warnings: [],
    catalogWarnings: [],
  });

  const chosen = await choose({ examSpacingDays: 2 });
  expect(chosen.status).toBe(200);

  const atTwo = await get(EXAMS);
  expect(atTwo.status).toBe(200);
  await expect(atTwo.json()).resolves.toMatchObject({
    spacingDays: 2,
    exams: { warnings: [], coursesWithUnknownExams: 0 },
  });
});

/**
 * The other direction, over a gap the default is **silent** about: five days apart raises nothing
 * at three, so the Warnings below can only be the stored seven arriving at the check. Asserted
 * before as well as after, because "it warns now" says nothing without "it did not warn then".
 */
it("widens the Exam check when the student widens the threshold", async () => {
  await examPeriodAfterPicking(FIVE_DAYS);

  await expect((await get(EXAMS)).json()).resolves.toMatchObject({
    spacingDays: 3,
    exams: { warnings: [] },
  });

  await choose({ examSpacingDays: 7 });

  await expect((await get(EXAMS)).json()).resolves.toMatchObject({
    spacingDays: 7,
    exams: { warnings: [{ kind: "exam-spacing" }, { kind: "exam-spacing" }] },
  });
});

/**
 * A picked Course the Catalog cannot answer for is counted rather than left out, so the rail can
 * admit the picture is partial, and the Catalog's own Warning says why. Two Warning lists and not
 * one: `warnings` is about the State File and `catalogWarnings` about the Catalog, whose `kind`s
 * overlap.
 */
it("says how many picked Courses it has no Exams for, and why", async () => {
  await post("/api/workspace", {});
  expect((await post(PICKS, LECTURE)).status).toBe(200);

  const response = await get(EXAMS);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    exams: { sittings: [], warnings: [], coursesWithUnknownExams: 1 },
    warnings: [],
    catalogWarnings: [{ kind: "no-catalog-for-year", academicYear: 2027 }],
  });
});

/**
 * The exam period is read out of the State File, so it is refused exactly as the week is when
 * that file cannot be read — and a bad year or Semester is the same 400 the week answers, since
 * both routes parse their path through `timetableRef`.
 */
it("refuses the exam period the way the week does, and never with a 500", async () => {
  await post("/api/workspace", {});
  await writeFile(join(root, "me.state.json"), '{"schemaVersion":99}', "utf8");

  const refused = await get(EXAMS);
  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({
    reason: "state-file-unreadable",
    warnings: [{ kind: "schema-version-too-new", found: 99 }],
  });

  for (const [error, path] of [
    ["bad-year", "/api/timetable/nineteen/fall/exams"],
    ["bad-semester", "/api/timetable/2027/winter/exams"],
  ]) {
    const response = await get(path!);
    expect(response.status, path).toBe(400);
    await expect(response.json(), path).resolves.toEqual({ error });
  }
});

/**
 * **A preference change can fail**, which is the consequence of keeping a preference in a guarded
 * document and the thing the screen has to have an answer for. Another tab, an editor, git or
 * Dropbox wrote the file between the read this change was based on and this save.
 */
it("refuses a change based on a revision the file no longer holds", async () => {
  await post("/api/workspace", {});
  await choose({ language: "he" });
  const stale = await settingsVersion();
  // somebody else writes the file, so `stale` is no longer what it holds
  await post(PICKS, { ...LECTURE, basedOn: stale });

  const refused = await patch(SETTINGS, { language: "en", basedOn: stale });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ reason: "state-file-changed" });
  // and the change did not happen
  await expect((await get(SETTINGS)).json()).resolves.toMatchObject({ language: "he" });
});

it("refuses a change that names no revision when a State File is already there", async () => {
  await post("/api/workspace", {});
  await choose({ language: "he" });

  // absent `basedOn` is the claim that there is no file, which fails closed
  const refused = await patch(SETTINGS, { language: "en" });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ reason: "state-file-changed" });
  await expect((await get(SETTINGS)).json()).resolves.toMatchObject({ language: "he" });
});

/**
 * ADR-0013, "One stack covers the document, minus settings … folding them in would let undoing a
 * Pick flip the UI language." Both halves asserted, because only one of them is obvious:
 *
 *   - a preference change adds **no** undo entry, so `canUndo` does not move;
 *   - the undo that was already waiting still works **afterwards**, which is the half that would
 *     break silently. The stack hears the revision every save wrote, a settings save included;
 *     one it had not heard about would leave it believing the revision before, and the next undo
 *     would read a file carrying a revision the stack never wrote and drop the whole history as
 *     though something outside the app had edited it.
 */
it("adds no undo entry for a preference, and leaves the undo that was waiting usable", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  await expect((await get("/api/history")).json()).resolves.toEqual({
    canUndo: true,
    canRedo: false,
  });

  const chosen = await choose({ language: "he" });
  expect(chosen.status).toBe(200);

  // the preference is not a step: still exactly the one Pick to undo, and nothing to redo
  await expect((await get("/api/history")).json()).resolves.toEqual({
    canUndo: true,
    canRedo: false,
  });

  const undone = await step(UNDO);

  expect(undone.status).toBe(200);
  await expect(undone.json()).resolves.toMatchObject({ label: "pick-group" });
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({ picks: [] });
  // and undoing the Pick did not take the language with it (ADR-0013's own example)
  await expect((await get(SETTINGS)).json()).resolves.toMatchObject({ language: "he" });
  await expect((await get("/api/history")).json()).resolves.toEqual({
    canUndo: false,
    canRedo: true,
  });
});

/**
 * The Warning `core` already produces, reaching the page instead of being dropped at the
 * boundary. `core/src/state/file.ts` reads the settings one field at a time, so a corrupted Exam
 * spacing costs that field and not the language beside it — and names the field it lost.
 */
it("carries the settings-unreadable Warning, naming the field it could not read", async () => {
  await post("/api/workspace", {});
  await writeFile(
    join(root, "me.state.json"),
    JSON.stringify({ schemaVersion: 1, settings: { language: "he", examSpacingDays: "three" } }),
  );

  const response = await get(SETTINGS);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    language: "he",
    examSpacingDays: 3,
    warnings: [{ kind: "settings-unreadable", field: "examSpacingDays" }],
  });
});

it("refuses to write a preference into a folder that is not a Workspace yet", async () => {
  const refused = await patch(SETTINGS, { language: "he" });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ reason: "workspace-not-ready" });
  // and reading is still served, so a student who has not accepted the layout sees a language
  await expect((await get(SETTINGS)).json()).resolves.toMatchObject({ language: "en" });
});

it("will not overwrite a State File it could not read for the sake of one preference", async () => {
  await post("/api/workspace", {});
  await writeFile(join(root, "me.state.json"), '{"hand":"edited badly"}');

  const refused = await patch(SETTINGS, { language: "he" });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ reason: "state-file-unreadable" });
  await expect(readFile(join(root, "me.state.json"), "utf8")).resolves.toBe(
    '{"hand":"edited badly"}',
  );
});

it("names every bad settings request as a 400, and never lets one become a 500", async () => {
  await post("/api/workspace", {});

  for (const body of [
    { language: "fr" },
    { language: 7 },
    { examSpacingDays: "three" },
    { basedOn: 7 },
  ]) {
    const response = await patch(SETTINGS, body);
    expect(response.status, JSON.stringify(body)).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "not-settings" });
  }

  const notJson = await api.request(SETTINGS, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bearer },
    body: "{",
  });
  expect(notJson.status).toBe(400);
  await expect(notJson.json()).resolves.toEqual({ error: "body-not-json" });

  // and nothing was written by any of them: there is still no State File to have a revision
  expect(await settingsVersion()).toBeUndefined();
});

it("refuses a settings body carrying __proto__ before the schema ever sees it", async () => {
  await post("/api/workspace", {});

  const response = await patch(SETTINGS, JSON.parse('{"language":"he","__proto__":{"x":1}}'));

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "unsafe-keys" });
});

it("refuses the settings routes to a request with no launch token", async () => {
  await post("/api/workspace", {});

  expect((await api.request(SETTINGS)).status).toBe(401);
  const wrote = await api.request(SETTINGS, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "he" }),
  });
  expect(wrote.status).toBe(401);
});

it("caps the settings body as it caps every other write", async () => {
  await post("/api/workspace", {});

  const response = await patch(SETTINGS, { language: "he", pad: "x".repeat(20 * 1024 * 1024) });

  expect(response.status).toBe(413);
});

/**
 * Choosing what is already chosen answers with the revision the file still holds, so the page's
 * next change is based on something. **This does not prove that nothing was written**, and the
 * title does not claim it: the revision is a hash of the file's bytes, so an identical rewrite
 * would leave it equal. That nothing was written is asserted where it can be —
 * `app/src/settings.test.ts`, against a Workspace double that counts its writes.
 */
it("answers an unchanged choice with the revision the file still holds", async () => {
  await post("/api/workspace", {});
  await choose({ language: "he" });
  const before = await settingsVersion();

  const again = await choose({ language: "he" });

  expect(again.status).toBe(200);
  await expect(again.json()).resolves.toMatchObject({ language: "he", version: before });
});

/**
 * The canary for `savedSettingsSchema`, which names the two fields rather than deriving them.
 *
 * A preference added to `core`'s `settingsSchema` and not to that schema would be a field the
 * State File holds and no route can set — readable, unwritable, and silent. This is the line that
 * says so. If it fails: add the field to `savedSettingsSchema` in `./api.ts`, unwrapping its
 * default the way the two beside it do, and give it a test above.
 */
it("accepts every preference the State File schema holds, and no route-only extra", () => {
  // The property the docstring promises, asserted rather than pinned: the body's fields are exactly
  // the State File's, plus the revision every write carries. An earlier version of this test pinned
  // `settingsSchema`'s keys instead, which caught a new preference but said nothing at all about the
  // route — the second half of this title was asserted nowhere.
  const body = Object.keys(savedSettingsSchema.shape).filter((field) => field !== "basedOn");

  expect(body).toEqual(Object.keys(settingsSchema.shape));
});

/**
 * `.backups/` over the wire (#67): the listing behind "backups and restore" on the Workspace
 * screen, and the restore behind it.
 *
 * **Nothing in `web` calls either route yet.** The Workspace screen does not exist — only the
 * Timetable does — so #67 built the use case and the route and said so rather than building a
 * screen it was not asked for. These are the contract the screen will be written against.
 */

const BACKUPS = "/api/backups";
const RESTORE = "/api/backups/restore";

/** The moments the listing reports, which is all a snapshot is named by (ADR-0002). */
const snapshotMoments = async (): Promise<number[]> => {
  const listed = (await (await get(BACKUPS)).json()) as { snapshots: { takenAt: number }[] };
  return listed.snapshots.map((snapshot) => snapshot.takenAt);
};

it("serves no snapshots for a Workspace that has saved once, and some after a second save", async () => {
  await post("/api/workspace", {});

  await post(PICKS, LECTURE);
  // the first save replaced nothing, so it copied nothing
  expect(await snapshotMoments()).toEqual([]);

  await save(PICKS, CLASHING);

  const moments = await snapshotMoments();
  expect(moments).toHaveLength(1);
  // a moment and nothing else: no name, no path, no size
  const listed = (await (await get(BACKUPS)).json()) as { snapshots: object[] };
  expect(Object.keys(listed.snapshots[0] as object)).toEqual(["takenAt"]);
  expect(moments[0]).toEqual(expect.any(Number));
});

it("answers a listing of a folder that is not a Workspace with an empty list, not a refusal", async () => {
  // no `.backups/` at all, which is "there are none" and not "I could not look"
  const answer = await get(BACKUPS);

  expect(answer.status).toBe(200);
  await expect(answer.json()).resolves.toEqual({ snapshots: [] });
});

it("restores a snapshot and answers with the revision it wrote", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  await save(PICKS, CLASHING);
  const [takenAt] = await snapshotMoments();

  const restored = await post(RESTORE, { takenAt, basedOn: await currentVersion() });

  expect(restored.status).toBe(200);
  await expect(restored.json()).resolves.toEqual({
    kind: "restored",
    takenAt,
    version: await currentVersion(),
    warnings: [],
  });
  // the week is back to the one Pick the snapshot held
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({ picks: [LECTURE] });
});

/** A restore is an edit, so it is on the undo stack like any other (ADR-0013). */
it("puts a restore on the undo stack, under its own label", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  await save(PICKS, CLASHING);
  const [takenAt] = await snapshotMoments();

  await post(RESTORE, { takenAt, basedOn: await currentVersion() });
  const undone = await step(UNDO);

  expect(undone.status).toBe(200);
  await expect(undone.json()).resolves.toMatchObject({ label: "restore-backup" });
  // undoing the restore puts both Picks back
  await expect((await get(TIMETABLE)).json()).resolves.toMatchObject({
    picks: [LECTURE, CLASHING],
  });
});

it("answers a snapshot that is not there with a named 409, not a 404 and not a 500", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);

  const refused = await post(RESTORE, { takenAt: 1, basedOn: await currentVersion() });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toEqual({ reason: "backup-not-found", warnings: [] });
});

it("answers a restore into a folder that is not a Workspace with a named 409", async () => {
  const refused = await post(RESTORE, { takenAt: 1, basedOn: undefined });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ reason: "workspace-not-ready" });
});

/**
 * A restore is a save and carries the revision it was based on, exactly as a Pick and an undo
 * do: a client that leaves it out claims there is no State File, which fails closed (#90).
 */
it("refuses a restore based on a revision the file no longer holds", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  await save(PICKS, CLASHING);
  const [takenAt] = await snapshotMoments();
  const stale = await currentVersion();
  // somebody else writes the file in between
  await writeFile(join(root, "me.state.json"), JSON.stringify({ schemaVersion: 1 }), "utf8");

  const refused = await post(RESTORE, { takenAt, basedOn: stale });

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ reason: "state-file-changed" });
});

it("refuses a body that is not a restore, by name, before the domain sees it", async () => {
  await post("/api/workspace", {});

  for (const body of [{}, { takenAt: "yesterday" }, { takenAt: 1.5 }, { takenAt: null }]) {
    const refused = await post(RESTORE, body);
    expect(refused.status, JSON.stringify(body)).toBe(400);
    await expect(refused.json()).resolves.toEqual({ error: "not-a-restore" });
  }
});

/**
 * The rule every route on this contract keeps: domain operations and never a file path
 * (ADR-0002; docs/design.md, "API and data rules", rule 1). A snapshot is named by when it was
 * taken, and nothing in either answer says where it lives.
 */
it("names no path in either answer, and no State File", async () => {
  await post("/api/workspace", {});
  await post(PICKS, LECTURE);
  await save(PICKS, CLASHING);
  const [takenAt] = await snapshotMoments();

  const listed = await (await get(BACKUPS)).text();
  const restored = await (await post(RESTORE, { takenAt, basedOn: await currentVersion() })).text();

  for (const body of [listed, restored]) {
    expect(body).not.toContain(root);
    expect(body).not.toContain(".backups");
    expect(body).not.toContain("state.json");
  }
});

/**
 * #216, and the guarantee `CLAUDE.md` states in one line: **"The API exposes domain operations,
 * never file paths."**
 *
 * **The two tests above and the one near the top of this file are about *success* bodies.** Both
 * assert that a Workspace that is working names no path in what it serves, and neither provokes a
 * refusal — so the answer that was actually carrying one was never looked at. A refusal out of
 * `server/src/workspace.fs.ts` worded itself `refusing ./catalogs/2027.json: …`, the
 * Workspace-relative spelling of the target, and `app/src/queries.ts` puts a refusal's message
 * straight onto the `reason` of a `workspace-refused` Warning. Three routes served it: the two
 * Catalog queries and the exam period's `catalogWarnings`. A Workspace-relative path is smaller
 * than an absolute one and is still a file path, reaching a page that is not allowed to know the
 * Workspace has files in it.
 *
 * So these go the other way round: **provoke a refusal on every route that can answer
 * `workspace-refused`, and read the body.** The routes are enumerated from `createApi` rather
 * than from the ticket, because #195 added one and inherited the leak by doing nothing wrong and
 * #67 added two more. Eighteen routes are registered; fourteen of them have a refusal arm, and
 * all fourteen are provoked below — four by the Catalog, nine by the State File, and
 * `POST /api/workspace` by a Workspace Layout that cannot be made.
 *
 * `error.message` is the only channel an adapter's prose has out of `app` — measured, with
 * `grep -rn '\.message' app/src server/src core/src web/src`, which finds `queries.ts` and
 * nothing else on any request path. Every other caller collapses the refusal to a reason code, so
 * the routes below the Catalog ones could not leak a path today and are here as the guard for the
 * next one that carries a message out.
 */
const namesNoPath = (body: string, where: string): void => {
  // the absolute path, which is what `requireJsonName` used to word itself with
  expect(body, where).not.toContain(root);
  // and the Workspace-relative one, which is how every other refusal in the adapter read: a
  // leading `./` is the whole of what made `./catalogs/2027.json` a path rather than a sentence
  expect(body, where).not.toContain("./");
  expect(body, where).not.toContain(".json");
  expect(body, where).not.toContain(".backups");
  expect(body, where).not.toContain("catalogs/");
  expect(body, where).not.toContain("requirements/");
};

/**
 * A directory where the Catalog's file belongs, which is #130's trigger: it needs no permission
 * trick, so this runs everywhere rather than skipping visibly on a runner where the test user can
 * read anything.
 *
 * All four routes that reach a Catalog file, and the statuses are asserted so that none of them
 * can pass by not refusing at all. The exam period is a **200** on purpose and is the subtlest of
 * the four: a Catalog that cannot be served is not a refusal of the exam rail — it is an exam
 * period nobody has published — so its refusal rides out under `catalogWarnings` inside a
 * successful answer, which is the one place a reader of the 409 arms would not have looked.
 */
it("names no path in a refusal when a Catalog cannot be read, on all four routes", async () => {
  await post("/api/workspace", {});
  await mkdir(join(root, "catalogs", "2027.json"));
  await writeFile(join(root, "catalogs", "2027.json", "inside.txt"), "not a Catalog", "utf8");

  const listed = await get("/api/catalog/2027/offerings?semester=fall");
  expect(listed.status).toBe(409);
  const listedBody = await listed.text();
  // the setup asserted rather than assumed: this is the refusal and not some other answer
  expect(JSON.parse(listedBody)).toMatchObject({ warnings: [{ kind: "workspace-refused" }] });
  namesNoPath(listedBody, "GET offerings");
  // **and it still says something true.** The other half of #216: a path removed with nothing
  // put in its place would leave a page unable to tell the student which file to go and look
  // at. `reason` is the refusal's own sentence (`app/src/queries.ts`), and it names the Catalog
  // by its Academic Year — a domain operation, which is what the API is allowed to expose.
  expect(JSON.parse(listedBody)).toMatchObject({
    warnings: [
      {
        kind: "workspace-refused",
        reason:
          "refusing the Catalog for the Academic Year 2027: it is there and cannot be read (EISDIR)",
      },
    ],
  });

  const one = await get("/api/catalog/2027/offerings/89-110");
  expect(one.status).toBe(409);
  namesNoPath(await one.text(), "GET one offering");

  const exams = await get(EXAMS);
  expect(exams.status).toBe(200);
  const examsBody = await exams.text();
  expect(JSON.parse(examsBody)).toMatchObject({
    catalogWarnings: [{ kind: "workspace-refused" }],
  });
  namesNoPath(examsBody, "GET exams");

  const imported = await post("/api/catalog/2027/import", CRAWL);
  expect(imported.status).toBe(409);
  namesNoPath(await imported.text(), "POST import");
});

/**
 * The other refusal a Catalog read can make: the file is a symlink pointing out of the Workspace,
 * which is `OutsideWorkspaceError` rather than `UnreadableError` and was worded with a path of its
 * own. The test above it in this file already proves the *contents* out there never come back;
 * this one is about the name of the file that pointed at them.
 */
it("names no path when a Catalog resolves outside the Workspace", async () => {
  const outside = await mkdtemp(join(tmpdir(), "biu-api-outside-"));
  try {
    await post("/api/workspace", {});
    await writeFile(join(outside, "secret.json"), JSON.stringify({ secret: "leaked" }));
    await symlink(join(outside, "secret.json"), join(root, "catalogs", "2027.json"));

    for (const path of [
      "/api/catalog/2027/offerings?semester=fall",
      "/api/catalog/2027/offerings/89-110",
    ]) {
      const refused = await get(path);
      expect(refused.status, path).toBe(409);
      const body = await refused.text();
      expect(JSON.parse(body), path).toMatchObject({ warnings: [{ kind: "workspace-refused" }] });
      expect(body, path).not.toContain("leaked");
      expect(body, path).not.toContain(outside);
      namesNoPath(body, path);
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

/**
 * `contained`'s **other** arm: the file is not there, so its folder is what is checked, and that
 * folder is the symlink pointing out. Two arms worded themselves with two different paths, which
 * is how they used to be told apart; they are told apart in the domain's words now — the Catalog
 * itself resolves outside, or the folder holding the Workspace's Catalogs does — and neither says
 * where.
 */
it("names no path when the folder holding the Catalogs resolves outside the Workspace", async () => {
  const outside = await mkdtemp(join(tmpdir(), "biu-api-outside-"));
  try {
    await mkdir(join(root, "requirements"));
    await mkdir(join(root, ".backups"));
    await symlink(outside, join(root, "catalogs"), "dir");

    const refused = await get("/api/catalog/2027/offerings?semester=fall");
    expect(refused.status).toBe(409);
    const body = await refused.text();
    expect(JSON.parse(body)).toMatchObject({ warnings: [{ kind: "workspace-refused" }] });
    expect(body).not.toContain(outside);
    namesNoPath(body, "GET offerings");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

/**
 * Every route the State File reaches, with a directory standing in its place (#130's trigger
 * again). Nine routes, including the two history ones and the restore — none of which carries a
 * message out today, so this is the regression guard rather than the proof: the leak was in the
 * adapter's wording, and a route that collapses a refusal to a reason code is one `editStateFile`
 * arm away from carrying one.
 *
 * The snapshot and the revision are taken **before** the State File is broken, because a restore
 * that refused for want of a snapshot would be a different refusal and would prove nothing about
 * this one. The **undo is made before it too, and it succeeds**, for the same reason one step
 * further on: `redo` answers `nothing-to-redo` from memory without touching a file, so an empty
 * redo stack would have put this route in the sweep while provably not reaching the refusal. One
 * Pick is left on the undo stack after it, so `undo` still reaches the file as well.
 */
it("names no path in a refusal when the State File cannot be read, on every route", async () => {
  await post("/api/workspace", {});
  await post("/api/catalog/2027/import", CRAWL);
  await post(PICKS, LECTURE);
  await save(PICKS, CLASHING);
  // a redo to be refused, and a Pick still left to undo
  expect((await step(UNDO)).status).toBe(200);
  const [takenAt] = await snapshotMoments();
  const basedOn = await currentVersion();

  // a directory where the file was, so every read of it is the port's refusal
  await rm(join(root, "me.state.json"));
  await mkdir(join(root, "me.state.json"));

  const answers: [string, Response][] = [
    ["GET week", await get(TIMETABLE)],
    ["GET exams", await get(EXAMS)],
    ["GET settings", await get(SETTINGS)],
    ["POST pick", await post(PICKS, { ...LECTURE, basedOn })],
    ["DELETE pick", await remove(PICKS, { courseNumber: "89-110", lessonType: "הרצאה", basedOn })],
    ["PATCH settings", await patch(SETTINGS, { language: "en", basedOn })],
    ["POST undo", await post(UNDO, { basedOn })],
    ["POST redo", await post(REDO, { basedOn })],
    ["POST restore", await post(RESTORE, { takenAt, basedOn })],
  ];

  for (const [where, answer] of answers) {
    expect(answer.status, where).toBe(409);
    const body = await answer.text();
    // the refusal and not some other 409: every one of these is the port's, worded by `app`
    expect(JSON.parse(body), where).toMatchObject({ reason: "workspace-refused" });
    namesNoPath(body, where);
  }

  // and the file the refusals were about is exactly as it was left
  expect(await readdir(join(root, "me.state.json"))).toEqual([]);
});

/**
 * The snapshots folder, which #67 added and which refuses a listing of a `.backups` that is there
 * and is not a folder. Its refusal read `refusing ./.backups: …` — the one Workspace-relative
 * path naming a folder the student never sees in the first place, since `.backups` is the
 * adapter's own name for it and not a domain word at all.
 *
 * `app/src/backups.ts` collapses it to a reason code, so nothing escaped; it is here because the
 * sweep is over routes and not over the ones that happened to carry a message.
 */
/**
 * `POST /api/workspace` is the fourteenth refusal-capable route and the only one not reached by
 * either of the two provocations above, so it gets its own case rather than being left to the
 * total-body assertion further up this file — which does cover it, by asserting the whole body
 * equals `{ reason: "workspace-refused" }`, but does so as a test about #141 and not about paths.
 * A sweep with a hole in it is worth less than the hole is wide.
 *
 * A plain file where `catalogs` belongs and `requirements` genuinely missing, so `status` reports
 * not-ready, the student is offered the Workspace Layout, and accepting it lands on the file
 * (#121). `create`'s refusal names the **Workspace Layout folder token**, which is the same token
 * `GET /api/workspace` already serves in `missing` — which is why `namesNoPath` forbids
 * `catalogs/` with the separator and not the bare word.
 */
it("names no path when the Workspace Layout cannot be created", async () => {
  await writeFile(join(root, "catalogs"), "not a folder");

  const refused = await post("/api/workspace", {});

  expect(refused.status).toBe(409);
  const body = await refused.text();
  expect(JSON.parse(body)).toEqual({ reason: "workspace-refused" });
  namesNoPath(body, "POST workspace");
});

it("names no path when the snapshots folder is there and cannot be listed", async () => {
  await mkdir(join(root, "catalogs"));
  await mkdir(join(root, "requirements"));
  // a plain file where `.backups` belongs: `status` calls the Workspace ready, because the probe
  // asks whether each part resolves inside it and not what it is (#121)
  await writeFile(join(root, ".backups"), "not a folder");
  await expect((await get("/api/workspace")).json()).resolves.toEqual({ ready: true, missing: [] });

  const refused = await get(BACKUPS);

  expect(refused.status).toBe(409);
  const body = await refused.text();
  expect(JSON.parse(body)).toEqual({ reason: "workspace-refused" });
  namesNoPath(body, "GET backups");
});
