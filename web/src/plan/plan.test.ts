import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import { columnCredits, gradeOf, planYears, retakeSemester } from "./columns.ts";
import {
  addAttempt,
  fetchChoices,
  fetchCourses,
  fetchPlan,
  moveAttempt,
  planFromSuggestedLayout,
  removeAttempt,
  updateAttempt,
} from "./plan.ts";

/**
 * The half of the Plan screen that lives in `web` without a browser (#292, #293): what the typed
 * client sends and makes of every answer, and the rules the columns are derived by. Course
 * numbers are invented (ADR-0006).
 */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

const ATTEMPT = { id: "a1", courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "planned" };
const SERVED = {
  attempts: [ATTEMPT],
  attemptWarnings: [],
  planWarnings: [{ kind: "credit-load", target: { kind: "semester", academicYear: 2027, semester: "fall" }, credits: 30, limit: 24 }],
  semesterCredits: [{ academicYear: 2027, semester: "fall", credits: 30, unknown: 0 }],
  programWarnings: [{ kind: "requirements-unlisted" }],
  version: "a".repeat(64),
  warnings: [{ kind: "cohort-unreadable" }],
};

function client(answer: (request: Request) => Response | Promise<Response>) {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    const request = new Request(new URL(String(input), "http://localhost:8900"), init);
    sent.push(request);
    return answer(request);
  }) as typeof fetch;
  return { sent, api: createApiClient(() => TOKEN, fetchImpl) };
}

it("asks for the Plan with the launch token, and reads what is served", async () => {
  const { sent, api } = client(() => Response.json(SERVED));

  const result = await fetchPlan(api);

  expect(new URL(sent[0]!.url).pathname).toBe("/api/plan");
  expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  expect(result).toEqual({
    kind: "served",
    attempts: [ATTEMPT],
    attemptWarnings: [],
    planWarnings: SERVED.planWarnings,
    semesterCredits: SERVED.semesterCredits,
    programWarnings: [{ kind: "requirements-unlisted" }],
    stateWarnings: [{ kind: "cohort-unreadable" }],
    version: "a".repeat(64),
  });
});

it("sends each edit to its route, naming the Attempt by its id, with the revision it was based on", async () => {
  const { sent, api } = client(() => Response.json(SERVED));

  await addAttempt(api, { courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "planned" }, "v1");
  await updateAttempt(api, "a1", { status: "passed", grade: { kind: "numeric", value: 90 } }, "v2");
  await updateAttempt(api, "a1", { grade: null }, "v3");
  await moveAttempt(api, "a1", { academicYear: 2028, semester: "spring" }, "v4");
  await removeAttempt(api, "a1", "v5");
  await planFromSuggestedLayout(api, "v6");
  await planFromSuggestedLayout(api, "v7", "math-2027");

  expect(sent.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    "POST /api/plan/attempts",
    "PATCH /api/plan/attempts/a1",
    "PATCH /api/plan/attempts/a1",
    "PUT /api/plan/attempts/a1/semester",
    "DELETE /api/plan/attempts/a1",
    "POST /api/plan/suggested-layout",
    "POST /api/plan/suggested-layout",
  ]);
  expect(await Promise.all(sent.map((request) => request.json()))).toEqual([
    { courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "planned", basedOn: "v1" },
    { status: "passed", grade: { kind: "numeric", value: 90 }, basedOn: "v2" },
    { grade: null, basedOn: "v3" },
    { academicYear: 2028, semester: "spring", basedOn: "v4" },
    { basedOn: "v5" },
    { basedOn: "v6" },
    { requirementsFile: "math-2027", basedOn: "v7" },
  ]);
});

it("reads a refusal, a 401, an unreadable body and no server apart", async () => {
  const refused = client(() => Response.json({ reason: "state-file-changed", warnings: [] }, { status: 409 }));
  expect(await fetchPlan(refused.api)).toEqual({ kind: "refused", reason: "state-file-changed" });

  const unauthorized = client(() => Response.json({ error: "unauthorized" }, { status: 401 }));
  expect(await fetchPlan(unauthorized.api)).toEqual({ kind: "unauthorized" });

  const html = client(() => new Response("<html>", { status: 500 }));
  expect(await fetchPlan(html.api)).toEqual({ kind: "unreadable-answer" });
  const notJson = client(() => new Response("nope", { status: 200 }));
  expect(await fetchPlan(notJson.api)).toEqual({ kind: "unreadable-answer" });

  const gone = client(() => {
    throw new TypeError("fetch failed");
  });
  expect(await fetchPlan(gone.api)).toEqual({ kind: "unreachable" });
});

it("reads New Plan from Suggested Layout's summary, and tells what it needs from a stale revision by reason", async () => {
  const summary = {
    created: [{ id: "n1", courseNumber: "89-111", academicYear: 2027, semester: "spring" }],
    skipped: [{ courseNumber: "89-110", reason: "attempted" }],
  };
  const made = client(() => Response.json({ ...SERVED, summary }));
  expect(await planFromSuggestedLayout(made.api, "v1")).toMatchObject({ kind: "served", summary });

  for (const reason of ["cohort-not-chosen", "program-not-chosen", "requirements-file-unavailable", "no-suggested-layout"]) {
    const unavailable = client(() => Response.json({ reason, version: "v1" }, { status: 409 }));
    expect(await planFromSuggestedLayout(unavailable.api, "v1")).toEqual({ kind: "unavailable", reason });
  }
  const stale = client(() => Response.json({ reason: "state-file-changed", warnings: [] }, { status: 409 }));
  expect(await planFromSuggestedLayout(stale.api, "v1")).toEqual({ kind: "refused", reason: "state-file-changed" });
});

