import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

let root: string;
let api: ReturnType<typeof createApi>;

/** Stands in for the launch token the CLI reads from the user config directory. */
const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-api-"));
  api = createApi({ workspace: fileSystemWorkspace(root), token: TOKEN });
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

  for (const path of ["/api/workspace", "/api/catalog/2027/offerings?semester=fall", "/api/catalog/2027/offerings/89-110"]) {
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
