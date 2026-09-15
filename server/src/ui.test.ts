import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it } from "vitest";
import { builtUiRoot, serveBuiltUi } from "./ui.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-ui-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><div id=root></div>");
  await writeFile(join(root, "assets", "index-abc.js"), "export const app = 1;\n");
  await writeFile(join(root, "assets", "index-abc.css"), ":root{--ground:white}\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ui() {
  return new Hono().get("*", serveBuiltUi(root));
}

async function get(path: string, app = ui()): Promise<Response> {
  return app.request(`http://localhost:8900${path}`);
}

it("serves the entry document at the root", async () => {
  const response = await get("/");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toContain('id=root');
});

it("serves a hashed asset with its own type, cached forever", async () => {
  const response = await get("/assets/index-abc.js");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
  // the name carries a content hash, so this file can never be the stale one
  expect(response.headers.get("Cache-Control")).toContain("immutable");
});

it("makes the browser re-read the entry document, which names the hashed assets", async () => {
  expect((await get("/")).headers.get("Cache-Control")).toBe("no-cache");
});

it("sends the entry document for a deep link, so a reload reaches the app", async () => {
  const response = await get("/timetable/2027");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
});

it("keeps a missing asset a 404 rather than answering a script with HTML", async () => {
  // HTML in place of a script is a syntax error in the console instead of a plain miss
  expect((await get("/assets/gone-123.js")).status).toBe(404);
});

it("leaves /api to the API even where the API has no route", async () => {
  const app = new Hono()
    .get("/api/health", (c) => c.json({ ok: true }))
    .get("*", serveBuiltUi(root));

  expect((await get("/api/health", app)).status).toBe(200);
  expect((await get("/api/nothing-here", app)).status).toBe(404);
});

it.each([
  "/../../../etc/passwd",
  "/assets/../../secret",
  "/%2e%2e%2f%2e%2e%2fetc/passwd",
  "/%2e%2e/%2e%2e/etc/passwd",
])("refuses to read %s from outside the built UI", async (path) => {
  const outside = join(root, "..", "secret");
  await writeFile(outside, "not yours");
  try {
    const response = await get(path);

    expect(await response.text()).not.toContain("not yours");
  } finally {
    await rm(outside, { force: true });
  }
});

it("tells the browser not to guess a type and not to frame the page", async () => {
  const response = await get("/assets/index-abc.css");

  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
});

it("answers 404 when the UI was never built, instead of failing to start", async () => {
  const empty = await mkdtemp(join(tmpdir(), "biu-ui-empty-"));
  try {
    const app = new Hono().get("*", serveBuiltUi(empty));

    expect((await get("/", app)).status).toBe(404);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

it("looks for the built UI beside the bundle, not beside the Workspace", () => {
  // `dist/cli.js` and `dist/ui/` are siblings, and the student's current directory —
  // which is the Workspace — must never be what decides which files are served
  expect(builtUiRoot().endsWith(`${sep}ui`)).toBe(true);
  expect(builtUiRoot()).not.toBe(join(process.cwd(), "ui"));
});
