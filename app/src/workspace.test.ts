import { expect, it } from "vitest";
import {
  isStateFileName,
  NotAWorkspaceError,
  requireCatalogRef,
  requireStateFileName,
  WorkspaceRefusedError,
} from "./workspace.ts";

/**
 * The name rule stands between free text and a filesystem: a State File is the first
 * `WorkspaceRef` that carries a name rather than a number, so this is the one function in the
 * port that a hostile or careless name reaches. It is tested here directly rather than only
 * through the two adapters, because a clause no adapter test happens to exercise is a clause
 * that can be relaxed without anything failing.
 */

const ACCEPTED = [
  ["an ordinary name", "alice"],
  ["a name in Hebrew, which is the point of not fixing an alphabet", "אליס"],
  // The gershayim, U+05F4, and not an ASCII double quote — that one Windows refuses.
  ["Hebrew punctuation", "נ\u05f4צ"],
  ["a space inside", "alice and bob"],
  ["digits and punctuation", "alice-2027_take.2"],
  ["64 characters, the longest allowed", "a".repeat(64)],
];

const REFUSED = [
  ["nothing at all", ""],
  ["longer than 64 characters", "a".repeat(65)],
  ["a parent directory", ".."],
  ["this directory", "."],
  ["a path", "sub/alice"],
  ["a path out of the Workspace", "../escaped"],
  ["a Windows path", "sub\\alice"],
  ["a Windows drive", "C:alice"],
  ["a hidden file", ".hidden"],
  ["a wildcard Windows refuses", "alice*"],
  ["a redirection Windows refuses", "alice>bob"],
  ["a quote Windows refuses", 'alice"bob'],
  ["a pipe Windows refuses", "alice|bob"],
  ["a question mark Windows refuses", "alice?"],
  ["a tab", "alice\tbob"],
  ["a newline", "alice\nbob"],
  ["a leading space no one can see", " alice"],
  ["a trailing space no one can see", "alice "],
  // Two State Files whose names are indistinguishable in a listing and in the UI is the same
  // trouble as one name that is a path, in an app whose second language is read right to left.
  ["a zero-width space", "alice​"],
  ["a left-to-right mark", "alice‎"],
  ["a lone surrogate", "alice\ud800"],
  // Win32 reserves these whatever is appended, so `NUL.state.json` is the null device: the
  // save reports success and the bytes are gone.
  ["the null device", "nul"],
  ["the console, in any case", "CON"],
  ["a serial port", "com1"],
  ["a printer port", "LPT9"],
];

it.each(ACCEPTED)("accepts %s", (_what, name) => {
  expect(isStateFileName(name)).toBe(true);
  expect(() => requireStateFileName(name)).not.toThrow();
});

it.each(REFUSED)("refuses %s", (_what, name) => {
  expect(isStateFileName(name)).toBe(false);
  expect(() => requireStateFileName(name)).toThrow(WorkspaceRefusedError);
});

/** A refusal a student can act on names what was refused, so the message carries the name. */
it("says which name it refused", () => {
  expect(() => requireStateFileName("../escaped")).toThrow(/\.\.\/escaped/);
});

/**
 * The other refusal both adapters share, and the runtime half of narrowing `read` and `write`
 * to a `CatalogRef` (#113). Tested here for the same reason the name rule is: it is one
 * function, and an adapter test that happened to stop exercising it would leave it free to be
 * relaxed with nothing failing.
 */
it("lets a Catalog through a whole-file read or write", () => {
  expect(() => requireCatalogRef({ kind: "catalog", academicYear: 2027 })).not.toThrow();
});

it("refuses a Catalog whose year is not a whole number, which an adapter turns into a path", () => {
  for (const academicYear of ["../alice.state", "2027/../..", 2027.5, NaN, Infinity]) {
    expect(() => requireCatalogRef({ kind: "catalog", academicYear } as never)).toThrow(
      WorkspaceRefusedError,
    );
  }
  // and the ordinary ones still pass, including a year no Catalog would sensibly carry: the
  // range is the API's rule, and this one is only about what can become a path
  for (const academicYear of [2027, 0, -1, 9999]) {
    expect(() => requireCatalogRef({ kind: "catalog", academicYear })).not.toThrow();
  }
});

it("refuses a State File handed to a whole-file read or write", () => {
  expect(() => requireCatalogRef({ kind: "state", name: "alice" })).toThrow(WorkspaceRefusedError);
  // it names the file, and says where a State File is read and saved instead
  expect(() => requireCatalogRef({ kind: "state", name: "alice" })).toThrow(
    /State File "alice".*readStateFile.*saveStateFile/s,
  );
});

/**
 * The third refusal both adapters share, and the newest (#121). Tested here for the reason the
 * other two are: it is one sentence, and the whole value of its being here is that neither
 * adapter can word it differently — which is a property of this file rather than of either
 * adapter's tests. It was a plain `Error` at three sites, two in `server/src/workspace.fs.ts`
 * and one spelling the same words again in `app/src/workspace.memory.ts`.
 */
it("refuses a write into a folder that is not a Workspace, as a refusal and not a plain Error", () => {
  const refusal = new NotAWorkspaceError();

  // What makes it answerable: `app/src/edit.ts` and `app/src/catalog.ts` catch
  // `WorkspaceRefusedError` and word it as `workspace-refused`, which `server/src/api.ts`
  // answers with a 409. A plain `Error` is caught by nothing, which is what made this the
  // first unnamed 500 the API would ever have had.
  expect(refusal).toBeInstanceOf(WorkspaceRefusedError);
  expect(refusal).toBeInstanceOf(NotAWorkspaceError);
  expect(refusal.message).toBe("refusing to write: the Workspace layout does not exist yet");
  expect(refusal.folder).toBeUndefined();
});

/**
 * The second way a layout is not one: a plain file standing where a folder of it belongs, which
 * `status` reports as ready and a write used to meet as a raw `ENOTDIR` (#121). The stem is
 * shared and the tail is the adapter's, because "is there and is not a folder" and "could not
 * be made" are different news about the same folder.
 */
it("names the part of the layout that is what is wrong, when one part is", () => {
  const refusal = new NotAWorkspaceError({
    folder: "catalogs",
    because: "is there and is not a folder",
  });

  expect(refusal).toBeInstanceOf(WorkspaceRefusedError);
  expect(refusal.folder).toBe("catalogs");
  expect(refusal.message).toMatch(
    /^refusing to write: the Workspace layout does not exist yet — catalogs is there and is not a folder$/,
  );
});
