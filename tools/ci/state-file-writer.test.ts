import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_DIRS as COLLECTED_DIRS } from "../pr-report/collect.ts";
import {
  METHOD,
  RULE,
  SOURCE_DIRS,
  SOURCE_EXTENSIONS,
  WRITER,
  explain,
  implementors,
  maskSource,
  mayCall,
  mentions,
  moduleUnderTest,
  nameCount,
  secondWriters,
  type Finding,
  type Mention,
} from "./state-file-writer.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Not source this repository writes. The walk is rooted at the four source trees rather than
 * at the repo, so `node_modules` and `dist` are not on the way -- but a `__fixtures__` folder
 * is, and a fixture is data rather than code that runs.
 */
const SKIPPED_DIRECTORIES = ["__fixtures__"];

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.includes(entry.name) ? [] : sourceFiles(path);
    }

    return SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });

/**
 * Every file the rule governs, repo-relative and sorted.
 *
 * This scan's own two files are not among them and need no excluding: they live in `tools/ci`
 * and the walk only enters the four source trees. They are the only files that write the
 * method's name down as *data*, so a walk that did reach them would read `METHOD` itself as a
 * mention -- `clock-pattern.test.ts` leaves its own pair out by name for exactly that reason,
 * and the narrower root is what spares this one the exception.
 */
const governed = (): string[] =>
  SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .map((path) => relative(ROOT, path))
    .sort();

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

/** Every mention the rule governs, from the disk. */
const everyMention = (): Mention[] => governed().flatMap((file) => mentions(file, read(file)));

const filesOfKind = (kind: Mention["kind"]): string[] => [
  ...new Set(everyMention().filter((mention) => mention.kind === kind).map((m) => m.file)),
];

describe("the State File writers in this repository", () => {
  it("has source to read, so a passing suite is not an empty walk", () => {
    // The walk reads the disk, so an untracked file is judged too -- a new second writer
    // fails before it is committed rather than after. A glob that matched nothing would
    // otherwise pass this whole file in silence, which is the failure this line exists for.
    expect(governed().length).toBeGreaterThan(0);
    expect(governed()).toContain(WRITER);
  });

  /**
   * The independent count, and the defence `clock-pattern.test.ts` carries that a first
   * version of this file did not: *"looked at every occurrence of the body the source holds"*.
   *
   * A plain text search knows nothing about comments, quotes or syntax, so it cannot be fooled
   * by the lexer being wrong. Every occurrence the source holds has to be one the scan
   * classified -- prose included, which is why the scan no longer drops whole lines before
   * judging them. It is the one assertion here that fails when the scan *stops seeing*, rather
   * than when the repository changes, and the hole it would have caught was real: a line
   * starting `/* … *\/` followed by a live call used to vanish entirely.
   */
  it("looked at every occurrence of the name the source holds", () => {
    const walkedPast = governed()
      .map((file) => ({ file, text: read(file) }))
      .map(({ file, text }) => ({
        file,
        inText: nameCount(text),
        classified: mentions(file, text).length,
      }))
      .filter(({ inText, classified }) => inText !== classified)
      .map(
        ({ file, inText, classified }) =>
          `${file}: the name appears ${inText} times in the file but the scan classified ` +
          `${classified} of them, so it is walking past one — every occurrence has to be ` +
          `judged, including one written in prose, which is what \`text\` is for`,
      );

    expect(walkedPast).toEqual([]);
  });

  // The canary, and the half that makes the rest mean anything. If the scan silently stopped
  // recognising the shapes it is built to recognise -- a rename, a reformat, a lexer that
  // started eating code -- every list below would go empty and every assertion would agree
  // with itself. So the subject is pinned: the port declares the method in one file, exactly
  // two adapters implement it, and production calls it exactly once, in the wrapper.
  //
  // No line number is pinned. `clock-pattern.test.ts` pins none either, and the reason is the
  // same: a line number is not the invariant, and a concurrent edit above the call would fail
  // this check with a numeric diff that says nothing about the rule.
  it("finds the port, its adapters, and exactly one production call", () => {
    expect(filesOfKind("declaration")).toEqual(["app/src/workspace.ts"]);

    // Exact, not `toContain`. A new file implementing the method makes its sibling test
    // exempt, so a third implementor has to be argued for here rather than arriving quietly.
    expect(implementors(everyMention())).toEqual([
      "app/src/workspace.memory.ts",
      "server/src/workspace.fs.ts",
    ]);

    const production = everyMention().filter(
      (mention) => mention.kind === "call" && moduleUnderTest(mention.file) === undefined,
    );

    expect(production.map((mention) => mention.file)).toEqual([WRITER]);
  });

  // The rule itself.
  it("has no second write path", () => {
    expect(secondWriters(everyMention()).map(explain)).toEqual([]);
  });

  // The two adapters' tests call the port on purpose, and they are the reason an exemption
  // exists at all. Pinned here so that a change which "fixed" the rule by silencing them
  // would be visible as a change to this line.
  it("lets the two adapters' own tests exercise the port", () => {
    const testing = filesOfKind("call")
      .filter((file) => moduleUnderTest(file) !== undefined)
      .sort();

    expect(testing).toEqual([
      "app/src/workspace.memory.test.ts",
      "server/src/workspace.fs.test.ts",
    ]);
  });

  // Prose naming the method is prose, and this repository writes plenty of it. The files are
  // pinned rather than the count, because a docstring gaining a sentence is not a change to
  // the rule -- but prose appearing in a file that had none is worth a reader's eye.
  it("reads the name in docstrings, a message and a pattern as the prose it is", () => {
    expect(filesOfKind("text").sort()).toEqual([
      "app/src/workspace.test.ts",
      "app/src/workspace.ts",
      "core/src/state/file.ts",
      "server/src/workspace.fs.test.ts",
    ]);
  });

  it("finds no line it could not read", () => {
    const unreadable = everyMention().filter(
      (mention): mention is Finding => mention.kind === "unreadable",
    );

    expect(unreadable.map(explain)).toEqual([]);
  });

  // One list, two readers. `collect.ts` walks these four to build the graphs and this walks
  // them to judge the writes; a fifth workspace added to one and not the other would be a
  // tree nothing here looks at, passing quietly.
  it("governs the same trees the report collects", () => {
    expect(SOURCE_DIRS).toEqual(COLLECTED_DIRS);
  });
});

