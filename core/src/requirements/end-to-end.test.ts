import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Attempt } from "../state/schema.ts";
import { evaluateProgress, type EvaluatedRequirement } from "./evaluate.ts";
import { parseRequirementsFile } from "./file.ts";
import { solveAssignment } from "./solve.ts";

/**
 * The whole engine on one small Requirements File written for this test, the way the app will
 * run it: read the file, solve the Assignment, evaluate Progress with it. No real Requirements
 * File ships with the code (ADR-0006); this one is invented and every expected value below was
 * worked out by hand from it.
 */
const raw: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "__fixtures__/small-program.json"), "utf8"),
);

const attempts: Attempt[] = [
  // An Attempt under the Course's old number, which an Equivalence makes 89-110.
  { courseNumber: "89-109", academicYear: 2027, semester: "fall", status: "passed" },
  { courseNumber: "89-111", academicYear: 2027, semester: "spring", status: "passed" },
  { courseNumber: "89-211", academicYear: 2028, semester: "spring", status: "failed" },
  { courseNumber: "89-310", academicYear: 2028, semester: "fall", status: "passed" },
  { courseNumber: "89-601", academicYear: 2028, semester: "fall", status: "passed" },
  { courseNumber: "89-602", academicYear: 2028, semester: "spring", status: "passed" },
  { courseNumber: "89-210", academicYear: 2029, semester: "fall", status: "planned" },
  { courseNumber: "89-391", academicYear: 2029, semester: "fall", status: "registered" },
  { courseNumber: "89-320", academicYear: 2029, semester: "spring", status: "planned" },
];

function find(nodes: EvaluatedRequirement[], id: string): EvaluatedRequirement {
  const pending = [...nodes];
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (next.id === id) return next;
    pending.push(...next.children);
  }
  throw new Error(`no node ${id}`);
}

it("reads a file, solves its Assignment and evaluates Progress with it", () => {
  const { file, warnings: readWarnings } = parseRequirementsFile(raw);
  expect(readWarnings).toEqual([]);

  const solution = solveAssignment({ programs: [{ file: file!, track: "ai" }], attempts });
  const progress = evaluateProgress({
    file: file!,
    track: "ai",
    attempts,
    assignment: solution.assignments[0]!,
    ticked: ["english"],
  });
  const status = (id: string) => {
    const node = find(progress.requirements, id);
    return [node.completed.status, node.projected.status];
  };

  expect(solution.stoppedEarly).toBe(false);
  expect(solution.warnings).toEqual([]);
  expect(progress.warnings).toEqual([]);

  // Done today: both core Courses, the old number included; theory only once 89-210 is taken.
  expect(status("intro")).toEqual(["satisfied", "satisfied"]);
  expect(status("data-structures")).toEqual(["satisfied", "satisfied"]);
  expect(status("theory")).toEqual(["missing", "satisfied"]);
  expect(status("core")).toEqual(["partial", "satisfied"]);
  // The two seminars are worth 4 credits, but the cap lets only 2 count toward the advanced
  // electives; the solver spends them on the general electives, which they complete today.
  expect(status("general-electives")).toEqual(["satisfied", "satisfied"]);
  expect(status("advanced-electives")).toEqual(["partial", "satisfied"]);
  expect(status("machine-learning")).toEqual(["missing", "satisfied"]);
  expect(status("english")).toEqual(["satisfied", "satisfied"]);

  expect(progress.status).toEqual({ completed: "partial", projected: "satisfied" });
  expect(progress.totalCredits).toEqual({ completed: 17, projected: 27 });
});
