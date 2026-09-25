/**
 * The scan that finds a second State File writer.
 *
 * `CLAUDE.md`'s "Code guardrails" says every State File write goes through `editStateFile`
 * in `app/src/edit.ts`. That wrapper is the only place that carries the revision a save was
 * based on, so it is the only place the external-edit guard can apply to, and the only place
 * that puts the previous value on the undo stacks `server/src/history.ts` holds. A second
 * write path therefore costs a student their work twice over -- silently, because the new
 * path works perfectly for whoever wrote it. Issue #143 is the ticket; #73 added the rule and
 * #90 the guard it protects.
 *
 * **Why a source scan here rather than an entry in `tools/pr-review/layering.ts`.** The
 * layering rule judges *imports*, over the graphs `tools/pr-report/collect.ts` derives, and
 * it was the other candidate home: "who may call this function" is an edge rule. It cannot
 * be asked there. `saveStateFile` is a method on the Workspace port, so the one call reads
 * `workspace.saveStateFile(...)` -- a property access on a parameter, not a call to an
 * imported name. `tools/pr-report/calls.ts` resolves every call through the calling module's
 * own import statements and says so ("a namespace or default import is not read: `ns.foo()`
 * is a property access rather than an identifier"), so the port's methods are in no call
 * graph at all. Measured on `dev` at `8284a25`: of the 162 call edges `collect()` returns,
 * none mentions `saveStateFile`, and `app/src/edit.ts#editStateFile`'s only recorded edge is
 * to `core/src/state/file.ts#writeStateFile`. An entry in `layering.ts` would have had
 * nothing to judge and would have passed forever, which is worse than no check. So this sits
 * beside `tools/ci/workflows.ts` and `tools/ci/clock-pattern.ts`, the two other rules
 * enforced by reading the source, and `clock-pattern.ts` is the shape it copies.
 *
 * **What is spelled out and what is derived.** One name is literal -- `app/src/edit.ts`, the
 * wrapper -- because there is nothing to derive it from: which file is the single writer is
 * the decision, not a consequence of one. Everything else is derived, and that is what keeps
 * the list from rotting:
 *
 * - The adapters are *not* named. A declaration and an implementation of the method are told
 *   from a *call* to it by their syntax, so the port in `app/src/workspace.ts` and both
 *   adapters pass without appearing in any list, and a third adapter would too.
 * - Nor are the adapters' tests named. A test file may call the method when the module it is
 *   a test of is one that *implements* it -- `server/src/workspace.fs.test.ts` beside
 *   `server/src/workspace.fs.ts`. The exemption is "the test that tests the port may exercise
 *   the port", which is the reason those calls are legitimate, rather than a list of the two
 *   files that happen to have that reason today.
 *
 * **Test files are not blanket-exempt, deliberately.** `*.test.ts` waved through wholesale is
 * how this check would become useless: a future test is the easiest place for a second write
 * path to appear unnoticed, and a test that saves a State File outside the wrapper is asserting
 * the behaviour of a path production must not have. So a new `app/src/plan.test.ts` calling
 * `saveStateFile` is a finding, with the sentence `explain` gives it, and its author has two
 * honest ways out: go through `editStateFile` like production does, or -- if the point really
 * is the port -- write it beside the adapter, where the exemption already applies.
 *
 * **Where it stops seeing.** It is a text scan, not a type checker.
 *
 * - It judges the *name*. A file that reached under the port and wrote the file itself with
 *   `node:fs` is a second write path this cannot see; `app/src/workspace.ts` narrows `write`
 *   away from State Files to make that hard, and nothing here adds to it.
 * - A method *named* `saveStateFile` on some object that is not a Workspace reads as an
 *   implementation and is waved through -- and so, in turn, is a test beside it. Reaching a
 *   second write path that way means writing a whole adapter first, which is not the hurried
 *   shortcut the rule exists to stop.
 * - Prose lines are dropped, so a mention in a docstring is a mention. A block comment whose
 *   continuation lines do not start with `*` is not recognised as prose, exactly as in
 *   `clock-pattern.ts`; this repository writes neither.
 * - A construct left open at the end of a line makes that line `"unreadable"`, which is a
 *   finding rather than a shrug. A check that goes quiet when it is unsure guards nothing.
 *
 * Nothing here is executed, compiled, or built from what it reads
 * ([ADR-0007](../../docs/adr/0007-requirements-are-interpreted-data.md)). Every pattern below
 * is a literal written out in this file, and source text is only ever searched and sliced
 * with them.
 */

