import { compileProgram, leavesAccepting } from "./program.ts";
import type { RequirementsFile } from "./schema.ts";

/**
 * Which Requirements a Course can count toward, by id, in tree order (#288): every `course` leaf
 * naming it and every `credits` leaf whose Pool holds it, in the base rule set and the chosen
 * Track, with the Course read through the file's Equivalences first.
 *
 * It is what the Progress screen offers to Pin a Course to, so the screen invents no candidate: the
 * same `accepts` the solver and the evaluation use decides it, and a Pin to anything else would be
 * dropped by the solver with a Warning anyway. A cap, an exclusive and a Manual Requirement take no
 * Course, so none is ever named.
 */
export function requirementsAccepting(
  file: RequirementsFile,
  track: string | undefined,
  courseNumber: string,
): string[] {
  const program = compileProgram(file, track);
  return leavesAccepting(program, program.canonical(courseNumber)).map(
    (leaf) => program.nodes[leaf]!.requirement!.id,
  );
}
