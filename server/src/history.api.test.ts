import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_STATE_FILE } from "@biu-cs-planner/app";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

/**
 * The settings routes over HTTP for #173: a State File can say no language was chosen, the API
 * says so as `null`, and nothing but a choice ever replaces it. Its own file beside
 * `./api.test.ts`, with the setup that file uses.
 */
const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";
const bearer = { Authorization: `Bearer ${TOKEN}` };
const SETTINGS = "/api/settings";

let root: string;
let api: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-history-api-"));
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

type SettingsBody = { language: string | null; examSpacingDays: number; version?: string };

const settings = async (): Promise<SettingsBody> =>
  (await (await send("GET", SETTINGS)).json()) as SettingsBody;

/** The State File as it is on disk, which is where a guess must never appear. */
const onDisk = async (): Promise<{ settings: { language: unknown } }> =>
  JSON.parse(await readFile(join(root, `${DEFAULT_STATE_FILE}.state.json`), "utf8")) as {
    settings: { language: unknown };
  };

it("says no language was chosen, and keeps saying it across a save of another preference", async () => {
  expect((await settings()).language).toBeNull();

  const saved = await send("PATCH", SETTINGS, { examSpacingDays: 5, basedOn: undefined });

  expect(saved.status).toBe(200);
  await expect(saved.json()).resolves.toMatchObject({ language: null, examSpacingDays: 5 });
  // written as `null`, so the next read still knows nobody chose
  expect((await onDisk()).settings.language).toBeNull();
});

it("stores a choice over an unchosen language, and the choice is what is read back", async () => {
  await send("PATCH", SETTINGS, { examSpacingDays: 5, basedOn: undefined });

  const chosen = await send("PATCH", SETTINGS, { language: "en", basedOn: (await settings()).version });

  expect(chosen.status).toBe(200);
  expect((await settings()).language).toBe("en");
  expect((await onDisk()).settings.language).toBe("en");
});

/**
 * The API takes a choice and nothing else. `null` is what the file says when nobody chose, and no
 * control un-chooses, so a body carrying it is not a request this route has a meaning for — it is
 * refused as the shape of the request, the way an unknown language is.
 */
it("refuses a change that would un-choose the language", async () => {
  await send("PATCH", SETTINGS, { language: "he", basedOn: undefined });

  const refused = await send("PATCH", SETTINGS, { language: null, basedOn: (await settings()).version });

  expect(refused.status).toBe(400);
  expect((await settings()).language).toBe("he");
});
