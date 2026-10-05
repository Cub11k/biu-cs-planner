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

/** A revision, in the shape the adapter produces: a SHA-256 of the file, as hex. */
const VERSION = "a".repeat(64);

const served = {
  variantName: "A",
  variants: [{ name: "A", primary: true }],
  variantWarnings: [],
  picks: [LECTURE],
  clashes: [],
  version: VERSION,
  warnings: [],
};

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
  expect(result).toEqual({
    kind: "served",
    variantName: "A",
    variants: [{ name: "A", primary: true }],
    variantWarnings: [],
    tray: [],
    blockedTimes: [],
    blockedTimeWarnings: [],
    // an answer with none, as one from before #295 is read: no Plan Diffs
    planDiffs: [],
    picks: [LECTURE],
    clashes: [],
    // what the page holds so that a save made on this view can say what it was based on
    version: VERSION,
  });
  // no Variant named: the server answers about the primary, which a Semester opens on (#281)
  expect(new URL(sent[0]!.url).search).toBe("");
});

it("asks for the Variant named, in the query and as the student wrote it", async () => {
  const { sent, api } = client(() => Response.json(served));

  await fetchTimetable(api, { ...FALL_2027, variant: "ללא ראשון" });

  expect(new URL(sent[0]!.url).searchParams.get("variant")).toBe("ללא ראשון");
});

it("reads an answer with no Variant tabs in it as a Timetable with none", async () => {
  // an older server, or a fake written before #281: the week it carries is still the week
  const { api } = client(() =>
    Response.json({ variantName: "A", picks: [], clashes: [], warnings: [] }),
  );

  await expect(fetchTimetable(api, FALL_2027)).resolves.toMatchObject({
    kind: "served",
    variants: [],
    variantWarnings: [],
  });
});

it("names the Variant a Pick goes into, and its removal too", async () => {
  const { sent, api } = client(() => Response.json(served));

  await recordPick(api, { ...FALL_2027, variant: "B" }, LECTURE, VERSION);
  await removePick(api, { ...FALL_2027, variant: "B" }, { courseNumber: "89-110", lessonType: "הרצאה" }, VERSION);

  await expect(sent[0]!.json()).resolves.toEqual({ ...LECTURE, variant: "B", basedOn: VERSION });
  await expect(sent[1]!.json()).resolves.toEqual({
    courseNumber: "89-110",
    lessonType: "הרצאה",
    variant: "B",
    basedOn: VERSION,
  });
});

it("sends the Pick, snapshot and all, to the route that records one", async () => {
  const { sent, api } = client(() => Response.json(served));

  await recordPick(api, FALL_2027, LECTURE, VERSION);

  expect(new URL(sent[0]!.url).pathname).toBe("/api/timetable/2027/fall/picks");
  expect(sent[0]!.method).toBe("POST");
  // the snapshot is what makes "changed since picked" possible later, so it is sent — and so
  // is the revision the view was read from, which is what the server guards on (#90)
  await expect(sent[0]!.json()).resolves.toEqual({ ...LECTURE, basedOn: VERSION });
});

/**
 * A first save is based on no file, and that claim is carried rather than left out: the
 * server treats an absent revision as "there is no State File yet" and refuses it when
 * there is one, so the page never sends nothing by accident.
 */
it("says a save was based on no file when the page has no revision to send", async () => {
  const { sent, api } = client(() => Response.json(served));

  await recordPick(api, FALL_2027, LECTURE, undefined);

  await expect(sent[0]!.json()).resolves.toEqual(LECTURE);
});

/** A refused overwrite arrives as its own reason, so the screen can say what happened. */
it("reports a save the server refused because the file had changed", async () => {
  const { api } = client(() =>
    Response.json({ reason: "state-file-changed", warnings: [] }, { status: 409 }),
  );

  const result = await recordPick(api, FALL_2027, LECTURE, VERSION);

  expect(result).toEqual({ kind: "refused", reason: "state-file-changed", warnings: [] });
});