const kinds = (file: string, source: string): string[] =>
  mentions(file, source).map((mention) => mention.kind);

describe("the shapes that define the port, which are not calls to it", () => {
  it("reads the port's own signature as a declaration", () => {
    const source = "  saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<Version>;";

    expect(kinds("app/src/workspace.ts", source)).toEqual(["declaration"]);
  });

  it("reads an adapter's method as an implementation", () => {
    const source =
      "    async saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<Version> {";

    expect(kinds("server/src/workspace.fs.ts", source)).toEqual(["implementation"]);
  });

  it("reads a method written without async as an implementation too", () => {
    expect(kinds("app/src/workspace.stub.ts", "  saveStateFile(ref, save) {")).toEqual([
      "implementation",
    ]);
  });

  it("reads a whole method written on one line as an implementation", () => {
    // The body need not be on its own line: what matters is that a body opens at all.
    expect(kinds("app/src/workspace.stub.ts", "  saveStateFile(ref, save) { return v; }")).toEqual([
      "implementation",
    ]);
  });

  it("reads a signature wrapped over several lines as an implementation", () => {
    const source = [
      "    async saveStateFile(",
      "      ref: StateFileRef,",
      "      save: StateFileSave,",
      "    ): Promise<Version> {",
    ].join("\n");

    expect(kinds("server/src/workspace.fs.ts", source)).toEqual(["implementation"]);
  });

  // Both adapters use method shorthand, so nothing in the repository takes this form today.
  // A stub or a fake naturally would, and reading it as a finding would have made the next
  // object-literal adapter fight the check instead of being one.
  it("reads an adapter written as an object-literal property as an implementation", () => {
    for (const source of [
      "    saveStateFile: async (ref, save) => {",
      "    saveStateFile: async function (ref, save) {",
    ]) {
      expect(kinds("app/src/workspace.fake.ts", source), source).toEqual(["implementation"]);
    }
  });

  it("reads a property in a type literal as a declaration", () => {
    const source = "  saveStateFile: (ref: StateFileRef, save: StateFileSave) => Promise<Version>;";

    expect(kinds("app/src/workspace.ts", source)).toEqual(["declaration"]);
  });
});