/**
 * The port method a State File write ends at. A plain string: it is searched for in source
 * text and never matched with.
 */
export const METHOD = "saveStateFile";

/** The one file whose production code may call it. The decision, so it is written out. */
export const WRITER = "app/src/edit.ts";

/**
 * The trees that hold the code this rule governs. The same four `tools/pr-report/collect.ts`
 * calls `SOURCE_DIRS`, and the test pins that the two agree, so a fifth workspace cannot
 * appear in one and be missed by the other. `tools/` is not here: nothing in it reaches a
 * Workspace.
 */
export const SOURCE_DIRS = ["core/src", "app/src", "server/src", "web/src"];

/** Files this scan reads. `.tsx` included, since `web` writes components. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/**
 * The rule, in the words a reader needs when a finding names their line -- what it is, why it
 * costs what it costs, and where it is written down. Quoted back beside every finding, so no
 * message is only a line number.
 */
export const RULE =
  "every State File write goes through `editStateFile` (`app/src/edit.ts`): the only place " +
  "that carries the revision a save was based on, so the external-edit guard applies to it, " +
  "and the only place that puts the previous value on the undo stacks `server/src/history.ts` " +
  'holds, so the edit can be undone. It is written down in `CLAUDE.md` under "Code ' +
  'guardrails", and #143 is why this check exists rather than only the sentence';

/**
 * What an occurrence of the name turned out to be.
 *
 * - `"declaration"` -- the port's own signature, `saveStateFile(ref: …): Promise<…>;`.
 * - `"implementation"` -- an adapter's method body, `async saveStateFile(ref: …) {`.
 * - `"call"` -- the method being called: through the port, as a bare name a destructuring
 *   bound, or through a computed `workspace["saveStateFile"]`.
 * - `"reference"` -- the method taken without being called, `const save = workspace.saveStateFile`.
 *   Judged exactly like a call: a reference handed elsewhere is a call somewhere else.
 * - `"text"` -- the name inside a string or a regex literal, which is prose in a message or a
 *   pattern a test asserts with. Never a finding.
 * - `"unreadable"` -- a line the masker could not finish reading, because a quote, a template
 *   or a comment was still open at the end of it. A finding, because it is not a pass.
 */
export type MentionKind =
  | "declaration"
  | "implementation"
  | "call"
  | "reference"
  | "text"
  | "unreadable";

/** One occurrence of the name in source, and what it turned out to be. */
export type Mention = {
  /** Repo-relative path, as a reader of a failure wants to see it. */
  file: string;
  /** Line number, counted from one. */
  line: number;
  /** The source line, trimmed, so a failure shows the code and not just its address. */
  text: string;
  kind: MentionKind;
};

/**
 * Lines that are prose rather than code: a `//` comment, or a line of a `/* … *\/` block.
 * Whole lines only. `clock-pattern.ts` draws the same line for the same reason -- this
 * repository documents its rules in prose constantly, and a docstring naming the method is
 * naming it, not calling it.
 */
const PROSE_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * What a regex literal may follow. Literal, and the same idea as `clock-pattern.ts`'s
 * prefix set: it keeps a division from being read as the start of a pattern, which is what
 * lets `/State File "alice".*saveStateFile/s` in `app/src/workspace.test.ts` be masked as
 * the pattern it is while `(a + b) / c` is left alone.
 */
