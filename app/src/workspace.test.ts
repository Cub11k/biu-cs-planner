import { expect, it } from "vitest";
import { isStateFileName, requireStateFileName, WorkspaceRefusedError } from "./workspace.ts";

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
