import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import { fetchTimetable, recordPick, removePick, type GroupPick } from "./picks.ts";

/**
 * The half of picking that lives in `web`: what the typed client actually sends, and what
 * it makes of every answer the API can give.
 *
 * Fixture data is invented. 89-110 is a real BIU course number, the Meetings are not, and
 * no crawled data is committed to this repo (ADR-0006).
 */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;

const LECTURE: GroupPick = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

const served = { variantName: "A", picks: [LECTURE], clashes: [], warnings: [] };

/** Stands in for the network, recording what the typed client actually sent. */
function client(answer: (request: Request) => Response | Promise<Response>) {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    const request = new Request(new URL(String(input), "http://localhost:8900"), init);
    sent.push(request);
    return answer(request);
  }) as typeof fetch;
  return { sent, api: createApiClient(() => TOKEN, fetchImpl) };
}

it("asks for one Semester's Picks, by year and Semester and with the launch token", async () => {
  const { sent, api } = client(() => Response.json(served));

  const result = await fetchTimetable(api, FALL_2027);

  expect(new URL(sent[0]!.url).pathname).toBe("/api/timetable/2027/fall");
  expect(sent[0]!.method).toBe("GET");
  expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  expect(result).toEqual({ kind: "served", variantName: "A", picks: [LECTURE], clashes: [] });
});

it("sends the Pick, snapshot and all, to the route that records one", async () => {
  const { sent, api } = client(() => Response.json(served));

  await recordPick(api, FALL_2027, LECTURE);

  expect(new URL(sent[0]!.url).pathname).toBe("/api/timetable/2027/fall/picks");
  expect(sent[0]!.method).toBe("POST");
  // the snapshot is what makes "changed since picked" possible later, so it is sent
  await expect(sent[0]!.json()).resolves.toEqual(LECTURE);
});

it("names the slot, and only the slot, when removing a Pick", async () => {
  const { sent, api } = client(() => Response.json({ ...served, picks: [] }));

  const result = await removePick(api, FALL_2027, {
    courseNumber: "89-110",
    lessonType: "הרצאה",
  });

  expect(sent[0]!.method).toBe("DELETE");
  await expect(sent[0]!.json()).resolves.toEqual({
    courseNumber: "89-110",
    lessonType: "הרצאה",
  });
  expect(result).toMatchObject({ kind: "served", picks: [] });
});

it("carries a Clash back rather than treating it as a failure", async () => {
  const clashes = [
    {
      kind: "meeting-meeting",
      overlap: { semester: "fall", day: "tuesday", start: "16:00", end: "17:00" },
      first: { group: { courseNumber: "89-110", lessonType: "הרצאה", number: "01" }, meeting: {} },
      second: { group: { courseNumber: "89-210", lessonType: "הרצאה", number: "01" }, meeting: {} },
    },
  ];
  const { api } = client(() => Response.json({ ...served, clashes }));

  const result = await recordPick(api, FALL_2027, LECTURE);

  expect(result.kind).toBe("served");
  if (result.kind !== "served") throw new Error("a Clash was treated as a refusal");
  expect(result.clashes).toHaveLength(1);
});

it("says the State File was refused, and carries the Warnings that say why", async () => {
  const warnings = [{ kind: "schema-version-too-new", found: 99 }];
  const { api } = client(() =>
    Response.json({ reason: "state-file-unreadable", warnings }, { status: 409 }),
  );

  const result = await recordPick(api, FALL_2027, LECTURE);

  expect(result).toEqual({ kind: "refused", reason: "state-file-unreadable", warnings });
});

it("keeps a folder that is not a Workspace apart from a file it could not read", async () => {
  const { api } = client(() =>
    Response.json({ reason: "workspace-not-ready", warnings: [] }, { status: 409 }),
  );

  // the two ask the student for different things: accept the layout, or fix the file
  await expect(recordPick(api, FALL_2027, LECTURE)).resolves.toEqual({
    kind: "refused",
    reason: "workspace-not-ready",
    warnings: [],
  });
});

it("knows a page with no launch token from a server that would not serve it", async () => {
  const { api } = client(() => Response.json({ error: "unauthorized" }, { status: 401 }));

  await expect(fetchTimetable(api, FALL_2027)).resolves.toEqual({ kind: "unauthorized" });
});

it("says the server is not there rather than throwing at the screen", async () => {
  const { api } = client(() => {
    throw new TypeError("Failed to fetch");
  });

  await expect(fetchTimetable(api, FALL_2027)).resolves.toEqual({ kind: "unreachable" });
  await expect(recordPick(api, FALL_2027, LECTURE)).resolves.toEqual({ kind: "unreachable" });
});
