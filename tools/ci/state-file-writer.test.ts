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
  maskCode,
  mayCall,
  mentions,
  moduleUnderTest,
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

const ofKind = (kind: Mention["kind"]): Mention[] =>
  everyMention().filter((mention) => mention.kind === kind);

describe("the State File writers in this repository", () => {
  it("has source to read, so a passing suite is not an empty walk", () => {
    // The walk reads the disk, so an untracked file is judged too -- a new second writer
    // fails before it is committed rather than after. A glob that matched nothing would
    // otherwise pass this whole file in silence, which is the failure this line exists for.
    expect(governed().length).toBeGreaterThan(0);
    expect(governed()).toContain(WRITER);
  });

  // The canary, and the half that makes the rest mean anything. If the scan silently stopped
  // recognising the shapes it is built to recognise -- a rename, a reformat, a masker that
  // started eating code -- every list below would go empty and every assertion would agree
  // with itself. So the subject is pinned: the port declares the method once, at least two
  // adapters implement it, and production calls it in exactly one place, which is the wrapper.
  it("finds the port, its adapters, and exactly one production call", () => {
    expect(ofKind("declaration").map((m) => m.file)).toEqual(["app/src/workspace.ts"]);

    const implementing = implementors(everyMention());

    expect(implementing).toContain("app/src/workspace.memory.ts");
    expect(implementing).toContain("server/src/workspace.fs.ts");

    const production = ofKind("call").filter((m) => moduleUnderTest(m.file) === undefined);

    expect(production.map((m) => `${m.file}:${m.line}`)).toEqual([`${WRITER}:313`]);
  });

  // The rule itself.
  it("has no second write path", () => {
    expect(secondWriters(everyMention()).map(explain)).toEqual([]);
  });

  // The two adapters' tests call the port on purpose, and they are the reason an exemption
  // exists at all. Pinned here so that a change which "fixed" the rule by silencing them
  // would be visible as a change to this line.
  it("lets the two adapters' own tests exercise the port", () => {
    const testing = [...new Set(ofKind("call").map((m) => m.file))].filter(
      (file) => moduleUnderTest(file) !== undefined,
    );

    expect(testing.sort()).toEqual([
      "app/src/workspace.memory.test.ts",
      "server/src/workspace.fs.test.ts",
    ]);
  });

  // Every mention in the repository lands in a kind, and the two that are neither code nor a
  // finding are named: an error message in `app/src/workspace.ts` and the pattern
  // `app/src/workspace.test.ts` asserts that message with. Listing them keeps "the scan reads
  // prose as prose" a measured claim rather than a hope, and a third one arriving has to come
  // through this line.
  it("reads the name in a message and in a pattern as the prose it is", () => {
    expect(ofKind("text").map((m) => `${m.file}:${m.line}`)).toEqual([
      "app/src/workspace.ts:145",
      "app/src/workspace.test.ts:102",
    ].sort());
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

/** A mention as the scan would report it, for the judging tests below. */
const at = (file: string, source: string): Mention[] => mentions(file, source);

const kinds = (file: string, source: string): string[] => at(file, source).map((m) => m.kind);

describe("mentions", () => {
  it("reads the port's own signature as a declaration, not a call", () => {
    const source = "  saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<Version>;";

    expect(kinds("app/src/workspace.ts", source)).toEqual(["declaration"]);
  });

  it("reads an adapter's method as an implementation, not a call", () => {
    const source =
      "    async saveStateFile(ref: StateFileRef, save: StateFileSave): Promise<Version> {";

    expect(kinds("server/src/workspace.fs.ts", source)).toEqual(["implementation"]);
  });

  it("reads a method written without async as an implementation too", () => {
    expect(kinds("app/src/workspace.stub.ts", "  saveStateFile(ref, save) {")).toEqual([
      "implementation",
    ]);
  });

  it("reads a call through the port as a call", () => {
    const source = "  version = await workspace.saveStateFile({ kind: 'state', name }, save);";

    expect(kinds(WRITER, source)).toEqual(["call"]);
  });

  it("reads a call continuing a chain on its own line as a call", () => {
    // `server/src/workspace.fs.test.ts:1128` and `app/src/workspace.memory.test.ts:258` are
    // both written this way, so a scan that only looked for `x.saveStateFile` would miss it.
    expect(kinds("app/src/x.ts", "      .saveStateFile(alice, firstSave(STATE))")).toEqual([
      "call",
    ]);
  });

  it("reads an optional-chained call as a call", () => {
    expect(kinds("app/src/x.ts", "  await workspace?.saveStateFile(ref, save);")).toEqual([
      "call",
    ]);
  });

  it("reads a docstring's mention as nothing at all", () => {
    const source = [
      "/**",
      " * A State File is saved through `saveStateFile`, which carries the revision.",
      " */",
      "export const nothing = 1;",
    ].join("\n");

    expect(at("app/src/workspace.ts", source)).toEqual([]);
  });

  it("reads a mention in a comment beside code as prose, not as a call", () => {
    // A whole prose line is dropped before the scan starts; a comment sharing a line with
    // code cannot be, so the masker is what keeps this one from reading as a call.
    expect(kinds("app/src/x.ts", "const a = 1; // saveStateFile goes through the wrapper")).toEqual(
      ["text"],
    );
  });

  it("reads the name inside a message string as prose", () => {
    const source = '      "read through readStateFile and saved through saveStateFile",';

    expect(kinds("app/src/workspace.ts", source)).toEqual(["text"]);
  });

  it("reads the name inside a regex literal as prose", () => {
    // `app/src/workspace.test.ts:102`, which asserts the message above. The quote inside the
    // pattern is why the masker has to know a regex from a string.
    const source = '    /State File "alice".*readStateFile.*saveStateFile/s,';

    expect(kinds("app/src/workspace.test.ts", source)).toEqual(["text"]);
  });

  it("finds two mentions on one line, and judges each on its own", () => {
    const source = '  log("saveStateFile"); await workspace.saveStateFile(ref, save);';

    expect(kinds("app/src/x.ts", source)).toEqual(["text", "call"]);
  });

  it("does not read a division as the start of a pattern", () => {
    // A `/` that is not a regex must not blank the rest of the line, or a call after one
    // would be masked into silence.
    const source = "  const half = total / 2; await workspace.saveStateFile(ref, save);";

    expect(kinds("app/src/x.ts", source)).toEqual(["call"]);
  });

  it("says so when a line leaves a quote open, rather than guessing", () => {
    expect(kinds("app/src/x.ts", "  const broken = `saveStateFile")).toEqual(["unreadable"]);
  });
});

describe("the ways round a dot, each of which is still a call", () => {
  // The question a reviewer was asked to try: can the check be walked past? Each of these is
  // a spelling that reaches the port without writing `workspace.saveStateFile(`, and each is
  // pinned as a call so that finding one of them is not a discovery made later.

  it("catches a computed access, where the name hides in a string", () => {
    const source = '  await workspace["saveStateFile"](ref, save);';

    expect(kinds("app/src/x.ts", source)).toEqual(["call"]);
  });

  it("catches a computed access written with the other two quotes", () => {
    for (const source of [
      "  await workspace['saveStateFile'](ref, save);",
      "  await workspace[`saveStateFile`](ref, save);",
    ]) {
      expect(kinds("app/src/x.ts", source), source).toEqual(["call"]);
    }
  });

  it("catches a bare call, which is what destructuring the port leaves behind", () => {
    const source = "  await saveStateFile(ref, save);";

    expect(kinds("app/src/x.ts", source)).toEqual(["call"]);
  });

  it("catches the destructuring itself, before anything is called", () => {
    const source = "  const { saveStateFile } = workspace;";

    expect(kinds("app/src/x.ts", source)).toEqual(["reference"]);
  });

  it("catches the method taken as a value and handed somewhere else", () => {
    for (const source of [
      "  const save = workspace.saveStateFile;",
      "  return [workspace.saveStateFile, other];",
      "  queue.push(workspace.saveStateFile);",
    ]) {
      expect(kinds("app/src/x.ts", source), source).toEqual(["reference"]);
    }
  });

  it("catches an import of the name, however unlikely", () => {
    expect(kinds("app/src/x.ts", '  import { saveStateFile } from "./workspace.ts";')).toEqual([
      "reference",
    ]);
  });

  it("does not let a call-shaped line at the margin pass as a declaration", () => {
    // Call-shaped, at the start of a line, and ending in neither `{` nor `;` -- so it is not
    // a member being defined and not a shape this repository writes. It says it cannot tell.
    expect(kinds("app/src/x.ts", "saveStateFile(ref, save)")).toEqual(["unreadable"]);
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
    expect(mayCall("app/src/workspace.sqlite.test.ts", [...adapters, "app/src/workspace.sqlite.ts"]))
      .toBe(true);
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
    expect(said).toContain("not waved through");
    expect(said).toContain("editStateFile");
    expect(said).toContain("beside the");
  });

  it("says of a reference that it is a call somewhere else", () => {
    expect(explain(finding({ kind: "reference" }))).toContain("without calling it");
  });

  it("asks for an unreadable line to be rewritten rather than judged", () => {
    const said = explain(finding({ kind: "unreadable" }));

    expect(said).toContain("could not be read");
    expect(said).toContain(RULE);
  });
});

describe("maskCode", () => {
  it("keeps code exactly as it is", () => {
    const line = "  await workspace.saveStateFile(ref, save);";

    expect(maskCode(line)).toEqual({ text: line, unterminated: false });
  });

  it("blanks what a string holds and keeps its quotes, so indices do not move", () => {
    const masked = maskCode('const a = "hi";');

    expect(masked.text).toBe('const a = "~~";');
    expect(masked.text).toHaveLength('const a = "hi";'.length);
  });

  it("does not take an escaped quote for the end of a string", () => {
    expect(maskCode('const a = "a\\"b"; call();').text).toBe('const a = "~~~~"; call();');
  });

  it("blanks a regex literal and not a division", () => {
    expect(maskCode("const a = /ab/;").text).toBe("const a = /~~/;");
    expect(maskCode("const a = b / c;").text).toBe("const a = b / c;");
  });

  it("does not take a character class's slash for the end of a pattern", () => {
    expect(maskCode("const a = /[/:]$/; b();").text).toBe("const a = /~~~~~/; b();");
  });

  it("blanks a trailing line comment", () => {
    expect(maskCode("call(); // a note").text).toBe("call(); ~~~~~~~~~");
  });

  it("blanks an inline block comment and reads the code after it", () => {
    expect(maskCode("call(/* why */ x);").text).toBe("call(~~~~~~~~~ x);");
  });

  it("says a line is unterminated when a quote never closes", () => {
    expect(maskCode("const a = `start").unterminated).toBe(true);
    expect(maskCode("const a = /* open").unterminated).toBe(true);
  });
});
