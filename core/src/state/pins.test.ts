import { expect, it } from "vitest";
import { pinCourse, tickManual, unpinCourse, untickManual } from "./pins.ts";
import { setPrograms } from "./programs.ts";
import { stateSchema, type State } from "./schema.ts";

/**
 * Pins and ticked Manual Requirements as a student edits them (#288): four plain edits, each
 * referencing its Requirement by id and Requirements File (`CONTEXT.md`, Pin). A Pin or tick
 * written before Pins named their file is read as naming the first Program's.
 *
 * File names and Requirement ids are invented (ADR-0006).
 */
const doubleMajor = (): State =>
  setPrograms(stateSchema.parse({ schemaVersion: 1 }), [
    { requirementsFile: "cs-2027" },
    { requirementsFile: "math-2027" },
  ]);

it("pins a Course to a Requirement of one Program, naming the file", () => {
  const state = pinCourse(doubleMajor(), {
    courseNumber: "89-110",
    requirementsFile: "math-2027",
    requirementId: "core",
  });

  expect(state.pins).toEqual([
    { courseNumber: "89-110", requirementsFile: "math-2027", requirementId: "core" },
  ]);
});

it("replaces the Pin the Course already had in that Program, and leaves the other Program's", () => {
  let state = pinCourse(doubleMajor(), {
    courseNumber: "89-110",
    requirementsFile: "cs-2027",
    requirementId: "core",
  });
  state = pinCourse(state, { courseNumber: "89-110", requirementsFile: "math-2027", requirementId: "core" });
  state = pinCourse(state, { courseNumber: "89-111", requirementsFile: "cs-2027", requirementId: "core" });

  state = pinCourse(state, {
    courseNumber: "89-110",
    requirementsFile: "cs-2027",
    requirementId: "electives",
  });

  expect(state.pins).toEqual([
    { courseNumber: "89-110", requirementsFile: "math-2027", requirementId: "core" },
    { courseNumber: "89-111", requirementsFile: "cs-2027", requirementId: "core" },
    { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "electives" },
  ]);
});

it("replaces an older Pin with no file when the Pin is for the first Program", () => {
  const before = { ...doubleMajor(), pins: [{ courseNumber: "89-110", requirementId: "core" }] };

  const firstProgram = pinCourse(before, {
    courseNumber: "89-110",
    requirementsFile: "cs-2027",
    requirementId: "electives",
  });
  expect(firstProgram.pins).toEqual([
    { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "electives" },
  ]);

  // and not when it is for the second, whose Pin the older one never was
  const secondProgram = pinCourse(before, {
    courseNumber: "89-110",
    requirementsFile: "math-2027",
    requirementId: "core",
  });
  expect(secondProgram.pins).toHaveLength(2);
});

it("hands back the very State when the Pin is already there", () => {
  const state = pinCourse(doubleMajor(), {
    courseNumber: "89-110",
    requirementsFile: "cs-2027",
    requirementId: "core",
  });

  expect(
    pinCourse(state, { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "core" }),
  ).toBe(state);
});

it("removes a Pin, so the solver decides again, and only that one", () => {
  let state = pinCourse(doubleMajor(), {
    courseNumber: "89-110",
    requirementsFile: "cs-2027",
    requirementId: "core",
  });
  state = pinCourse(state, { courseNumber: "89-110", requirementsFile: "math-2027", requirementId: "core" });

  const unpinned = unpinCourse(state, {
    courseNumber: "89-110",
    requirementsFile: "cs-2027",
    requirementId: "core",
  });

  expect(unpinned.pins).toEqual([
    { courseNumber: "89-110", requirementsFile: "math-2027", requirementId: "core" },
  ]);
});

it("removes an older Pin with no file as the first Program's", () => {
  const before = { ...doubleMajor(), pins: [{ courseNumber: "89-110", requirementId: "core" }] };

  expect(
    unpinCourse(before, { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "core" })
      .pins,
  ).toEqual([]);
  expect(
    unpinCourse(before, { courseNumber: "89-110", requirementsFile: "math-2027", requirementId: "core" }),
  ).toBe(before);
});

it("hands back the very State when there is no such Pin to remove", () => {
  const state = doubleMajor();

  expect(
    unpinCourse(state, { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "core" }),
  ).toBe(state);
});

it("ticks a Manual Requirement of one Program, and unticks it again", () => {
  const ticked = tickManual(doubleMajor(), { requirementsFile: "cs-2027", requirementId: "hebrew" });
  expect(ticked.manualTicks).toEqual([{ requirementsFile: "cs-2027", requirementId: "hebrew" }]);

  // the same id in the other Program is another Manual Requirement, ticked apart
  const both = tickManual(ticked, { requirementsFile: "math-2027", requirementId: "hebrew" });
  expect(both.manualTicks).toHaveLength(2);

  const unticked = untickManual(both, { requirementsFile: "cs-2027", requirementId: "hebrew" });
  expect(unticked.manualTicks).toEqual([{ requirementsFile: "math-2027", requirementId: "hebrew" }]);
});

it("hands back the very State for a tick already there and an untick of nothing", () => {
  const ticked = tickManual(doubleMajor(), { requirementsFile: "cs-2027", requirementId: "hebrew" });

  expect(tickManual(ticked, { requirementsFile: "cs-2027", requirementId: "hebrew" })).toBe(ticked);
  const none = doubleMajor();
  expect(untickManual(none, { requirementsFile: "cs-2027", requirementId: "hebrew" })).toBe(none);
});

it("reads an older tick with no file as the first Program's", () => {
  const before = { ...doubleMajor(), manualTicks: [{ requirementId: "hebrew" }] };

  expect(tickManual(before, { requirementsFile: "cs-2027", requirementId: "hebrew" })).toBe(before);
  expect(
    untickManual(before, { requirementsFile: "cs-2027", requirementId: "hebrew" }).manualTicks,
  ).toEqual([]);
});
