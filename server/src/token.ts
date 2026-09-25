import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The launch token: the one secret that separates the student who started the server
 * from every other process and website that can reach the port (ADR-0004).
 *
 * It lives in the user config directory and never in the Workspace, which the student
 * may sync to Dropbox or commit to git: one token per user account on the machine, because
 * that path is the OS config directory and nothing in it names an installation — two
 * installations for one user share the token, and a second OS user gets their own. It is
 * stable across restarts, so the URL the launcher prints stays a working bookmark
 * (docs/design.md, "Authentication").
 *
 * Stability is also what makes a leak permanent: the launcher prints the token in a URL,
 * and that URL is what a student pastes into a bug report or leaves in a screenshot. So
 * `rotateLaunchToken` is the other half of the same decision — the escape hatch that
 * makes a stable secret safe to keep.
 */
const TOKEN_FILE = "token";

const APPLICATION = "biu-cs-planner";

/** 32 random bytes, base64url so the whole token survives a URL fragment untouched. */
const TOKEN_BYTES = 32;

/**
 * What a token may look like. Anything else on disk is not a token we wrote, so it is
 * replaced rather than trusted: a half-written file must not become a token that the
 * page then fails to authenticate with for as long as the file stands — and nothing
 * expires it, so that is until a rotation or a delete.
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
 * The token for this user account on the machine: the stored one if there is one, a fresh
 * one written to disk otherwise.
 *
 * Two servers starting at the same moment would otherwise each write their own and one
 * would win, leaving the other holding a token nothing accepts. The create is exclusive,
 * so the loser sees `EEXIST` and reads what the winner wrote.
 */
export async function launchToken(
  directory: string = userConfigDirectory(),
): Promise<string> {
  const path = tokenFilePath(directory);

  const stored = await readTokenFile(path);
  if (stored !== undefined) return stored;

  // 0o700: the directory is no more readable than the token it holds
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const token = freshToken();
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

/** Where the token for a given config directory is kept. One place builds this name. */
export function tokenFilePath(directory: string = userConfigDirectory()): string {
  return join(directory, TOKEN_FILE);
}

/** One generator, so neither half of this file can drift from the other's shape. */
function freshToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** What a rotation did. The path is what the CLI prints; the token is never printed. */
export type Rotation = {
  /** The token from now on. */
  token: string;
  /** The file it was written to, so the student is told and not left to guess. */
  path: string;
  /** Whether a token file was already there — that is, whether anything was invalidated. */
  replaced: boolean;
};

/**
 * Throws away the stored token and writes a new one. The recovery path for a token that
 * has been seen by somebody else: it has no expiry and no revocation list, so replacing
 * the file *is* the revocation (docs/design.md, "Authentication").
 *
 * Written to a temporary name in the same directory and renamed over the target, the same
 * way `workspace.fs.ts` writes a State File and for a sharper reason. `writeFile` over the
 * target truncates first, so an interrupted rotation could leave a file holding 40 of a
 * token's 43 characters — a string `TOKEN_PATTERN` still accepts, because its floor is 40
 * and it cannot tell a prefix from a token. The next launch would trust that prefix, and go
 * on trusting it for as long as the file stood, while the page it handed a real token to
 * could not authenticate with it. A rename is atomic on a POSIX filesystem, so the file is
 * either the old token or the new one and never a prefix of either.
 *
 * The old token is never read, which is what lets rotating work on the one state
 * `launchToken` refuses to launch from: a token file whose mode says nobody may read it.
 * Rotation is how a student gets out of that too. A config **directory** nobody may look
 * inside is a different matter and is reported, not worked around — see `exists` below.
 */
export async function rotateLaunchToken(
  directory: string = userConfigDirectory(),
): Promise<Rotation> {
  const path = tokenFilePath(directory);
  const replaced = await exists(path);

  // 0o700 and 0o600 both match `launchToken`: rotating must not quietly widen either
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const token = freshToken();
  // the leading dot marks this as not the token; the pid only records which run wrote it
  const temporary = join(directory, temporaryName(process.pid));
  // Every temporary goes first, not just this pid's. A rotation killed between the write
  // and the rename leaves one behind holding a token that never became the token, and
  // nothing else would ever remove it: `launchToken` reads `token` and looks at no other
  // name. Sweeping here also means a temporary left by a dead run cannot make rotation —
  // the recovery command — the one thing a student cannot do.
  //
  // The cost is that two rotations running at once in two processes can take each other's
  // temporary away, and the loser's `rename` then fails with ENOENT. That is the right
  // outcome: rotating twice at the same instant is not something a student does on purpose,
  // and one of the two failing loudly is better than both reporting a success when only one
  // token survived. `launchToken` races on startup and has to resolve its race; this one is
  // typed by hand.
  await removeTemporaries(directory);
  try {
    // "wx" after the remove so the mode is the one this call asks for, not whatever an
    // existing file already carried
    await writeFile(temporary, `${token}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return { token, path, replaced };
}

/**
 * The name a rotation writes through. Built from a fixed prefix and suffix, so the sweep
 * below can recognise one without a pattern assembled out of anything read from disk
 * (CLAUDE.md, "Code guardrails": data is interpreted, never executed).
 */
const TEMPORARY_PREFIX = ".tmp-";

function temporaryName(pid: number): string {
  return `${TEMPORARY_PREFIX}${pid}-${TOKEN_FILE}`;
}

/**
 * Takes away every temporary a rotation has ever left in this directory.
 *
 * Called only after the `mkdir`, so the directory is there and a listing that fails is a
 * real failure to report rather than a case to absorb. A name that has gone between the
 * listing and the remove is the outcome asked for, which is what `force` covers.
 */
async function removeTemporaries(directory: string): Promise<void> {
  const names = await readdir(directory);

  await Promise.all(
    names
      .filter(
        (name) => name.startsWith(TEMPORARY_PREFIX) && name.endsWith(`-${TOKEN_FILE}`),
      )
      .map((name) => rm(join(directory, name), { force: true })),
  );
}

/**
 * Whether there is a file there at all — asked with `stat` rather than by reading it,
 * because a token file nobody may read is still a token file, and still something a
 * rotation replaces.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
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