describe("the shapes that reach the port", () => {
  it("reads a call through the port as a call", () => {
    const source = "  version = await workspace.saveStateFile({ kind: 'state', name }, save);";

    expect(kinds(WRITER, source)).toEqual(["call"]);
  });

  it("reads a call continuing a chain on its own line as a call", () => {
    // `server/src/workspace.fs.test.ts` and `app/src/workspace.memory.test.ts` are both
    // written this way, so a scan that only looked for `x.saveStateFile` would miss it.
    expect(kinds("app/src/x.ts", "      .saveStateFile(alice, firstSave(STATE))")).toEqual([
      "call",
    ]);
  });

  it("reads an optional-chained call as a call", () => {
    expect(kinds("app/src/x.ts", "  await workspace?.saveStateFile(ref, save);")).toEqual(["call"]);
  });

  it("reads a cast's call as a call", () => {
    expect(kinds("app/src/x.ts", "  await (workspace as any).saveStateFile(ref, save);")).toEqual([
      "call",
    ]);
  });
});

describe("prose, which names the method without reaching it", () => {
  it("reads a docstring's mention as prose, across however many lines", () => {
    const source = [
      "/**",
      " * A State File is saved through `saveStateFile`, which carries the revision.",
      " * It is the only writer; see `saveStateFile` again for the reason.",
      " */",
      "export const nothing = 1;",
    ].join("\n");

    expect(kinds("app/src/workspace.ts", source)).toEqual(["text", "text"]);
  });

  it("reads a line comment's mention as prose, even beside code", () => {
    expect(kinds("app/src/x.ts", "const a = 1; // saveStateFile goes through the wrapper")).toEqual(
      ["text"],
    );
  });

  it("reads the name inside a message string as prose", () => {
    const source = '      "read through readStateFile and saved through saveStateFile",';

    expect(kinds("app/src/workspace.ts", source)).toEqual(["text"]);
  });

  it("reads the name inside a regex literal as prose", () => {
    // `app/src/workspace.test.ts` asserts the message above. The quote inside the pattern is
    // why the lexer has to know a regex from a string.
    const source = '    /State File "alice".*readStateFile.*saveStateFile/s,';

    expect(kinds("app/src/workspace.test.ts", source)).toEqual(["text"]);
  });

  it("finds two mentions on one line, and judges each on its own", () => {
    const source = '  log("a saveStateFile note"); await workspace.saveStateFile(ref, save);';

    expect(kinds("app/src/x.ts", source)).toEqual(["text", "call"]);
  });
});

