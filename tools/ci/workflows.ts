/**
 * Reads a GitHub Actions workflow as text and finds the npm installs in it.
 *
 * Text, not parsed YAML: an install lives inside a `run:` block scalar, so a YAML parser
 * hands back the shell script as one string and the scanning happens line by line
 * anyway. Reading the file as lines keeps the line numbers a failure has to name.
 *
 * The rule this exists to hold is in CLAUDE.md, "Code guardrails": every workflow
 * installs with `--ignore-scripts`. A dependency's install script would otherwise run
 * as arbitrary code on a runner, and `pr-report.yml`'s runner holds a token that can
 * write to this repository.
 *
 * A guard is only worth what it cannot be walked around, so the shape of a shell line
 * is taken seriously here: `npm ci --ignore-scripts && npm i evil` is two commands and
 * the flag belongs to one of them, and `npm --prefix web install` puts the subcommand
 * somewhere a naive scan does not look.
 */

/** An npm install found in a workflow, and whether it carries the flag. */
export interface InstallCommand {
  /** The file it was found in, named the way a failure should print it. */
  readonly file: string;
  /** 1-based, so it pairs with the file name as `file:line`. */
  readonly line: number;
  /** The one command, separated out of whatever else shared its line. */
  readonly text: string;
  readonly ignoresScripts: boolean;
}

/**
 * The subcommands that install something.
 *
 * npm answers to its own typos -- `isntall` is a real alias, not a joke -- and a guard
 * a typo walks past is not a guard. They cost a line each to list.
 */
const INSTALLS = new Set([
  "ci",
  "clean-install",
  "install-clean",
  "isntall-clean",
  "install",
  "isntall",
  "add",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isntal",
]);

/**
 * Enough of npm's other subcommands to tell `npm --silent ci` (an option, then the
 * subcommand) from `npm --prefix web install` (an option, its value, then the
 * subcommand). Being short a name here costs a missed install, so it errs long.
 */
const OTHER_SUBCOMMANDS = new Set([
  "access", "audit", "bin", "bugs", "cache", "completion", "config", "dedupe", "deprecate",
  "diff", "dist-tag", "docs", "doctor", "edit", "exec", "explain", "explore", "find-dupes",
  "fund", "get", "help", "hook", "init", "link", "ln", "login", "logout", "ls", "list",
  "org", "outdated", "owner", "pack", "ping", "pkg", "prefix", "profile", "prune",
  "publish", "query", "rb", "rebuild", "repo", "restart", "root", "run", "run-script",
  "sbom", "search", "set", "shrinkwrap", "star", "start", "stop", "t", "team", "test",
  "token", "un", "uninstall", "unlink", "unpublish", "unstar", "up", "update", "v",
  "version", "view", "whoami", "why", "workspace", "workspaces", "x",
]);

const KNOWN_SUBCOMMANDS = new Set([...INSTALLS, ...OTHER_SUBCOMMANDS]);

const IGNORES_SCRIPTS = /--ignore-scripts\b/;

/**
 * Drops a comment that starts a token: `npm ci  # not yet` is npm ci, unguarded.
 *
 * It has to be token-initial. Shell parameter expansion is full of hashes that are not
 * comments -- release.yml's `token=${url##*#t=}` is one -- and cutting there would lose
 * the command after it. Trailing comments are cut rather than left in place because
 * leaving them in reads both ways round and one of them is dangerous: a line saying
 * `npm ci  # --ignore-scripts goes here` would otherwise be taken for a line that has
 * the flag.
 */
function withoutComment(text: string): string {
  return text.replace(/(^|\s)#.*$/, "").trim();
}

/**
 * One shell line as the separate commands it runs.
 *
 * `2>&1` is split too, which is harmless: the halves carry no npm subcommand, and the
 * half that does keeps its own flags.
 */
function splitCommands(text: string): string[] {
  return text
    .split(/\|\||&&|[;|&]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Whether one command is an npm install: `npm`, its options, then the subcommand. */
function isInstall(command: string): boolean {
  const tokens = command.split(/\s+/);
  const npm = tokens.indexOf("npm");
  if (npm === -1) return false;

  let at = npm + 1;
  while (at < tokens.length) {
    const token = tokens[at] ?? "";
    if (KNOWN_SUBCOMMANDS.has(token)) return INSTALLS.has(token);

    // An option, and possibly its value: `--prefix web` takes one, `--silent` does not,
    // and the way to tell them apart is that a subcommand is never an option's value.
    if (token.startsWith("-")) {
      at += 1;
      if (!token.includes("=") && at < tokens.length && !KNOWN_SUBCOMMANDS.has(tokens[at] ?? "")) {
        at += 1;
      }
      continue;
    }

    // A bare word that names no subcommand npm has: not an install, whatever it is.
    return false;
  }

  return false;
}

/**
 * The file as commands rather than as lines: a shell line ending in a backslash is
 * glued to the one after it, and reported at the line it started on.
 *
 * Without this, splitting an install across two lines for width would read as an
 * install with no flag on the first line and a stray `--ignore-scripts` on the second,
 * and the failure would make no sense to whoever wrote it.
 *
 * Whole-line comments are dropped, in YAML and in the shell inside a `run:` block
 * alike: ci.yml's own prose says `npm i -g` while describing what a student types, and a
 * comment cannot install anything.
 */
function lines(contents: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let pending: string | null = null;
  let start = 0;

  contents.split("\n").forEach((raw, index) => {
    const text = raw.trim();
    if (pending === null) {
      if (text.startsWith("#")) return;
      start = index + 1;
      pending = text;
    } else {
      pending = `${pending} ${text}`;
    }

    if (pending.endsWith("\\")) {
      pending = pending.slice(0, -1).trim();
      return;
    }

    out.push({ line: start, text: pending });
    pending = null;
  });

  if (pending !== null) out.push({ line: start, text: pending });

  return out;
}

/** Every npm install in one workflow file. */
export function installCommands(file: string, contents: string): InstallCommand[] {
  return lines(contents).flatMap(({ line, text }) =>
    splitCommands(withoutComment(text))
      .filter(isInstall)
      .map((command) => ({
        file,
        line,
        text: command,
        ignoresScripts: IGNORES_SCRIPTS.test(command),
      })),
  );
}

/** The workflow-level `permissions:` key, which is what stops a job inheriting a wide token. */
export function declaresPermissions(contents: string): boolean {
  return contents.split("\n").some((line) => /^permissions:/.test(line));
}

/** The `permissions: write-all` shorthand, which hands a job the whole token at once. */
export function grantsWriteAll(contents: string): boolean {
  return contents
    .split("\n")
    .some((line) => !line.trim().startsWith("#") && /\bwrite-all\b/.test(line));
}

/**
 * The scopes any block in the file grants at `write`.
 *
 * Indented `<scope>: write` appears nowhere in these files except a permissions block,
 * so no nesting has to be tracked to find them. What is done with the answer is the
 * test's business: it holds the list of write scopes this repository has a reason for,
 * so a new one has to be added there on purpose.
 */
export function writeScopes(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => /^\s+([a-z-]+):\s*write\s*$/.exec(line)?.[1])
    .filter((scope): scope is string => scope !== undefined);
}