const BEFORE_REGEX = /[=(,:;!&|?+[{}<>~*%^\-\s]$/;

/** The character masked text is filled with. Not a letter, so no name can survive in it. */
const FILL = "~";

/** A line with its strings, templates, regex literals and comments blanked out. */
export type Masked = {
  /** The line, same length, with every non-code span replaced by `FILL`. */
  text: string;
  /** True when a quote, template or block comment was still open at the end of the line. */
  unterminated: boolean;
};

/** Is a regex literal allowed to start at `at`, given the code seen before it? */
const regexMayStart = (line: string, at: number): boolean =>
  at === 0 || BEFORE_REGEX.test(line.slice(0, at));

/**
 * Where the span opened at `from` by `closer` ends, honouring backslash escapes and -- for a
 * regex -- a character class, whose `/` does not close the pattern. `-1` when it never closes
 * on this line.
 */
const spanEnd = (line: string, from: number, closer: string, classes: boolean): number => {
  let inClass = false;

  for (let at = from; at < line.length; at += 1) {
    const character = line[at];

    if (character === "\\") {
      at += 1;
      continue;
    }
    if (classes && character === "[") inClass = true;
    else if (classes && character === "]") inClass = false;
    else if (character === closer && !inClass) return at;
  }

  return -1;
};

/**
 * One source line with everything that is not code blanked out, indices preserved so an
 * occurrence can be looked up in both at once.
 *
 * Per line, and that is the whole of why `"unreadable"` exists: a template literal or a
 * block comment that spans lines cannot be read by a line scanner, so rather than guess, the
 * line says it could not be read and any occurrence on it becomes a finding. This repository
 * has none today.
 */
export function maskCode(line: string): Masked {
  const out = [...line];
  const blank = (from: number, to: number): void => {
    for (let at = from; at <= to && at < out.length; at += 1) out[at] = FILL;
  };

  let at = 0;

  while (at < line.length) {
    const character = line[at];
    const next = line[at + 1];

    if (character === "/" && next === "/") {
      blank(at, line.length - 1);
      return { text: out.join(""), unterminated: false };
    }
    if (character === "/" && next === "*") {
      const close = line.indexOf("*/", at + 2);

      if (close === -1) {
        blank(at, line.length - 1);
        return { text: out.join(""), unterminated: true };
      }
      blank(at, close + 1);
      at = close + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const close = spanEnd(line, at + 1, character, false);

      if (close === -1) {
        blank(at, line.length - 1);
        return { text: out.join(""), unterminated: true };
      }
      // The quotes themselves stay: only what they hold is not code.
      blank(at + 1, close - 1);
      at = close + 1;
      continue;
    }
    if (character === "/" && regexMayStart(line, at)) {
      const close = spanEnd(line, at + 1, "/", true);

      if (close !== -1) {
        blank(at + 1, close - 1);
        at = close + 1;
        continue;
      }
      // Not a regex after all -- a lone division, or a path in code. Read on.
    }
    at += 1;
  }

  return { text: out.join(""), unterminated: false };
}

/** The name sitting in a quote that a `[` opens: `workspace["saveStateFile"](…)`. Literal. */
const COMPUTED_ACCESS = ['["', "['", "[`"];
const COMPUTED_CLOSE = ['"]', "']", "`]"];

/** Call-shaped: the name is immediately applied. Literal. */
const APPLIED = /^\s*\(/;
/** Reached through a dot, optional-chained or not: `workspace.saveStateFile(`. Literal. */
const THROUGH_A_DOT = /(?:\?)?\.$/;
/** Nothing but indentation, and perhaps `async`, before the name: a member being defined. */
const DEFINES_A_MEMBER = /^\s*(?:async\s+)?$/;

/** What the name at `at` in `line` is, given the line's masked twin. */
function classify(line: string, masked: Masked, at: number): MentionKind {
  if (masked.unterminated) return "unreadable";

  const before = line.slice(0, at);
  const after = line.slice(at + METHOD.length);
  const isCode = masked.text.slice(at, at + METHOD.length) === METHOD;

  if (!isCode) {
    // Inside a quote or a pattern. Prose in a message, unless a bracket makes it an access.
    const computed = COMPUTED_ACCESS.some(
      (open, which) => before.endsWith(open) && after.startsWith(COMPUTED_CLOSE[which] ?? ""),
    );

    return computed ? "call" : "text";
  }
  // Taken rather than called. `const save = workspace.saveStateFile;` is a call elsewhere.
  if (!APPLIED.test(after)) return "reference";
  if (THROUGH_A_DOT.test(before)) return "call";
  if (DEFINES_A_MEMBER.test(before)) {
    const ends = line.trimEnd();

    if (ends.endsWith("{")) return "implementation";
    if (ends.endsWith(";")) return "declaration";

    // Call-shaped, at the start of a line, ending in neither: not a shape this repository
    // writes, so it is not waved through.
    return "unreadable";
  }

  // A bare name being applied -- what a destructuring of the port would leave behind.
  return "call";
}

/** Every occurrence of the method name in one file's source, in the order they appear. */
export function mentions(file: string, source: string): Mention[] {
  return source.split("\n").flatMap((line, index) => {
    if (!line.includes(METHOD) || PROSE_LINE.test(line)) return [];

    const masked = maskCode(line);
    const found: Mention[] = [];

    for (let at = line.indexOf(METHOD); at !== -1; at = line.indexOf(METHOD, at + 1)) {
      found.push({
        file,
        line: index + 1,
        text: line.trim(),
        kind: classify(line, masked, at),
      });
    }

    return found;
  });
}

/** Whether a name is a test file, by the spelling this project's suite picks up. */
const TEST_FILE = /\.test\.(tsx?)$/;

/**
 * The module a test file is a test of -- `server/src/workspace.fs.test.ts` is a test of
 * `server/src/workspace.fs.ts` -- or `undefined` when the file is not a test at all.
 */
export function moduleUnderTest(file: string): string | undefined {
  const found = TEST_FILE.exec(file);

  return found === null ? undefined : `${file.slice(0, found.index)}.${found[1]}`;
}

/** Every file that implements the method: the port's adapters, found rather than listed. */
export const implementors = (all: readonly Mention[]): string[] => [
  ...new Set(all.filter((mention) => mention.kind === "implementation").map((m) => m.file)),
];

/**
 * May this file call the method? The wrapper may, and so may the test of a module that
 * implements it -- the test of the port, exercising the port.
 */
export const mayCall = (file: string, implementing: readonly string[]): boolean => {
  if (file === WRITER) return true;

  const subject = moduleUnderTest(file);

  return subject !== undefined && implementing.includes(subject);
};

/** An occurrence that is a second write path, or a line that could not be read. */
export type Finding = Mention & { kind: "call" | "reference" | "unreadable" };

/** Whether a kind is one that has to be allowed rather than merely noted. */
const NEEDS_LEAVE: readonly MentionKind[] = ["call", "reference", "unreadable"];

/**
 * Every mention that reaches the port from somewhere the rule does not allow, sorted so the
 * same tree always gives the same list.
 *
 * The whole set is passed in, not one file's worth, because who may call is derived from who
 * implements -- a question no single file can answer.
 */
export function secondWriters(all: readonly Mention[]): Finding[] {
  const implementing = implementors(all);

  return all
    .filter(
      (mention): mention is Finding =>
        NEEDS_LEAVE.includes(mention.kind) && !mayCall(mention.file, implementing),
    )
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * One finding as a sentence: the line, what it is, what to do instead, and the rule. A
 * reader should never have to work out why their line is wrong, and the three kinds have
 * three different remedies -- which is why each gets its own sentence rather than sharing a
 * paragraph nobody reads to the end of.
 */
export const explain = (finding: Finding): string => {
  const at = `${finding.file}:${finding.line}: ${finding.text}`;

  if (finding.kind === "unreadable") {
    return (
      `${at}\n  This line names \`${METHOD}\` and could not be read: a quote, a template or a ` +
      `comment was still open at the end of it, so the scan cannot tell a call from a ` +
      `mention. Put the mention on a prose line of its own, or the code on one line, rather ` +
      `than leaving the question open — ${RULE}.`
    );
  }
  if (moduleUnderTest(finding.file) !== undefined) {
    return (
      `${at}\n  A test reaches \`${METHOD}\` here, and \`*.test.ts\` is not waved through: ` +
      `only the test of a module that implements the port may exercise it, and ` +
      `\`${moduleUnderTest(finding.file) ?? ""}\` does not. Save through \`editStateFile\` as ` +
      `production does, or — if the port itself is the subject — put the test beside the ` +
      `adapter it tests. ${RULE.charAt(0).toUpperCase()}${RULE.slice(1)}.`
    );
  }

  const reached =
    finding.kind === "reference"
      ? `takes \`${METHOD}\` without calling it, which is a call wherever it is handed to`
      : `calls \`${METHOD}\` directly`;

  return (
    `${at}\n  \`${finding.file}\` ${reached}, and only \`${WRITER}\` may: ${RULE}.`
  );
};
