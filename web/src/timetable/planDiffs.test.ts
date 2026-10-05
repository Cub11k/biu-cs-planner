import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import { applyPlanDiff, isActionable, type ActionablePlanDiff } from "./planDiffs.ts";

/**
 * The half of "apply to Plan" that lives in `web` (#296): what the typed client sends, and what it
 * makes of every answer — the Timetable, a stale Plan Diff, every other refusal, and no server.
 *
 * Fixture data is invented. 89-210 is a real BIU course number, and no crawled data is committed to
 * this repo (ADR-0006).
 */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";
const VERSION = "a".repeat(64);
const QUERY = { academicYear: 2027, semester: "fall", variant: "B", position: 1 } as const;
const ADD: ActionablePlanDiff = { kind: "add", courseNumber: "89-210", academicYear: 2027, semester: "fall", semesters: ["fall"] };

function client(answer: (request: Request) => Response | Promise<Response>) {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    const request = new Request(new URL(String(input), "http://localhost:8900"), init);
    sent.push(request);
    return answer(request);
  }) as typeof fetch;
  return { sent, api: createApiClient(() => TOKEN, fetchImpl) };
}

it("sends the Plan Diff by its kind and Course, with the Variant and the revision", async () => {
  const { sent, api } = client(() =>
    Response.json({ variantName: "B", picks: [], clashes: [], planDiffs: [], version: VERSION, warnings: [] }),
  );

  const answer = await applyPlanDiff(api, QUERY, ADD, VERSION);

  expect(answer).toMatchObject({ kind: "served", variantName: "B", planDiffs: [], version: VERSION });
  expect(sent[0]!.method).toBe("POST");
  expect(new URL(sent[0]!.url).pathname).toBe("/api/timetable/2027/fall/plan-diffs/apply");
  expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  await expect(sent[0]!.json()).resolves.toEqual({
    variant: "B",
    position: 1,
    kind: "add",
    courseNumber: "89-210",
    basedOn: VERSION,
  });
});

it("reads a stale Plan Diff as its own answer, and every other refusal as the Timetable's", async () => {
  const stale = client(() => Response.json({ reason: "plan-diff-stale", version: VERSION, warnings: [] }, { status: 409 }));
  expect(await applyPlanDiff(stale.api, QUERY, ADD, VERSION)).toEqual({ kind: "plan-diff-stale" });

  const changed = client(() => Response.json({ reason: "state-file-changed", warnings: [] }, { status: 409 }));
  expect(await applyPlanDiff(changed.api, QUERY, ADD, VERSION)).toEqual({
    kind: "refused",
    reason: "state-file-changed",
    warnings: [],
  });

  const garbled = client(() => new Response("<html>", { status: 409 }));
  expect(await applyPlanDiff(garbled.api, QUERY, ADD, VERSION)).toEqual({ kind: "unreadable-answer" });
});

it("calls a request that never arrived unreachable", async () => {
  const { api } = client(() => {
    throw new TypeError("connection refused");
  });

  expect(await applyPlanDiff(api, QUERY, ADD, VERSION)).toEqual({ kind: "unreachable" });
});

it("offers an apply for every kind but not-offered", () => {
  expect(isActionable(ADD)).toBe(true);
  expect(isActionable({ kind: "not-offered", courseNumber: "89-999", academicYear: 2027, semester: "fall", attemptIds: [] })).toBe(false);
});
