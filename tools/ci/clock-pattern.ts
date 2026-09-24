/**
 * The one body every clock pattern in this repository is built from, and the scan that
 * finds a pattern built from anything else.
 *
 * [ADR-0012](../../docs/adr/0012-one-clock-pattern-across-core-and-web.md) keeps the clock
 * pattern written out wherever a clock is read or validated -- `web` never imports `core`
 * ([ADR-0002](../../docs/adr/0002-domain-behind-http-api-thin-ui.md)) and a schema is the
 * contract rather than a derivation of it -- so the copies are deliberate and what needs
 * guarding is that they agree. They are not all the same *pattern*: `CLOCK_RANGE` in the
 * Shoham dialect is unanchored, global, and holds the body twice with a separator between,
 * and it is correct. What every one of them shares is the body, `([01]\d|2[0-3]):[0-5]\d`
 * -- the thing that says what an hour and a minute are.
 *
 * **So the invariant is the body, not the pattern**, and it is checked by discovery rather
 * than against a list of files: a sixth file that starts carrying a clock pattern is judged
 * exactly like the five that carry one today, without being named anywhere.
 *
 * What it does not see is a clock pattern that is not a regex literal: one handed to
 * `new RegExp` as a string, or concatenated from pieces. Every clock pattern in this
 * repository is a literal, and extending the scan to string literals was measured -- it
 * finds nothing more here and costs a false positive on `"[::1]:8900"`, a loopback address
 * with a port, where a class holding a digit sits against digits. So the line is drawn at
 * literals, and drawn here rather than left to be discovered.
 *
 * Nothing here is executed, compiled or built from what it reads
 * ([ADR-0007](../../docs/adr/0007-requirements-are-interpreted-data.md)). Every pattern
 * below is a literal written out in this file, and source text is only ever searched and
 * sliced with them.
 */

/**
 * The shared body: what an hour and a minute are. A plain string rather than a `RegExp`,
 * because it is searched for in source text and never matched against anything.
 *
 * This is the invariant. A clock pattern may anchor it, repeat it, or wrap a separator
 * around it; it may not respell it.
 */
export const CLOCK_BODY = String.raw`([01]\d|2[0-3]):[0-5]\d`;

/**
 * A regex literal as it is written in source: a slash, a body that does not cross a line,
 * a closing slash, flags. The prefix is the set of characters a regex literal can legally
 * follow, which keeps most divisions, and the two slashes that open a comment, from being
 * read as one.
 *
 * Literal, and approximate on purpose. It is a text scan and not a parser, so it will
 * occasionally offer up something that is not a regex literal at all -- a pair of slashes
 * inside a block comment, a division in the middle of an expression. That costs nothing:
 * `isClockSeam` then finds no clock in it and it is dropped.
 *
 * Missing a literal is the expensive direction, and only half of it is testable: the test
 * cross-checks this scan against a plain text search for the body, which catches a literal
 * *carrying the body* that the scan walked past. A divergent literal it walks past is the
 * half nothing can count, because there is nothing to count it against -- which is why the
 * scan is deliberately loose and the seams, not the literals, do the judging.
 */
const REGEX_LITERAL =
  /(?:^|[=(,:;!&|?+[{}\s>])(\/(?![*/])(?:\[(?:\\.|[^\]\\\n])*\]|\\.|[^/\\\n[])+\/[a-z]*)/gm;

/**
 * What can sit between a colon and the thing that really matches the hour or the minute:
 * group closers and quantifiers on the left, group openers on the right, and a whitespace
 * construct on either. All literal, and peeled off before the digit matchers are asked.
 *
 * `([01]\d|2[0-3])` matches digits and `(?:background|color|border[^:]*)` does not, and the
 * `)` they both end with says nothing about which. Peeling it, and any quantifier with it,
 * puts the question to the thing inside: `2[0-3]` against `border[^:]*`.
 *
 * `\s*` is peeled for the same reason and is the sharper case: a reader made lenient about
 * whitespace -- `/^([01]\d|2[0-3])\s*:\s*[0-5]\d$/` -- is exactly the drift issues #48 and
 * #54 are about, and it would otherwise hide behind the `\s` next to the colon.
 */
const TRAILING_NOISE = /(?:\)|\?|\*|\+|\{\d+(?:,\d*)?\}|\\s|\\t)$/;
const LEADING_NOISE =
  /^(?:\((?:\?:|\?=|\?!|\?<=|\?<!|\?<[A-Za-z_$][\w$]*>)?|(?:\\s|\\t)[*+?]?)/;

/**
 * How a regex can say "a digit" at the very edge of where it is looked at. Literal, both
 * pairs: a `\d`, or a character class that is not negated and holds a digit -- and,
 * separately, a digit simply written out.
 *
 * The two are kept apart because they mean different things about the text around them. A
 * class or a `\d` is a *construct*: whoever wrote it was describing what a digit is. A digit
 * written out is content -- `09` in `/09:00/` is a clock string a test is matching, not a
 * second opinion about what a clock is.
 */
const CONSTRUCT_AT_END = /(?:\\d|\[(?!\^)[^\]]*\d[^\]]*\])$/;
const DIGIT_AT_END = /\d$/;
const CONSTRUCT_AT_START = /^(?:\\d|\[(?!\^)[^\]]*\d[^\]]*\])/;
const DIGIT_AT_START = /^\d/;

/**
 * One side of a colon with the noise taken off, so the digit matchers are asked about what
 * does the matching rather than about the brackets and spacing around it.
 */
