import { expect, it } from "vitest";
import { createApiClient } from "./api.ts";
import { addAttempt, planFromSuggestedLayout } from "./plan/plan.ts";
import { chooseCohort, choosePrograms, pinCourse } from "./progress/progress.ts";
import { applyPlanDiff } from "./timetable/planDiffs.ts";
import { recordPick } from "./timetable/picks.ts";
import { markRegistered } from "./timetable/registration.ts";

/**
 * #414: every web reader of a route whose edit can land with no view (`editAndAnswer`, #395) reads
 * the 200 marked `noView` as its own arm — saved at `version`, with the Warnings — and never as an
 * answer it cannot read, which would tell the student it is unknown whether the edit saved.
 */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";
const VERSION = "b".repeat(64);
const WARNINGS = [{ kind: "cohort-unreadable" }];

const api = createApiClient(
  () => TOKEN,
  (async () => Response.json({ noView: true, version: VERSION, warnings: WARNINGS })) as typeof fetch,
);
const week = { academicYear: 2027, semester: "fall" as const };

it.each([
  ["adding an Attempt", () => addAttempt(api, { courseNumber: "89-110", ...week, status: "planned" }, "v1")],
  ["New Plan from Suggested Layout", () => planFromSuggestedLayout(api, "v1")],
  ["a Pin", () => pinCourse(api, { courseNumber: "89-110", requirementsFile: "cs", requirementId: "intro" }, "v1")],
])("reads %s answered with no view as saved, with its revision and Warnings", async (_, edit) => {
  expect(await edit()).toEqual({ kind: "no-view", version: VERSION, stateWarnings: WARNINGS });
});

it.each([
  ["choosing the Programs", () => choosePrograms(api, [{ requirementsFile: "cs" }], "v1")],
  ["choosing the Cohort", () => chooseCohort(api, null, "v1")],
])("reads %s answered with no view as saved with no view, not as saved and served", async (_, edit) => {
  expect(await edit()).toEqual({ kind: "no-view", version: VERSION, stateWarnings: WARNINGS });
});

it.each([
  ["a Pick", () => recordPick(api, week, { courseNumber: "89-110", lessonType: "lecture", groupNumber: "01", meetings: [] } as never, "v1")],
  ["applying a Plan Diff", () => applyPlanDiff(api, week, { kind: "add", courseNumber: "89-110" } as never, "v1")],
  ["marking a Variant registered", () => markRegistered(api, week, "A", { alsoPrimary: true } as never, "v1")],
])("reads %s answered with no view as saved, with its revision and Warnings", async (_, edit) => {
  expect(await edit()).toEqual({ kind: "no-view", version: VERSION, warnings: WARNINGS });
});