it("reads the Cohort and the Programs off the Programs route, and nothing when they cannot be had", async () => {
  const chosen = client(() =>
    Response.json({
      cohort: { academicYear: 2027, semester: "spring" },
      programs: [{ requirementsFile: "cs-2027", track: "core" }, { requirementsFile: "math-2027" }],
      programWarnings: [],
      warnings: [],
    }),
  );
  expect(await fetchChoices(chosen.api)).toEqual({
    cohort: { academicYear: 2027, semester: "spring" },
    programs: ["cs-2027", "math-2027"],
  });
  expect(new URL(chosen.sent[0]!.url).pathname).toBe("/api/programs");

  const none = client(() => Response.json({ cohort: null, programs: [], programWarnings: [], warnings: [] }));
  expect(await fetchChoices(none.api)).toEqual({ cohort: null, programs: [] });

  expect(await fetchChoices(client(() => Response.json({ reason: "state-file-unreadable" }, { status: 409 })).api)).toBeUndefined();
  expect(await fetchChoices(client(() => new Response("nope")).api)).toBeUndefined();
  expect(
    await fetchChoices(
      client(() => {
        throw new TypeError("fetch failed");
      }).api,
    ),
  ).toBeUndefined();
});

it("reads the Courses, and an empty list when they cannot be had", async () => {
  const courses = [{ courseNumber: "89-110", name: { he: "מבוא" }, credits: 6 }];
  const served = client(() => Response.json({ courses }));
  expect(await fetchCourses(served.api)).toEqual(courses);
  expect(new URL(served.sent[0]!.url).pathname).toBe("/api/courses");

  expect(await fetchCourses(client(() => new Response("nope", { status: 500 })).api)).toEqual([]);
  expect(await fetchCourses(client(() => new Response("nope")).api)).toEqual([]);
  expect(
    await fetchCourses(
      client(() => {
        throw new TypeError("fetch failed");
      }).api,
    ),
  ).toEqual([]);
});

const years = (input: Parameters<typeof planYears>[0]) =>
  planYears(input).map(({ academicYear, semesters }) => `${academicYear}:${semesters.join(",")}`);

it("starts the columns at a Fall Cohort and covers a standard degree", () => {
  expect(years({ cohort: { academicYear: 2027, semester: "fall" }, attempts: [], thisYear: 2030 })).toEqual([
    "2027:fall,spring,summer",
    "2028:fall,spring,summer",
    "2029:fall,spring,summer",
  ]);
});

it("starts a Spring Cohort's columns at its Spring, and ends its third study year in the Fall after", () => {
  expect(years({ cohort: { academicYear: 2027, semester: "spring" }, attempts: [], thisYear: 2030 })).toEqual([
    "2027:spring,summer",
    "2028:fall,spring,summer",
    "2029:fall,spring,summer",
    "2030:fall,spring,summer",
  ]);
});

it("reaches the last Attempt, an earlier one too, and as many years more as were asked", () => {
  const cohort = { academicYear: 2027, semester: "fall" } as const;
  expect(years({ cohort, attempts: [{ academicYear: 2031, semester: "spring" }], thisYear: 2027 }).at(-1)).toBe(
    "2031:fall,spring,summer",
  );
  // an exemption from before the student started is still on screen
  expect(years({ cohort, attempts: [{ academicYear: 2026, semester: "summer" }], thisYear: 2027 })[0]).toBe("2026:summer");
  expect(years({ cohort, attempts: [], thisYear: 2027, extraYears: 2 })).toHaveLength(5);
  expect(years({ cohort, attempts: [], thisYear: 2027, degreeYears: 1 })).toEqual(["2027:fall,spring,summer"]);
});

it("starts at the first Attempt with no Cohort, and at this year's Fall with neither", () => {
  expect(years({ cohort: null, attempts: [{ academicYear: 2028, semester: "spring" }], thisYear: 2030 })).toEqual([
    "2028:spring,summer",
    "2029:fall,spring,summer",
    "2030:fall,spring,summer",
    "2031:fall,spring,summer",
  ]);
  expect(years({ cohort: undefined, attempts: [], thisYear: 2030 })[0]).toBe("2030:fall,spring,summer");
});

it("shows the credit total the Plan answer serves for a Semester, and nothing for one it does not list", () => {
  const totals = [
    { academicYear: 2027, semester: "fall" as const, credits: 9, unknown: 0 },
    { academicYear: 2027, semester: "spring" as const, credits: 4, unknown: 1 },
  ];
  expect(columnCredits(totals, { academicYear: 2027, semester: "spring" })).toEqual({ credits: 4, unknown: 1 });
  expect(columnCredits(totals, { academicYear: 2028, semester: "spring" })).toEqual({ credits: 0, unknown: 0 });
});

it("places a retake in the next Fall or Spring, never a Summer", () => {
  expect(retakeSemester({ academicYear: 2027, semester: "fall" })).toEqual({ academicYear: 2027, semester: "spring" });
  expect(retakeSemester({ academicYear: 2027, semester: "spring" })).toEqual({ academicYear: 2028, semester: "fall" });
  expect(retakeSemester({ academicYear: 2027, semester: "summer" })).toEqual({ academicYear: 2028, semester: "fall" });
});

it("reads a typed grade as a number, a pass or a fail in either language, a clearing, or not a grade", () => {
  const words = { pass: ["Pass", "עובר"], fail: ["Fail", "נכשל"] };
  expect(gradeOf(" 87 ", words)).toEqual({ kind: "numeric", value: 87 });
  expect(gradeOf("pass", words)).toEqual({ kind: "pass-fail", passed: true });
  expect(gradeOf("נכשל", words)).toEqual({ kind: "pass-fail", passed: false });
  expect(gradeOf("", words)).toBeNull();
  expect(gradeOf("eighty", words)).toBeUndefined();
});
