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
 * ## How the source is read, and why it is a lexer rather than a line filter
 *
 * A first version of this file filtered whole prose lines out *before* judging, the way
 * `clock-pattern.ts`'s `PROSE_LINE` does. That was a mis-copy, and the precedent says so in
 * its own words: there the filter is confined to `codeOnly()` and is "only for **counting**
 * the body in a file's text -- a code line is never touched". Put on the judging path it
 * touches code lines, by deleting them: `/* fast path *\/ await workspace.saveStateFile(…)`
 * begins with `/*`, so the whole line -- comment and call alike -- vanished, and the suite
 * stayed green. That is not an adversarial spelling. `/* c8 ignore next *\/` in front of a
 * call produces it by accident.
 *
 * So `maskSource` is a small lexer instead. It walks a file once, carrying its state from
 * line to line, and blanks everything that is not code: line comments, block comments across
 * however many lines, string literals, the literal chunks of a template, and regex literals.
 * Indices are preserved, so an occurrence can be looked up in the line and in its masked
 * twin at once. A template's `${…}` substitutions are *code* and stay readable, because
 * `` `rev ${(await workspace.saveStateFile(ref, save)).value}` `` is a call and blanking the
 * whole template hid it.
 *
 * Two consequences worth stating, because both were holes before:
 *
 * - **A regex literal may only start where an expression may.** The test is the last
 *   *non-whitespace* character before the slash, not merely the character before it. With
 *   whitespace alone accepted, `const x = a / b, v = await workspace.saveStateFile(…), y = c / d;`
 *   read the two divisions as one regex and blanked the call between them. Erring the other
 *   way -- reading a real pattern as a division -- leaves code visible, which costs a
 *   mis-read pattern and never a missed call.
 * - **A string whose whole contents is the method name is not prose.** Prose names the
 *   method inside a sentence; `"saveStateFile"` alone is the name being handed about as data,
 *   which is how `workspace[ "saveStateFile" ]`, `Reflect.get(workspace, "saveStateFile")`
 *   and `const KEY = "saveStateFile"` all reach the port without writing a dot. Each is a
 *   finding. The two real prose mentions this repository holds -- an error message in
 *   `app/src/workspace.ts` and the pattern `app/src/workspace.test.ts` asserts it with -- name
 *   it inside something longer and stay quiet.
 *
 * ## Where it stops seeing
 *
 * It is a text scan, not a type checker, and these are the limits rather than a claim there
 * are none.
 *
 * - It judges the **name**. A file that reached under the port and wrote the file itself with
 *   `node:fs` is a second write path this cannot see; `app/src/workspace.ts` narrows `write`
 *   away from State Files to make that hard, and nothing here adds to it.
 * - **A name that is never spelled is never found**: `workspace["save" + "StateFile"]`, a
 *   unicode escape in the identifier (`saveStateFile`), or the string built at runtime.
 *   No name scan can see these, and no check in this repository can; they are written down
 *   here so that nobody reads the list above as exhaustive.
 * - A method *named* `saveStateFile` on some object that is not a Workspace reads as an
 *   implementation and is waved through. Reaching a second write path that way means writing
 *   a whole adapter first, which is not the hurried shortcut the rule exists to stop -- and
 *   the repository-wide test pins the implementors by exact name, so a new one fails the
 *   suite and has to be argued for rather than quietly widening the exemption to its sibling
 *   test.
 * - **A bare call whose parameter list does not close on its own line**, written at the
 *   margin, is read as a wrapped signature and so as an implementation. Closing it needs a
 *   parser. It takes a destructured binding to set up, which is itself a finding, so the
 *   remaining path is narrow and deliberate.
 * - A *definition* of a function by this name outside an object body -- `export function
 *   saveStateFile(…)` -- is reported as a reach, and the sentence it gets says "calls", which
 *   is the wrong verb for the right verdict. A second function by that name is worth a
 *   reviewer's attention either way.
 * - **A spy is a finding.** `expect(workspace.saveStateFile).toHaveBeenCalled()` in a test
 *   that is not an adapter's takes the method without calling it, so it is reported. That is
 *   the false positive this check prefers to the hole, on the same reasoning
 *   `clock-pattern.ts` gives for reading a `file:line:column` parse as a clock: a check that
 *   stays quiet whenever it is unsure guards nothing. `app/src/edit.test.ts` observes writes
 *   through the memory adapter instead, which is the shape that does not trip it.
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

