import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it } from "vitest";
import { rotatedNotice } from "./cli.ts";
import { onlyTheLauncher } from "./guard.ts";
import {
  launchToken,
  launchUrl,
  rotateLaunchToken,
  userConfigDirectory,
} from "./token.ts";

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

/*
 * Rotation — the escape hatch for a token somebody else has seen (issue #99). The token
 * is stable for the life of the installation on purpose, so nothing expires it and the
 * file being replaced is the whole of the revocation.
 */

it("gives a token that is not the old one, and the next launch uses the new one", async () => {
  const before = await launchToken(config);

  const rotation = await rotateLaunchToken(config);

  expect(rotation.token).not.toBe(before);
  expect(rotation.token).toMatch(WHAT_THE_PAGE_ACCEPTS);
  expect(rotation.path).toBe(join(config, "token"));
  // the point of the whole thing: the server started next picks up the new one
  expect(await launchToken(config)).toBe(rotation.token);
});

it("rotates to something new every time, not to one second token", async () => {
  await launchToken(config);

  const first = await rotateLaunchToken(config);
  const second = await rotateLaunchToken(config);

  expect(second.token).not.toBe(first.token);
});

/**
 * The acceptance criterion this ticket turns on, and the reason it is here rather than in
 * guard.test.ts: the guard is built from whatever `launchToken` hands the launcher, so
 * "the old token is refused" is a claim about the two files together, not about either.
 *
 * `guard.ts` is untouched by this change — its `timingSafeEqual` comparison was already
 * right — and this test is what shows the rotation reaches it.
 */
it("is accepted by the guard the next launch builds, and the old token is refused", async () => {
  const old = await launchToken(config);

  const { token: rotated } = await rotateLaunchToken(config);

  // exactly what bin.ts does at startup: read the stored token, guard with it
  const app = new Hono();
  app.use("/api/*", onlyTheLauncher({ token: await launchToken(config) }));
  app.get("/api/thing", (c) => c.json({ read: true }));

  const ask = (token: string) =>
    app.request("http://localhost:8900/api/thing", {
      headers: { Authorization: `Bearer ${token}` },
    });

  expect((await ask(rotated)).status).toBe(200);
  // the bookmark, the screenshot and the pasted bug report all stop here
  expect((await ask(old)).status).toBe(401);
});

it("says whether anything was invalidated, so the output can stop short of claiming it", async () => {
  expect((await rotateLaunchToken(config)).replaced).toBe(false);
  expect((await rotateLaunchToken(config)).replaced).toBe(true);
});

it("writes the rotated token as its owner's alone, inside a directory that is too", async () => {
  const nested = join(config, "made", "by", "rotating");

  await rotateLaunchToken(nested);

  expect((await stat(join(nested, "token"))).mode & 0o077).toBe(0);
  expect((await stat(nested)).mode & 0o077).toBe(0);
});

it("leaves the file holding a token and nothing else, and no temporary beside it", async () => {
  const { token } = await rotateLaunchToken(config);

  // read back through the same door the next launch uses: a file the pattern rejected
  // would come back as `undefined` and be silently replaced, hiding the failure
  expect(await readFile(join(config, "token"), "utf8")).toBe(`${token}\n`);
  expect(await readdir(config)).toEqual(["token"]);
});

it("replaces a token file that no longer holds a usable token, rather than refusing to", async () => {
  await writeFile(join(config, "token"), "this is not a token\n");

  const { token, replaced } = await rotateLaunchToken(config);

  expect(replaced).toBe(true);
  expect(await launchToken(config)).toBe(token);
});

it.skipIf(!unreadableFilesArePossible)(
  "rotates a token file nobody may read, which is the state it is the cure for",
  async () => {
    const path = join(config, "token");
    await launchToken(config);
    await chmod(path, 0o000);

    // `launchToken` will not launch from this, and a student with no rotate command would
    // be left editing the dotfile by hand — the gap issue #99 is about
    await expect(launchToken(config)).rejects.toThrow();

    const { token, replaced } = await rotateLaunchToken(config);

    expect(replaced).toBe(true);
    expect(await launchToken(config)).toBe(token);
  },
);

/**
 * The "no half-written file" criterion, asked the only way a test can ask it: break the
 * write and look at what survived.
 *
 * A rotation that wrote over the token file directly would truncate it first, so a write
 * that failed part way could leave 40 of a token's 43 characters — a string
 * `TOKEN_PATTERN` still accepts, since its floor is 40 and it cannot tell a prefix from a
 * token, and which the next launch would therefore trust for the life of the installation.
 * The temporary-and-rename means a failure leaves the old token whole instead.
 */
it.skipIf(!unreadableFilesArePossible)(
  "leaves the old token whole when the write fails, rather than half a token",
  async () => {
    const before = await launchToken(config);
    await chmod(config, 0o500); // readable and searchable, not writable

    try {
      await expect(rotateLaunchToken(config)).rejects.toThrow();
    } finally {
      await chmod(config, 0o700);
    }

    expect(await launchToken(config)).toBe(before);
    expect(await readdir(config)).toEqual(["token"]);
  },
);

it("never lets the new token into what gets printed", async () => {
  const rotation = await rotateLaunchToken(config);

  // the notice takes the path and the fact, so the secret has no route to the terminal
  // that the leaked URL already is
  expect(rotatedNotice(rotation)).not.toContain(rotation.token);
  expect(rotatedNotice(rotation)).toContain(rotation.path);
});

/**
 * The other half of the temporary-and-rename: a rotation that fails *after* the temporary
 * is written must take it away again, or the config directory accumulates a file holding a
 * token that is not the token — readable by nobody else, but still a secret lying around
 * for no reason.
 *
 * A directory where the token file belongs is the state that reaches it: the write
 * succeeds and the rename cannot.
 */
it("takes its temporary file away again when the rename cannot happen", async () => {
  await mkdir(join(config, "token"));

  await expect(rotateLaunchToken(config)).rejects.toThrow();

  expect(await readdir(config)).toEqual(["token"]);
});

/**
 * A config directory nobody may even look inside. Reported rather than swallowed: reading
 * "there is no token file" out of a permission error would make `replaced` say nothing was
 * invalidated, in the one case where the truth is that nothing could be seen.
 */
it.skipIf(!unreadableFilesArePossible)(
  "reports a config directory it cannot look inside, rather than guessing at it",
  async () => {
    await launchToken(config);
    await chmod(config, 0o000);

    try {
      await expect(rotateLaunchToken(config)).rejects.toThrow();
    } finally {
      await chmod(config, 0o700);
    }
  },
);
