import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The launch token: the one secret that separates the student who started the server
 * from every other process and website that can reach the port (ADR-0004).
 *
 * It lives in the user config directory and never in the Workspace, which the student
 * may sync to Dropbox or commit to git. It is stable across restarts, so the URL the
 * launcher prints stays a working bookmark (docs/design.md, "Authentication").
 */
const TOKEN_FILE = "token";

const APPLICATION = "biu-cs-planner";

/** 32 random bytes, base64url so the whole token survives a URL fragment untouched. */
const TOKEN_BYTES = 32;

/**
 * What a token may look like. Anything else on disk is not a token we wrote, so it is
 * replaced rather than trusted: a half-written file must not become a token that the
 * page then fails to authenticate with, for the rest of the installation's life.
 *
 * The page applies the same expression to what the fragment hands it, and has its own
 * copy because `web` may not import server code (CLAUDE.md, "Code guardrails"). Widening
 * one copy alone would produce tokens the page silently refuses, so the test below
 * checks a generated token against the page's copy as well as this one.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

/**
 * Where the operating system keeps a user's application config. Windows has `APPDATA`;
 * everywhere else follows the XDG base directory spec, whose `~/.config` default is
 * also where macOS command line tools conventionally put their config.
 *
 * The environment and platform are parameters so this is testable on one machine.
 */
export function userConfigDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const base =
    platform === "win32" && environment["APPDATA"]
      ? environment["APPDATA"]
      : (environment["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"));
  return join(base, APPLICATION);
}

/**
 * The token for this installation: the stored one if there is one, a fresh one written
 * to disk otherwise.
 *
 * Two servers starting at the same moment would otherwise each write their own and one
 * would win, leaving the other holding a token nothing accepts. The create is exclusive,
 * so the loser sees `EEXIST` and reads what the winner wrote.
 */
export async function launchToken(
  directory: string = userConfigDirectory(),
): Promise<string> {
  const path = join(directory, TOKEN_FILE);

  const stored = await readTokenFile(path);
  if (stored !== undefined) return stored;

  // 0o700: the directory is no more readable than the token it holds
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  try {
    await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isErrnoCode(error, "EEXIST")) throw error;

    const raced = await readTokenFile(path);
    if (raced !== undefined) return raced;
    // the file is there but holds no usable token, so it is replaced. A token is a
    // single small write, so this leaves no window where the file is half a token.
    await writeFile(path, `${token}\n`, { mode: 0o600 });
  }
  return token;
}

/**
 * The stored token, or `undefined` when there is none to be had. A file that is there
 * but unreadable is neither: it is a problem to report, not a reason to launch with a
 * token that would break the student's bookmark.
 */
async function readTokenFile(path: string): Promise<string | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }

  const token = contents.trim();
  return TOKEN_PATTERN.test(token) ? token : undefined;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * The URL the launcher prints and opens. The token rides in the **fragment**, which a
 * browser never sends to a server: it does not reach an access log, and it is the page
 * that reads it and takes it out of the URL (ADR-0004, web/src/token.ts).
 *
 * `localhost` rather than `127.0.0.1` because that is what the student bookmarks, and
 * the guard accepts both.
 */
export function launchUrl(port: number, token: string): string {
  return `http://localhost:${port}/#t=${token}`;
}