/**
 * Files this scan reads. `.tsx` because `web` writes components, `.mts` and `.cts` because
 * they are TypeScript this repository could hold tomorrow and a tree nobody scans is a tree
 * where the rule does not apply.
 */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

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
 *   bound, or through a computed `workspace["saveStateFile"](…)`.
 * - `"reference"` -- the method reached without being called there: taken as a value, bound
 *   by a destructuring, or named as a bare string handed to something else. Judged exactly
 *   like a call, because a reference is a call somewhere else.
 * - `"text"` -- the name inside a longer string or a regex literal, which is prose in a
 *   message or a pattern a test asserts with. Never a finding.
 * - `"unreadable"` -- a line the lexer could not finish: a quote left open at the end of it,
 *   or a shape at the margin that is neither a definition nor a call. A finding, because it
 *   is not a pass.
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

/** The character masked text is filled with. Not a letter, so no name can survive in it. */
const FILL = "~";

/**
 * What a regex literal may follow, tested against the last non-whitespace character before
 * the slash. Literal. An identifier, a digit, a `)` or a `]` ends an expression, so a slash
 * after one is a division; everything here is a position where a value may begin.
 */
const BEFORE_REGEX = /[=(,:;!&|?+[{}>~*%^\-]$/;

/**
 * The keywords a regex literal may follow directly, which `BEFORE_REGEX` cannot see because
 * they end in a letter. Literal, and matched against the text before the slash.
 */
const BEFORE_REGEX_KEYWORD =
  /\b(?:return|typeof|case|in|of|new|delete|void|yield|await|do|else)\s*$/;

/** One string or template chunk found on a line, so its whole contents can be judged. */
type Quoted = { from: number; to: number; contents: string };

/** One line with everything that is not code blanked out, and the quotes it held. */
export type Masked = {
  /** The line, same length, with every non-code span replaced by `FILL`. */
  text: string;
  /** True when a single- or double-quoted string was left open at the end of the line. */
  unterminated: boolean;
  /** Every string literal and template chunk the line held, with its contents. */
  quotes: Quoted[];
};

/**
 * Where the lexer is between lines: inside a block comment, and how deep into templates and
 * their `${…}` substitutions.
 *
 * A frame is either code -- counting its own braces, so a `}` can be told from the one that
 * closes a substitution -- or the literal part of a template.
 */
type Frame = { kind: "code"; braces: number } | { kind: "template" };
type Carry = { stack: Frame[]; inBlockComment: boolean };

const freshCarry = (): Carry => ({ stack: [{ kind: "code", braces: 0 }], inBlockComment: false });

/**
 * Where a quoted span opened at `from` ends, honouring backslash escapes and -- for a regex
 * -- a character class, whose `/` does not close the pattern. `-1` when it never closes on
 * this line.
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

/** May a regex literal start at `at`, given the code before it on this line? */
const regexMayStart = (masked: string, at: number): boolean => {
  const before = masked.slice(0, at);
  const bare = before.trimEnd();

  return bare === "" || BEFORE_REGEX.test(bare) || BEFORE_REGEX_KEYWORD.test(bare);
};

/** One line masked, and the lexer state the next line starts in. */
function maskLine(line: string, carry: Carry): { masked: Masked; carry: Carry } {
  const out = [...line];
  const quotes: Quoted[] = [];
  let inBlockComment = carry.inBlockComment;
  const stack: Frame[] = carry.stack.map((frame) => ({ ...frame }));
  let unterminated = false;

  const blank = (from: number, to: number): void => {
    for (let at = from; at <= to; at += 1) out[at] = FILL;
  };
  const done = (): { masked: Masked; carry: Carry } => ({
    masked: { text: out.join(""), unterminated, quotes },
    carry: { stack, inBlockComment },
  });

  let at = 0;

  while (at < line.length) {
    if (inBlockComment) {
      const close = line.indexOf("*/", at);

      if (close === -1) {
        blank(at, line.length - 1);
        return done();
      }
      blank(at, close + 1);
      inBlockComment = false;
      at = close + 2;
      continue;
    }

    const frame = stack[stack.length - 1] ?? { kind: "code", braces: 0 };

    if (frame.kind === "template") {
      const character = line[at];

      if (character === "\\") {
        blank(at, Math.min(at + 1, line.length - 1));
        at += 2;
        continue;
      }
      if (character === "`") {
        // The delimiter stays; the chunk before it was blanked as it was walked.
        stack.pop();
        at += 1;
        continue;
      }
      if (character === "$" && line[at + 1] === "{") {
        // A substitution is code, and the one place a call can hide inside a template.
        stack.push({ kind: "code", braces: 0 });
        at += 2;
        continue;
      }
      blank(at, at);
      at += 1;
      continue;
    }

    const character = line[at];
    const next = line[at + 1];

    if (character === "/" && next === "/") {
      blank(at, line.length - 1);
      return done();
    }
    if (character === "/" && next === "*") {
      const close = line.indexOf("*/", at + 2);

      if (close === -1) {
        blank(at, line.length - 1);
        inBlockComment = true;
        return done();
      }
      blank(at, close + 1);
      at = close + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const close = spanEnd(line, at + 1, character, false);

      if (close === -1) {
        // Not legal in a compiling program, so it is a line this scan declines to judge.
        blank(at, line.length - 1);
        unterminated = true;
        return done();
      }
      quotes.push({ from: at, to: close, contents: line.slice(at + 1, close) });
      blank(at + 1, close - 1);
      at = close + 1;
      continue;
    }
    if (character === "`") {
      // A template's chunks are blanked as they are walked, and recorded when it closes on
      // this line, which is the case that matters: `workspace[`saveStateFile`]`.
      const close = spanEnd(line, at + 1, "`", false);

      if (close !== -1 && !line.slice(at + 1, close).includes("${")) {
        quotes.push({ from: at, to: close, contents: line.slice(at + 1, close) });
        blank(at + 1, close - 1);
        at = close + 1;
        continue;
      }
      stack.push({ kind: "template" });
      at += 1;
      continue;
    }
    if (character === "{") {
      if (frame.kind === "code") frame.braces += 1;
      at += 1;
      continue;
    }
    if (character === "}") {
      if (frame.kind === "code" && frame.braces > 0) frame.braces -= 1;
      else if (stack.length > 1) stack.pop();
      at += 1;
      continue;
    }
    if (character === "/" && regexMayStart(out.join(""), at)) {
      const close = spanEnd(line, at + 1, "/", true);

      if (close !== -1) {
        quotes.push({ from: at, to: close, contents: line.slice(at + 1, close) });
        blank(at + 1, close - 1);
        at = close + 1;
        continue;
      }
      // Not a regex after all -- a lone division. Read on.
    }
    at += 1;
  }

  return done();
}

/** A whole file masked, one entry per line, the lexer carrying its state between them. */
export function maskSource(source: string): Masked[] {
  let carry = freshCarry();

  return source.split("\n").map((line) => {
    const read = maskLine(line, carry);

    carry = read.carry;

    return read.masked;
  });
}

/** Call-shaped: the name is immediately applied. Literal. */
const APPLIED = /^\s*\(/;
/** Reached through a dot, optional-chained or not: `workspace.saveStateFile(`. Literal. */
const THROUGH_A_DOT = /(?:\?)?\.$/;
/** Nothing but indentation, and perhaps `async`, before the name: a member being defined. */
const DEFINES_A_MEMBER = /^\s*(?:async\s+)?$/;
/**
 * What sits between a member's parameter list and its body: an optional return type, then the
 * `{` that opens it. Literal, and the rest of the line is not looked at, so a whole method
 * written on one line is read as the method it is.
 *
 * This is what tells a definition from a bare call at the margin.
 * `saveStateFile(ref, save).then(() => {` ends in `{` too, and a scan that asked only about
 * the last character read it as an adapter -- which also let its sibling test call the port.
 */
const OPENS_A_BODY = /^\s*(?::[^;{]*)?\{/;
/**
 * What ends a signature rather than opening a body: a return type, then the `;`. Literal.
 *
 * The return type is **required**, and that is the whole point of the pattern. Without it,
 * `saveStateFile(ref, save);` at the margin -- a bare call on a destructured binding -- reads
 * as the port's own declaration and escapes. This repository compiles under `strict`, so a
 * method signature always states what it returns; a bare call never does.
 */
const ENDS_A_SIGNATURE = /^\s*:[^;{]*;\s*$/;
/**
 * A member given as a property rather than as a method: `saveStateFile: async (ref, save) =>`.
 * Both adapters use method shorthand today, so nothing in the repository takes this form --
 * but a stub or a fake naturally would, and reading it as a *finding* would have made the next
 * object-literal adapter fight the check. Literal.
 */
const NAMES_A_PROPERTY = /^\s*:/;
/** A bracket opening a computed access, ignoring whitespace. Literal. */
const OPENS_A_BRACKET = /\[\s*$/;
/** A bracket closing one and applying what it found, ignoring whitespace. Literal. */
const CLOSES_AND_APPLIES = /^\s*\]\s*\(/;

/** Where the parameter list opened at `from` closes on this line, or -1. */
const parenEnd = (masked: string, from: number): number => {
  let depth = 0;

  for (let at = from; at < masked.length; at += 1) {
    if (masked[at] === "(") depth += 1;
    else if (masked[at] === ")") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }

  return -1;
};

/** What the name at `at` in `line` is, given the line's masked twin. */
function classify(line: string, masked: Masked, at: number): MentionKind {
  if (masked.unterminated) return "unreadable";

  const before = line.slice(0, at);
  const after = line.slice(at + METHOD.length);
  const isCode = masked.text.slice(at, at + METHOD.length) === METHOD;

  if (!isCode) {
    const holding = masked.quotes.find((quote) => quote.from < at && at < quote.to);

    // Named inside something longer: prose in a message, or a pattern a test asserts with.
    if (holding?.contents !== METHOD) return "text";

    // The name alone, as data. `workspace["saveStateFile"](…)` is a call; every other way of
    // handing the bare name about is a reach that becomes a call elsewhere.
    const bracketed =
      OPENS_A_BRACKET.test(line.slice(0, holding.from)) &&
      CLOSES_AND_APPLIES.test(line.slice(holding.to + 1));

    return bracketed ? "call" : "reference";
  }
  const atTheMargin = DEFINES_A_MEMBER.test(before);

  if (!APPLIED.test(after)) {
    // A property, in an object literal or in a type: `saveStateFile: async (ref, save) => {`.
    // A signature ends in `;`; anything else at the margin is a value, so a definition.
    if (atTheMargin && NAMES_A_PROPERTY.test(after)) {
      return line.trimEnd().endsWith(";") ? "declaration" : "implementation";
    }

    // Taken rather than called. `const save = workspace.saveStateFile;` is a call elsewhere.
    return "reference";
  }
  if (THROUGH_A_DOT.test(before)) return "call";
  if (atTheMargin) {
    const opened = masked.text.indexOf("(", at + METHOD.length);
    const closed = parenEnd(masked.text, opened);

    // A parameter list left open is a signature wrapped over several lines.
    if (closed === -1) return "implementation";

    const rest = line.slice(closed + 1);

    if (OPENS_A_BODY.test(rest)) return "implementation";
    if (ENDS_A_SIGNATURE.test(rest)) return "declaration";

    // Call-shaped at the margin, and neither a body nor a signature follows it: a bare call
    // on a binding something else made.
    return "call";
  }

  // A bare name being applied -- what a destructuring of the port would leave behind.
  return "call";
}

/** Every occurrence of the method name in one file's source, in the order they appear. */
export function mentions(file: string, source: string): Mention[] {
  const masked = maskSource(source);

  return source.split("\n").flatMap((line, index) => {
    if (!line.includes(METHOD)) return [];

    const twin = masked[index];

    if (twin === undefined) return [];

    const found: Mention[] = [];

    for (let at = line.indexOf(METHOD); at !== -1; at = line.indexOf(METHOD, at + 1)) {
      found.push({ file, line: index + 1, text: line.trim(), kind: classify(line, twin, at) });
    }

    return found;
  });
}

/**
 * How many times the name appears in a file's text at all, prose included. The independent
 * count `clock-pattern.ts` cross-checks its scan against, and the reason this file has one:
 * every occurrence the source holds has to be an occurrence the scan looked at, or the scan
 * is walking past something. A search, not a match.
 */
export const nameCount = (source: string): number => source.split(METHOD).length - 1;

/** Whether a name is a test file, by the spelling this project's suite picks up. */
const TEST_FILE = /\.test\.(tsx?|mts|cts)$/;

/**
 * The module a test file is a test of -- `server/src/workspace.fs.test.ts` is a test of
 * `server/src/workspace.fs.ts` -- or `undefined` when the file is not a test at all.
 */
export function moduleUnderTest(file: string): string | undefined {
  const found = TEST_FILE.exec(file);

  return found === null ? undefined : `${file.slice(0, found.index)}.${found[1]}`;
}

/** Every file that implements the method: the port's adapters, found rather than listed. */
export const implementors = (all: readonly Mention[]): string[] =>
  [
    ...new Set(all.filter((mention) => mention.kind === "implementation").map((m) => m.file)),
  ].sort();

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

/** The rule as a sentence of its own, for a message that has to start one. */
const Rule = `${RULE.charAt(0).toUpperCase()}${RULE.slice(1)}`;

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
      `${at}\n  This line names \`${METHOD}\` and could not be read: a quote was left open at ` +
      `the end of it, or the name sits at the margin in a shape that is neither a definition ` +
      `nor a call, so the scan cannot tell one from the other. Rewrite the line rather than ` +
      `leaving the question open — ${RULE}.`
    );
  }

  const subject = moduleUnderTest(finding.file);

  if (subject !== undefined) {
    return (
      `${at}\n  A test reaches \`${METHOD}\` here, and \`*.test.ts\` is not waved through: ` +
      `only the test of a module that implements the port may exercise it, and \`${subject}\` ` +
      `does not. Save through \`editStateFile\` as production does, or — if the port itself is ` +
      `the subject — put the test beside the adapter it tests. ${Rule}.`
    );
  }

  const reached =
    finding.kind === "reference"
      ? `reaches \`${METHOD}\` without calling it there, which is a call wherever it is handed to`
      : `calls \`${METHOD}\` directly`;

  return `${at}\n  \`${finding.file}\` ${reached}, and only \`${WRITER}\` may: ${RULE}.`;
};