describe("the ways round a dot, each of which is still a reach", () => {
  // The question a reviewer was asked to try: can the check be walked past? Every line here
  // reaches the port without writing `workspace.saveStateFile(`, and each one was found by a
  // reviewer trying to defeat an earlier version of this scan. Nine of them escaped it.

  it("catches a call hidden behind a closed block comment, which used to vanish", () => {
    // The hole that mattered most, and not an adversarial spelling: `/* c8 ignore next */` in
    // front of a call produces it. An earlier version dropped any line starting with `/*`
    // before masking, so the comment took the call with it and the suite stayed green.
    const source = "  /* fast path */ return await workspace.saveStateFile(ref, save);";

    expect(kinds("server/src/api.ts", source)).toEqual(["call"]);
  });

  it("catches a call on a line that begins with a continuation asterisk", () => {
    const source = "  * (await workspace.saveStateFile(ref, save)).value;";

    expect(kinds("server/src/api.ts", source)).toEqual(["call"]);
  });

  it("catches a computed access, spaced or not", () => {
    for (const source of [
      '  await workspace["saveStateFile"](ref, save);',
      '  await workspace[ "saveStateFile" ](ref, save);',
      "  await workspace['saveStateFile'](ref, save);",
      "  await workspace[`saveStateFile`](ref, save);",
    ]) {
      expect(kinds("app/src/x.ts", source), source).toEqual(["call"]);
    }
  });

  it("catches the name as a bare string, however it is then used", () => {
    // A string whose whole contents is the name is the name being handed about as data. Prose
    // names it inside a sentence; this does not.
    for (const source of [
      '  await Reflect.get(workspace, "saveStateFile").call(workspace, ref, save);',
      '  const KEY = "saveStateFile";',
      '  const table = { save: "saveStateFile" };',
    ]) {
      expect(kinds("app/src/x.ts", source), source).toEqual(["reference"]);
    }
  });

  it("catches a call inside a template's substitution", () => {
    const source = "  return `rev ${(await workspace.saveStateFile(ref, save)).value}`;";

    expect(kinds("app/src/x.ts", source)).toEqual(["call"]);
  });

  it("catches a call between two divisions, which used to read as one regex", () => {
    // `BEFORE_REGEX` once accepted whitespace alone, so `a / b` opened a pattern that closed
    // at the next `/` and blanked everything between -- the call included.
    const source = "  const x = a / b, v = await workspace.saveStateFile(ref, save), y = c / d;";

    expect(kinds("app/src/x.ts", source)).toEqual(["call"]);
  });

  it("catches a bare call, which is what destructuring the port leaves behind", () => {
    for (const source of [
      "  await saveStateFile(ref, save);",
      "  saveStateFile(ref, save);",
      "  saveStateFile(ref, save).then(() => {",
    ]) {
      expect(kinds("app/src/x.ts", source), source).toEqual(["call"]);
    }
  });

  it("catches the destructuring itself, before anything is called", () => {
    expect(kinds("app/src/x.ts", "  const { saveStateFile } = workspace;")).toEqual(["reference"]);
  });

  it("catches the method taken as a value and handed somewhere else", () => {
    for (const source of [
      "  const save = workspace.saveStateFile;",
      "  return [workspace.saveStateFile, other];",
      "  queue.push(workspace.saveStateFile);",
      "  await workspace.saveStateFile?.(ref, save);",
    ]) {
      expect(kinds("app/src/x.ts", source), source).toEqual(["reference"]);
    }
  });

  it("catches an import of the name, however unlikely", () => {
    expect(kinds("app/src/x.ts", '  import { saveStateFile } from "./workspace.ts";')).toEqual([
      "reference",
    ]);
  });

  it("catches a spread of the port and a call on the copy", () => {
    const source = ["  const copy = { ...workspace };", "  await copy.saveStateFile(ref, save);"].join(
      "\n",
    );

    expect(kinds("app/src/x.ts", source)).toEqual(["call"]);
  });

  it("says so when a line leaves a quote open, rather than guessing", () => {
    expect(kinds("app/src/x.ts", "  const broken = 'saveStateFile")).toEqual(["unreadable"]);
  });
});

describe("moduleUnderTest", () => {
  it("names the module a test is a test of", () => {
    expect(moduleUnderTest("server/src/workspace.fs.test.ts")).toBe("server/src/workspace.fs.ts");
    expect(moduleUnderTest("app/src/workspace.memory.test.ts")).toBe(
      "app/src/workspace.memory.ts",
    );
  });

  it("reads a .tsx test too, and keeps the extension", () => {
    expect(moduleUnderTest("web/src/week.test.tsx")).toBe("web/src/week.tsx");
  });

  it("says nothing about a file that is not a test", () => {
    expect(moduleUnderTest("app/src/edit.ts")).toBeUndefined();
    expect(moduleUnderTest("app/src/latest.ts")).toBeUndefined();
  });
});

describe("mayCall", () => {
  const adapters = ["app/src/workspace.memory.ts", "server/src/workspace.fs.ts"];

  it("lets the wrapper call it", () => {
    expect(mayCall(WRITER, adapters)).toBe(true);
  });

  it("lets the test of an adapter call it, because that test is testing the port", () => {
    expect(mayCall("server/src/workspace.fs.test.ts", adapters)).toBe(true);
  });

  it("lets a third adapter's test call it without anything being listed", () => {
    // The whole reason the exemption is derived rather than spelled out: a new adapter and
    // its test need no edit here.
    expect(
      mayCall("app/src/workspace.sqlite.test.ts", [...adapters, "app/src/workspace.sqlite.ts"]),
    ).toBe(true);
  });

  it("lets no other production file call it", () => {
    for (const file of ["app/src/plan.ts", "server/src/api.ts", "core/src/state/file.ts"]) {
      expect(mayCall(file, adapters), file).toBe(false);
    }
  });

  // The decision the ticket asks to be made deliberately. A blanket `*.test.ts` exemption is
  // how this check would become useless: a test is the easiest place for a second write path
  // to appear, and it would appear with a green suite.
  it("does not let any other test call it, blanket exemption refused", () => {
    for (const file of [
      "app/src/plan.test.ts",
      "app/src/edit.test.ts",
      "server/src/api.test.ts",
      "web/src/timetable/week.test.tsx",
    ]) {
      expect(mayCall(file, adapters), file).toBe(false);
    }
  });

  it("does not let the wrapper's own test call it either, only the wrapper", () => {
    // `app/src/edit.ts` may; `app/src/edit.test.ts` may not, because `edit.ts` implements
    // nothing. A test of the wrapper drives it through `editStateFile`, which is the point.
    expect(mayCall("app/src/edit.ts", adapters)).toBe(true);
    expect(mayCall("app/src/edit.test.ts", adapters)).toBe(false);
  });
});

