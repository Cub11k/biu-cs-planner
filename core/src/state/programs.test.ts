import { expect, it } from "vitest";
import { effectiveFile, programWarnings, setCohort, setPrograms } from "./programs.ts";
import { stateSchema, type State } from "./schema.ts";

/**
 * The student's Cohort and Programs as they edit them (#287): two whole-value edits, and the
 * Warnings for a Programs entry the Workspace cannot honour. Nothing here refuses anything — a
 * Program naming a file that is not there is kept and named, because a Warning never costs a
 * student what they chose.
 *
 * File names and Track ids are invented; no Requirements File is committed to this repo
 * (ADR-0006).
 */
const empty = (): State => stateSchema.parse({ schemaVersion: 1 });

const LISTING = [
  { name: "cs-2027", tracks: ["ai", "cyber"] },
  { name: "math-2027", tracks: [] },
  { name: "notes" },
];

it("sets the Cohort, and changes nothing else", () => {
  const before = empty();
  const after = setCohort(before, { academicYear: 2026, semester: "fall" });

  expect(after.cohort).toEqual({ academicYear: 2026, semester: "fall" });
  expect({ ...after, cohort: undefined }).toEqual({ ...before, cohort: undefined });
});

it("clears the Cohort when given none", () => {
  const set = setCohort(empty(), { academicYear: 2026, semester: "spring" });

  expect(setCohort(set, undefined)).not.toHaveProperty("cohort");
});

it("hands back the very State when the Cohort is already that one, so nothing is saved", () => {
  const set = setCohort(empty(), { academicYear: 2026, semester: "fall" });

  expect(setCohort(set, { academicYear: 2026, semester: "fall" })).toBe(set);
  expect(setCohort(empty(), undefined)).not.toBe(set);
  const none = empty();
  expect(setCohort(none, undefined)).toBe(none);
});

it("sets the whole list of Programs at once, which is what makes a double major one edit", () => {
  const after = setPrograms(empty(), [
    { requirementsFile: "cs-2027", track: "ai" },
    { requirementsFile: "math-2027" },
  ]);

  expect(after.programs).toEqual([
    { requirementsFile: "cs-2027", track: "ai" },
    { requirementsFile: "math-2027" },
  ]);
});

it("hands back the very State when the Programs are already those, in that order", () => {
  const set = setPrograms(empty(), [{ requirementsFile: "cs-2027", track: "ai" }]);

  expect(setPrograms(set, [{ requirementsFile: "cs-2027", track: "ai" }])).toBe(set);
  expect(setPrograms(set, [{ requirementsFile: "cs-2027" }])).not.toBe(set);
  expect(setPrograms(set, [{ requirementsFile: "cs-2027", track: "cyber" }])).not.toBe(set);
  expect(
    setPrograms(set, [{ requirementsFile: "cs-2027", track: "ai" }, { requirementsFile: "x" }]),
  ).not.toBe(set);
});

it("copies the Programs it is given, so the caller's list is not the State's", () => {
  const given = [{ requirementsFile: "cs-2027" }];
  const after = setPrograms(empty(), given);
  given.push({ requirementsFile: "math-2027" });

  expect(after.programs).toEqual([{ requirementsFile: "cs-2027" }]);
});

it("says nothing about Programs whose files and Tracks are all there", () => {
  const state = setPrograms(empty(), [
    { requirementsFile: "cs-2027", track: "cyber" },
    { requirementsFile: "math-2027" },
  ]);

  expect(programWarnings(state, LISTING)).toEqual([]);
});

it("warns about a Program whose Requirements File is not in the Workspace, and keeps it", () => {
  const state = setPrograms(empty(), [
    { requirementsFile: "cs-2027" },
    { requirementsFile: "physics-2027", track: "ai" },
  ]);

  expect(programWarnings(state, LISTING)).toEqual([
    { kind: "program-file-missing", index: 1, requirementsFile: "physics-2027" },
  ]);
  expect(state.programs).toHaveLength(2);
});

it("warns about a Track the file does not define", () => {
  const state = setPrograms(empty(), [{ requirementsFile: "cs-2027", track: "robotics" }]);

  expect(programWarnings(state, LISTING)).toEqual([
    { kind: "program-track-unknown", index: 0, requirementsFile: "cs-2027", track: "robotics" },
  ]);
});

it("warns about a Program whose file is there and is not a Requirements File", () => {
  const state = setPrograms(empty(), [{ requirementsFile: "notes", track: "ai" }]);

  expect(programWarnings(state, LISTING)).toEqual([
    { kind: "program-file-unreadable", index: 0, requirementsFile: "notes" },
  ]);
});

it("reads a Pin or a tick that names no file as naming the first Program's", () => {
  const state = setPrograms(empty(), [
    { requirementsFile: "cs-2027" },
    { requirementsFile: "math-2027" },
  ]);

  expect(effectiveFile(state, { requirementId: "core" })).toBe("cs-2027");
  expect(effectiveFile(state, { requirementId: "core", requirementsFile: "math-2027" })).toBe(
    "math-2027",
  );
  expect(effectiveFile(empty(), { requirementId: "core" })).toBeUndefined();
});
