import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import {
  addBlockedTime,
  copyBlockedTimes,
  removeBlockedTime,
  replaceBlockedTime,
} from "./blockedTimes.ts";

/** The Blocked Time requests (#282): which route each reaches, and what it sends. */
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const VERSION = "a".repeat(64);
const WORK = { day: "tuesday", start: "13:00", end: "17:00", label: "work" } as const;

function client() {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    sent.push(new Request(new URL(String(input), "http://localhost:8900"), init));
    return Response.json({
      variantName: "A",
      variants: [],
      variantWarnings: [],
      tray: [],
      blockedTimes: [{ semester: "fall", ...WORK }],
      blockedTimeWarnings: [],
      picks: [],
      clashes: [],
      version: VERSION,
      warnings: [],
    });
  }) as typeof fetch;
  return { sent, api: createApiClient(() => "token", fetchImpl) };
}

const routeOf = (request: Request) => [request.method, new URL(request.url).pathname];

it("adds, replaces, removes and copies, each on its own route with the revision", async () => {
  const { sent, api } = client();
  const at = { ...FALL_2027, variant: "B" };

  const added = await addBlockedTime(api, at, WORK, VERSION);
  await replaceBlockedTime(api, at, 2, WORK, VERSION);
  await removeBlockedTime(api, FALL_2027, 1, VERSION);
  await copyBlockedTimes(api, FALL_2027, { academicYear: 2027, semester: "spring" }, VERSION);

  expect(sent.map(routeOf)).toEqual([
    ["POST", "/api/timetable/2027/fall/blocked-times"],
    ["PUT", "/api/timetable/2027/fall/blocked-times"],
    ["DELETE", "/api/timetable/2027/fall/blocked-times"],
    ["POST", "/api/timetable/2027/fall/blocked-times/copy"],
  ]);
  await expect(sent[0]!.json()).resolves.toEqual({ ...WORK, variant: "B", basedOn: VERSION });
  await expect(sent[1]!.json()).resolves.toEqual({ ...WORK, index: 2, variant: "B", basedOn: VERSION });
  await expect(sent[2]!.json()).resolves.toEqual({ index: 1, basedOn: VERSION });
  await expect(sent[3]!.json()).resolves.toEqual({
    toYear: 2027,
    toSemester: "spring",
    basedOn: VERSION,
  });
  expect(added).toMatchObject({ kind: "served", blockedTimes: [{ label: "work" }] });
});
