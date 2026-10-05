import { expect, it } from "vitest";
import { requirementsAccepting } from "./candidates.ts";
import { parseRequirementsFile } from "./file.ts";
import type { RequirementsFile } from "./schema.ts";

/**
 * Which Requirements a Course can count toward (#288): what the Progress screen offers to Pin a
 * Course to, computed by the engine so the screen invents no candidate. The Program is invented
 * (ADR-0006).
 */
const FILE: RequirementsFile = parseRequirementsFile({
  schemaVersion: 1,
  program: { id: "cs", name: { he: "מדעי המחשב" } },
  pools: [
    { id: "cs", kind: "prefix", prefix: "89-" },
    { id: "advanced", kind: "range", department: "89", from: 300, to: 699 },
  ],
  equivalences: [{ from: "89-109", to: "89-110" }],
  requirements: [
    { id: "intro", kind: "course", course: "89-110" },
    {
      id: "electives",
      kind: "allOf",
      of: [
        { id: "advanced-electives", kind: "credits", min: 6, pool: "advanced" },
        { id: "seminar-cap", kind: "cap", max: 2, pool: "advanced" },
      ],
    },
    { id: "general", kind: "credits", min: 4, pool: "cs" },
    { id: "english", kind: "manual", text: { he: "אנגלית" } },
    { id: "overall", kind: "total", min: 120, pool: "cs" },
  ],
  tracks: [
    {
      id: "ai",
      name: { he: "בינה" },
      requirements: [{ id: "ml", kind: "course", course: "89-391" }],
    },
  ],
}).file!;

it("names every Requirement that takes the Course, in tree order", () => {
  expect(requirementsAccepting(FILE, undefined, "89-110")).toEqual(["intro", "general"]);
  expect(requirementsAccepting(FILE, undefined, "89-320")).toEqual(["advanced-electives", "general"]);
});

it("reads a Course through the file's Equivalences", () => {
  expect(requirementsAccepting(FILE, undefined, "89-109")).toEqual(["intro", "general"]);
});

it("includes the chosen Track's Requirements, and only the chosen Track's", () => {
  expect(requirementsAccepting(FILE, "ai", "89-391")).toEqual(["advanced-electives", "general", "ml"]);
  expect(requirementsAccepting(FILE, undefined, "89-391")).toEqual(["advanced-electives", "general"]);
});

it("names none for a Course nothing takes, and never a cap, a total or a Manual Requirement", () => {
  expect(requirementsAccepting(FILE, undefined, "10-001")).toEqual([]);
  expect(requirementsAccepting(FILE, undefined, "89-320")).not.toContain("seminar-cap");
});