it("names the slot, and only the slot, when removing a Pick", async () => {
  const { sent, api } = client(() => Response.json({ ...served, picks: [] }));

  const result = await removePick(
    api,
    FALL_2027,
    { courseNumber: "89-110", lessonType: "הרצאה" },
    VERSION,
  );

  expect(sent[0]!.method).toBe("DELETE");
  await expect(sent[0]!.json()).resolves.toEqual({
    courseNumber: "89-110",
    lessonType: "הרצאה",
    basedOn: VERSION,
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

  const result = await recordPick(api, FALL_2027, LECTURE, VERSION);

  expect(result.kind).toBe("served");
  if (result.kind !== "served") throw new Error("a Clash was treated as a refusal");
  expect(result.clashes).toHaveLength(1);
});

it("says the State File was refused, and carries the Warnings that say why", async () => {
  const warnings = [{ kind: "schema-version-too-new", found: 99 }];
  const { api } = client(() =>
    Response.json({ reason: "state-file-unreadable", warnings }, { status: 409 }),
  );

  const result = await recordPick(api, FALL_2027, LECTURE, VERSION);

  expect(result).toEqual({ kind: "refused", reason: "state-file-unreadable", warnings });
});

it("keeps a folder that is not a Workspace apart from a file it could not read", async () => {
  const { api } = client(() =>
    Response.json({ reason: "workspace-not-ready", warnings: [] }, { status: 409 }),
  );

  // the two ask the student for different things: accept the layout, or fix the file
  await expect(recordPick(api, FALL_2027, LECTURE, VERSION)).resolves.toEqual({
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
  await expect(recordPick(api, FALL_2027, LECTURE, VERSION)).resolves.toEqual({ kind: "unreachable" });
});

/**
 * **The defect #171 is filed for.** The body was read outside the `catch` that was meant to
 * cover it, so an error body that is not JSON rejected the promise instead of producing an
 * answer — and `TimetableScreen` has no `.catch` on these paths, so the click appeared to do
 * nothing at all.
 *
 * Driven as the HTML 500 Vite's `/api` proxy answers when the server behind it is not running,
 * which is how this arrives in ordinary development rather than as a contract curiosity.
 */
/**
 * A factory and not one held `Response`: a body can be read once, so a shared instance only works
 * while every caller remembers to clone it, and the first test that forgets reads an empty body
 * and passes for the wrong reason.
 */
const htmlFiveHundred = (): Response =>
  new Response("<!doctype html><h1>500 Internal Server Error</h1>", {
    status: 500,
    headers: { "content-type": "text/html" },
  });

it("makes an answer of an error body that is not JSON, rather than rejecting", async () => {
  const { api } = client(htmlFiveHundred);

  await expect(fetchTimetable(api, FALL_2027)).resolves.toEqual({ kind: "unreadable-answer" });
  await expect(recordPick(api, FALL_2027, LECTURE, VERSION)).resolves.toEqual({
    kind: "unreadable-answer",
  });
  await expect(
    removePick(api, FALL_2027, { courseNumber: "89-110", lessonType: "הרצאה" }, VERSION),
  ).resolves.toEqual({ kind: "unreadable-answer" });
});

/** A plain-text 404, which is what hono answers for a path only a newer bundle asks for. */
it("makes an answer of a plain-text refusal too", async () => {
  const { api } = client(() => new Response("404 Not Found", { status: 404 }));

  await expect(recordPick(api, FALL_2027, LECTURE, VERSION)).resolves.toEqual({
    kind: "unreadable-answer",
  });
});

/**
 * A 200 whose body is not JSON either. The same door: the dev proxy can answer a GET with a
 * page, and a read that rejected would leave the week on `loading` for the life of the page.
 */
it("makes an answer of a served body that is not JSON", async () => {
  const { api } = client(() => new Response("<!doctype html>", { status: 200 }));

  await expect(fetchTimetable(api, FALL_2027)).resolves.toEqual({ kind: "unreadable-answer" });
});

/**
 * …and it is **not** `refused`, which is the half of the ticket that is about what the student
 * is told. `refused` with no reason is said as `picksUnreadable` — "your saved picks could not
 * be read" — and nothing about an unparseable body says the State File was reached at all.
 */
it("does not call an unreadable answer a refusal, which would name a cause it does not know", async () => {
  const { api } = client(htmlFiveHundred);

  const result = await fetchTimetable(api, FALL_2027);

  expect(result.kind).not.toBe("refused");
  expect(result.kind).not.toBe("unreachable");
});

/** 401 is answered from the status alone, so the guard's body is never read for it. */
it("still reads a 401 as having no token, whatever body the guard sent", async () => {
  const { api } = client(() => new Response("unauthorized", { status: 401 }));

  await expect(fetchTimetable(api, FALL_2027)).resolves.toEqual({ kind: "unauthorized" });
});

/**
 * A body of JSON `null`, served and refused (#230). `readBody` used to call it readable, and
 * `read` then threw on `refused.body.reason` or `body.variantName` outside any `try`, so the
 * promise rejected and the screen had nothing to say. Every function here reads through `read`,
 * so all three are asked.
 */
it.each([200, 409])("makes an answer of a %i whose body is null", async (status) => {
  const { api } = client(() => Response.json(null, { status }));

  await expect(fetchTimetable(api, FALL_2027)).resolves.toEqual({ kind: "unreadable-answer" });
  await expect(recordPick(api, FALL_2027, LECTURE, VERSION)).resolves.toEqual({
    kind: "unreadable-answer",
  });
  await expect(
    removePick(api, FALL_2027, { courseNumber: "89-110", lessonType: "הרצאה" }, VERSION),
  ).resolves.toEqual({ kind: "unreadable-answer" });
});
