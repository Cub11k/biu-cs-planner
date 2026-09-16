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
 */

/** An npm install found in a workflow, and whether it carries the flag. */
export interface InstallCommand {
  /** The file it was found in, named the way a failure should print it. */
  readonly file: string;
  /** 1-based, so it pairs with the file name as `file:line`. */
  readonly line: number;
  /** The line as written, trimmed. */
  readonly text: string;
  readonly ignoresScripts: boolean;
}

/**
 * `ci`, `install` and the aliases npm answers to. `npm pack`, `npm publish` and
 * `npm run` are not installs and do not appear here; `npm pack` has its own
 * `--ignore-scripts` in release.yml for its own reason.
 */
const INSTALL = /\bnpm\s+(?:ci|clean-install|install|i|add|isntall|in)\b/;

const IGNORES_SCRIPTS = /--ignore-scripts\b/;

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
 * comment cannot install anything. A `#` later in a line is left alone, because shell
 * parameter expansion is full of them.
 */
function commands(contents: string): { line: number; text: string }[] {
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
  return commands(contents)
    .filter(({ text }) => INSTALL.test(text))
    .map(({ line, text }) => ({
      file,
      line,
      text,
      ignoresScripts: IGNORES_SCRIPTS.test(text),
    }));
}

/** The workflow-level `permissions:` key, which is what stops a job inheriting a wide token. */
export function declaresPermissions(contents: string): boolean {
  return contents.split("\n").some((line) => /^permissions:/.test(line));
}

/** `write-all`, or a `permissions: write-all` shorthand, anywhere in the file. */
export function grantsEverything(contents: string): boolean {
  return contents
    .split("\n")
    .some((line) => !line.trim().startsWith("#") && /\bwrite-all\b/.test(line));
}