describe("secondWriters", () => {
  const port: Mention = {
    file: "app/src/workspace.ts",
    line: 330,
    text: "saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<Version>;",
    kind: "declaration",
  };
  const adapter: Mention = {
    file: "server/src/workspace.fs.ts",
    line: 543,
    text: "async saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<Version> {",
    kind: "implementation",
  };
  const wrapper: Mention = {
    file: WRITER,
    line: 313,
    text: "version = await workspace.saveStateFile({ kind: 'state', name }, save);",
    kind: "call",
  };

  it("finds nothing in the shape the repository really has", () => {
    expect(secondWriters([port, adapter, wrapper])).toEqual([]);
  });

  it("finds a second production call", () => {
    const second: Mention = {
      file: "server/src/api.ts",
      line: 88,
      text: "await workspace.saveStateFile(ref, save);",
      kind: "call",
    };

    expect(secondWriters([port, adapter, wrapper, second]).map((f) => f.file)).toEqual([
      "server/src/api.ts",
    ]);
  });

  it("finds a second call in a test that is not an adapter's", () => {
    const sneaked: Mention = {
      file: "app/src/plan.test.ts",
      line: 12,
      text: "await workspace.saveStateFile(ref, save);",
      kind: "call",
    };

    expect(secondWriters([port, adapter, wrapper, sneaked]).map((f) => f.file)).toEqual([
      "app/src/plan.test.ts",
    ]);
  });

  it("derives the adapters' leave from who implements, not from a list", () => {
    const adapterTest: Mention = {
      file: "server/src/workspace.fs.test.ts",
      line: 489,
      text: "await workspace.saveStateFile(ALICE, firstSave(STATE));",
      kind: "call",
    };

    expect(secondWriters([port, adapter, wrapper, adapterTest])).toEqual([]);
    // Take the implementation away and the same call has nothing to justify it.
    expect(secondWriters([port, wrapper, adapterTest]).map((f) => f.file)).toEqual([
      "server/src/workspace.fs.test.ts",
    ]);
  });

  it("lists the same tree in the same order every time", () => {
    const one: Mention = { file: "web/src/a.ts", line: 9, text: "x", kind: "call" };
    const two: Mention = { file: "core/src/b.ts", line: 4, text: "y", kind: "reference" };
    const three: Mention = { file: "core/src/b.ts", line: 2, text: "z", kind: "call" };

    expect(secondWriters([one, two, three]).map((f) => `${f.file}:${f.line}`)).toEqual([
      "core/src/b.ts:2",
      "core/src/b.ts:4",
      "web/src/a.ts:9",
    ]);
  });
});

