import { expect, it } from "vitest";
import { clockAsEnd, clockAsStart } from "./clock.ts";

it("reads a clock time as minutes since the beginning of the Day", () => {
  expect(clockAsStart("00:00")).toBe(0);
  expect(clockAsStart("08:30")).toBe(510);
  expect(clockAsStart("23:59")).toBe(1439);
});

/**
 * The whole of the ruling on #48 in three lines: the spelling is the same, the position is
 * what differs. Every other reading in this module follows from these two.
 */
it("reads 00:00 as the beginning of the Day at a start and the end of it at an end", () => {
  expect(clockAsStart("00:00")).toBe(0);
  expect(clockAsEnd("00:00")).toBe(1440);
  expect(clockAsEnd("08:30")).toBe(510);
});

/**
 * A Blocked Time is student-entered and `"9:00"` is what a student types. Comparing the
 * strings would sort it after `"10:00"`; reading the number is what stops that.
 */
it("reads an hour the student wrote without a leading zero", () => {
  expect(clockAsStart("9:00")).toBe(540);
  expect(clockAsEnd("9:00")).toBe(540);
});

/**
 * `24:00` is an internal artifact and never a clock string: 1440 is a number this module
 * computes, and nothing stores or shows `"24:00"`. Reading it would put a second spelling of
 * the end of the Day back into the vocabulary the ruling removed it from.
 */
it("refuses 24:00 and everything above it, at either end", () => {
  for (const refused of ["24:00", "24:01", "25:00", "99:00"]) {
    expect(clockAsStart(refused)).toBeUndefined();
    expect(clockAsEnd(refused)).toBeUndefined();
  }
});

it("refuses a time it cannot read at all, rather than guessing where it falls", () => {
  for (const refused of ["", "morning", "0900", "09:60", "9am", "09:00:00", " 09:00"]) {
    expect(clockAsStart(refused)).toBeUndefined();
    expect(clockAsEnd(refused)).toBeUndefined();
  }
});

/**
 * The pattern has to bind above its alternatives, not below them. A version of this written
 * as `^a|b$` accepts `"23:0009:00"`, because only the first branch is anchored at the start
 * and only the last at the end — which is how a clock that looked anchored let a pair of them
 * through on the branch closed with #47.
 */
it("stays anchored at both ends, so two clock times joined are not one", () => {
  expect(clockAsStart("23:0009:00")).toBeUndefined();
  expect(clockAsEnd("23:0009:00")).toBeUndefined();
  expect(clockAsEnd("09:000")).toBeUndefined();
  expect(clockAsEnd("009:00")).toBeUndefined();
});
