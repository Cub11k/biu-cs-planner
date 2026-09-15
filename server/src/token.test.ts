import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { launchToken, launchUrl, userConfigDirectory } from "./token.ts";

/**
 * A copy of `TOKEN_PATTERN` in web/src/token.ts, which is what the page applies to the
 * token the fragment hands it. It is written out rather than imported because `web` and
 * `server` may not import each other's code; the point of checking a generated token
 * against it here is that widening the generator alone would produce tokens the page
 * silently refuses, and no other test spans both sides.
 */
const WHAT_THE_PAGE_ACCEPTS = /^[A-Za-z0-9_-]{40,128}$/;

let config: string;

beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), "biu-config-"));
});
afterEach(async () => {
  await rm(config, { recursive: true, force: true });
});

it("makes a token on first launch and keeps it for the next one", async () => {
  const first = await launchToken(config);
  const second = await launchToken(config);

  // a bookmark holds the token, so a restart that changed it would break the bookmark
  expect(second).toBe(first);
});

it("makes a token long enough to be worth guessing, and safe in a URL fragment", async () => {
  const token = await launchToken(config);

  expect(token).toMatch(WHAT_THE_PAGE_ACCEPTS);
  // a fragment carries it untouched, so the page reads back exactly what was printed
  expect(encodeURIComponent(token)).toBe(token);
});

it("gives two config directories two different tokens", async () => {
  const other = await mkdtemp(join(tmpdir(), "biu-config-"));
  try {
    expect(await launchToken(config)).not.toBe(await launchToken(other));
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

it("creates the config directory when it is not there yet", async () => {
  const nested = join(config, "not", "made", "yet");

  const token = await launchToken(nested);

  expect(token).toMatch(WHAT_THE_PAGE_ACCEPTS);
  expect(await launchToken(nested)).toBe(token);
});

it("keeps the token file to its owner", async () => {
  await launchToken(config);

  const mode = (await stat(join(config, "token"))).mode & 0o777;
  expect(mode & 0o077).toBe(0);
});

it("replaces a token file that no longer holds a usable token", async () => {
  const path = join(config, "token");
  await writeFile(path, "not a token, and it has spaces\n");

  const token = await launchToken(config);

  expect(token).toMatch(WHAT_THE_PAGE_ACCEPTS);
  await expect(readFile(path, "utf8")).resolves.toContain(token);
});

it("ignores the trailing newline the file is written with", async () => {
  const token = await launchToken(config);
  const onDisk = await readFile(join(config, "token"), "utf8");

  expect(onDisk).toBe(`${token}\n`);
  expect(await launchToken(config)).toBe(token);
});

// root reads a file whatever its mode says, and Windows does not honour mode bits
const unreadableFilesArePossible = process.platform !== "win32" && process.getuid?.() !== 0;

it.skipIf(!unreadableFilesArePossible)(
  "survives a token file it may not read, rather than launching without one",
  async () => {
    const path = join(config, "token");
    const token = await launchToken(config);
    await chmod(path, 0o000);
    try {
      await expect(launchToken(config)).rejects.toThrow();
    } finally {
      await chmod(path, 0o600);
    }
    expect(await launchToken(config)).toBe(token);
  },
);

it("puts the config directory where the platform keeps user config", () => {
  expect(userConfigDirectory({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(
    join("/xdg", "biu-cs-planner"),
  );
  expect(userConfigDirectory({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toContain(
    "biu-cs-planner",
  );
  // no XDG_CONFIG_HOME set is the common case, and the default is under the home directory
  expect(userConfigDirectory({}, "linux")).toMatch(/[\\/]\.config[\\/]biu-cs-planner$/);
});

it("never puts the token in the Workspace, which may be synced or committed", () => {
  // The Workspace is the folder the student names; the config directory is the app's own.
  // A relative name would land the token next to the Catalogs.
  expect(userConfigDirectory({ XDG_CONFIG_HOME: "/xdg" }, "linux")).not.toBe("biu-cs-planner");
  expect(userConfigDirectory({}, "linux").startsWith(".")).toBe(false);
});

it("prints a launch URL that carries the token in its fragment", async () => {
  const token = await launchToken(config);

  const printed = launchUrl(8900, token);

  // `t` is the fragment key web/src/token.ts reads; changing it here alone would hand
  // the page a URL it takes no token from
  expect(printed).toBe(`http://localhost:8900/#t=${token}`);
  // a fragment is never sent to the server, so the token does not reach a proxy log
  expect(new URL(printed).search).toBe("");
  expect(new URL(printed).hash).toBe(`#t=${token}`);
});

it("prints the port the server actually ended up on", () => {
  expect(launchUrl(8901, "x")).toContain(":8901/");
});