describe("explain", () => {
  const finding = (over: Partial<Finding> = {}): Finding => ({
    file: "server/src/api.ts",
    line: 88,
    text: "await workspace.saveStateFile(ref, save);",
    kind: "call",
    ...over,
  });

  it("says the rule and where it is written down, not just the line", () => {
    const said = explain(finding());

    expect(said).toContain("server/src/api.ts:88");
    expect(said).toContain("await workspace.saveStateFile(ref, save);");
    expect(said).toContain(WRITER);
    expect(said).toContain("CLAUDE.md");
    expect(said).toContain("Code guardrails");
    expect(said).toContain("server/src/history.ts");
    expect(said).toContain("#143");
  });

  it("tells a test what its two honest ways out are", () => {
    const said = explain(finding({ file: "app/src/plan.test.ts" }));

    expect(said).toContain("app/src/plan.ts");
    expect(said).toContain("`*.test.ts` is not waved through");
    expect(said).toContain("Save through `editStateFile` as production does");
    expect(said).toContain("put the test beside the adapter it tests");
  });

  it("says of a reference that it is a call somewhere else", () => {
    expect(explain(finding({ kind: "reference" }))).toContain("without calling it there");
  });

  it("asks for an unreadable line to be rewritten rather than judged", () => {
    const said = explain(finding({ kind: "unreadable" }));

    expect(said).toContain("could not be read");
    expect(said).toContain(RULE);
  });

  it("names the method in every message, since the reader may not know it", () => {
    for (const kind of ["call", "reference", "unreadable"] as const) {
      expect(explain(finding({ kind })), kind).toContain(METHOD);
    }
  });
});

describe("maskSource", () => {
  const masked = (source: string): string[] => maskSource(source).map((line) => line.text);

  it("keeps code exactly as it is", () => {
    const line = "  await workspace.saveStateFile(ref, save);";

    expect(masked(line)).toEqual([line]);
  });

  it("blanks what a string holds and keeps its quotes, so indices do not move", () => {
    expect(masked('const a = "hi";')).toEqual(['const a = "~~";']);
  });

  it("does not take an escaped quote for the end of a string", () => {
    expect(masked('const a = "a\\"b"; call();')).toEqual(['const a = "~~~~"; call();']);
  });

  it("blanks a regex literal and not a division", () => {
    expect(masked("const a = /ab/;")).toEqual(["const a = /~~/;"]);
    expect(masked("const a = b / c;")).toEqual(["const a = b / c;"]);
  });

  it("does not read a division after an identifier, a digit or a bracket as a pattern", () => {
    // The last *non-whitespace* character decides, which is what keeps `a / b … / d` from
    // reading as one pattern that swallows the code between.
    for (const line of ["const a = b / c, d = e / f;", "const a = xs[0] / 2 / 3;"]) {
      expect(masked(line), line).toEqual([line]);
    }
  });

  it("still reads a pattern where an expression may begin", () => {
    expect(masked("if (/ab/.test(x)) call();")).toEqual(["if (/~~/.test(x)) call();"]);
    expect(masked("return /ab/;")).toEqual(["return /~~/;"]);
  });

  it("does not take a character class's slash for the end of a pattern", () => {
    expect(masked("const a = /[/:]$/; b();")).toEqual(["const a = /~~~~~/; b();"]);
  });

  it("blanks a trailing line comment", () => {
    expect(masked("call(); // a note")).toEqual(["call(); ~~~~~~~~~"]);
  });

  it("blanks an inline block comment and reads the code after it", () => {
    expect(masked("call(/* why */ x);")).toEqual(["call(~~~~~~~~~ x);"]);
  });

  it("carries a block comment across lines and reads the code after it closes", () => {
    // The whole reason this is a lexer and not a line filter.
    expect(masked(["/* one", " * two */ call();"].join("\n"))).toEqual([
      "~~~~~~",
      "~~~~~~~~~ call();",
    ]);
  });

  it("blanks a template's text but keeps its substitutions readable", () => {
    expect(masked("const a = `x ${call()} y`;")).toEqual(["const a = `~~${call()}~~`;"]);
  });

  it("carries a template across lines, substitutions still readable", () => {
    expect(masked(["const a = `x", "  ${call()} y`;"].join("\n"))).toEqual([
      "const a = `~",
      "~~${call()}~~`;",
    ]);
  });

  it("says a line is unterminated when a quote never closes", () => {
    expect(maskSource("const a = 'start")[0]?.unterminated).toBe(true);
  });

  it("does not call a template or a block comment unterminated, since both may span lines", () => {
    expect(maskSource("const a = `start")[0]?.unterminated).toBe(false);
    expect(maskSource("const a = /* open")[0]?.unterminated).toBe(false);
  });
});

describe("nameCount", () => {
  it("counts every occurrence, prose included, as a plain search", () => {
    expect(nameCount("")).toBe(0);
    expect(nameCount(`a ${METHOD} b`)).toBe(1);
    expect(nameCount(`${METHOD} // ${METHOD}`)).toBe(2);
  });
});