const withoutNoise = (side: string, noise: RegExp): string => {
  let bare = side;

  while (noise.test(bare)) bare = bare.replace(noise, "");

  return bare;
};

/**
 * Is this colon the seam of a clock pattern -- an hour, a colon, a minute -- rather than a
 * colon that merely happens to be inside a regex?
 *
 * Both sides have to match a digit, and at least one of them has to do it with a construct.
 * So `/^\d\d:\d\d$/` and `/^(\d{1,2}):([0-5]\d)$/` are clock patterns, while `/09:00/` is a
 * clock string a test asserts on. `/^permissions:/`, `/^\s+([a-z-]+):\s*write\s*$/`,
 * `/pr-review:commit=([0-9a-f]{7,40})/`, `/(?:background|border[^:]*):[^;]*#[0-9a-f]{3,6}/`
 * and every `(?:` are none of the three, and this repository holds all of them.
 */
const isClockSeam = (left: string, right: string): boolean => {
  const hour = withoutNoise(left, TRAILING_NOISE);
  const minute = withoutNoise(right, LEADING_NOISE);

  return (
    (CONSTRUCT_AT_END.test(hour) || DIGIT_AT_END.test(hour)) &&
    (CONSTRUCT_AT_START.test(minute) || DIGIT_AT_START.test(minute)) &&
    (CONSTRUCT_AT_END.test(hour) || CONSTRUCT_AT_START.test(minute))
  );
};

/**
 * The ways a regex can write a colon without writing one: escaped, alone in a class, or as a
 * code point. All literal, and all replaced by a plain colon before the seams are counted, so
 * `/^([01]\d|2[0-3])[:][0-5]\d$/` is read as the respelling it is rather than waved through.
 *
 * The replacement happens *after* the shared bodies are removed. A pattern that spells the
 * body's own colon some other way is not the body, and this is what keeps it a finding
 * instead of quietly normalising it into agreement.
 */
const COLON_SPELLINGS = [
  String.raw`\:`,
  "[:]",
  String.raw`\u003a`,
  String.raw`\u003A`,
  String.raw`\u{3a}`,
  String.raw`\u{3A}`,
  String.raw`\x3a`,
  String.raw`\x3A`,
];

const withPlainColons = (text: string): string =>
  COLON_SPELLINGS.reduce((plain, spelling) => plain.split(spelling).join(":"), text);

/**
 * Lines that are prose rather than code: a `//` comment, or a line of a `/* ... *\/` block.
 *
 * Only whole lines, and only for *counting* the body in a file's text -- a code line is never
 * touched, so a regex literal cannot be damaged by this. It is here because this repository
 * documents its patterns in prose constantly, and a docstring that quotes the shared body is
 * quoting it, not respelling it. (`tools/ci/workflows.ts` strips comments for the same reason,
 * and names `ci.yml`'s own prose as the reason.)
 */
const PROSE_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** A file's text with its prose lines dropped, for counting what the code itself holds. */
export const codeOnly = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !PROSE_LINE.test(line))
    .join("\n");

/** How many times the shared body appears in a piece of text. A search, not a match. */
export const bodyCount = (text: string): number => text.split(CLOCK_BODY).length - 1;

/** A regex literal found in source, and the line it starts on, counted from one. */
export type Literal = { line: number; text: string };

/** Every regex literal in a file's text, in the order they appear. */
export const regexLiterals = (text: string): Literal[] =>
  [...text.matchAll(REGEX_LITERAL)].map((match) => ({
    line: text.slice(0, match.index).split("\n").length,
    // The prefix character is part of the match and not part of the literal.
    text: match[1] ?? "",
  }));

/**
 * The clock seams in a regex literal that no occurrence of the shared body accounts for.
 *
 * Every occurrence of the body is removed first, so what is left of a pattern built from it
 * is only anchors, flags and separators -- nothing that reads an hour and a minute. Any
 * seam still standing in the remainder is a second opinion about what a clock is.
 */
const straySeams = (literal: string): string[] => {
  const remainder = withPlainColons(literal.split(CLOCK_BODY).join(""));

  return [...remainder]
    .map((character, at) => ({ character, at }))
    .filter(
      ({ character, at }) =>
        character === ":" && isClockSeam(remainder.slice(0, at), remainder.slice(at + 1)),
    )
    // A dozen characters either side: enough of the neighbourhood for a reader to recognise
    // the pattern in the failure, and `Math.max` because a negative start would slice from
    // the end of the string and quote something from the wrong place entirely.
    .map(({ at }) => remainder.slice(Math.max(0, at - 12), at + 13));
};

/** One clock pattern in one file: where it is, and what it is built from. */
export type ClockPattern = {
  file: string;
  line: number;
  /** The regex literal as it is written. */
  text: string;
  /** How many times the shared body appears in it. */
  bodies: number;
  /**
   * The seams the shared body does not account for, with the text around each. Empty is
   * the invariant holding: every clock this pattern reads, it reads through the body.
   */
  strays: string[];
};

/**
 * Every clock pattern in one file's text: the regex literals that carry the shared body,
 * plus any that read a clock some other way. A regex with no clock in it is not returned.
 *
 * `file` is carried through untouched so a finding can name itself; nothing is opened here.
 */
export const clockPatterns = (file: string, text: string): ClockPattern[] =>
  regexLiterals(text)
    .map(({ line, text: literal }) => ({
      file,
      line,
      text: literal,
      bodies: bodyCount(literal),
      strays: straySeams(literal),
    }))
    .filter((pattern) => pattern.bodies > 0 || pattern.strays.length > 0);
