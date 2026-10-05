import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import { fetchTimetable } from "./picks.ts";
import { addToTray, removeFromTray } from "./tray.ts";

/** The Tray requests (#283): which route each reaches, and what it sends. */
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const VERSION = "a".repeat(64);

const ENTRY = {
  courseNumber: "89-110",
  origins: ["added"],
  known: true,
  chips: [{ lessonType: "הרצאה" }],
  complete: false,
};

function client() {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    sent.push(new Request(new URL(String(input), "http://localhost:8900"), init));
    return Response.json({
      variantName: "A",
      variants: [{ name: "A", primary: true }],
      variantWarnings: [],
      tray: [ENTRY],
      picks: [],
      clashes: [],
      version: VERSION,
      warnings: [],
    });
  }) as typeof fetch;
  return { sent, api: createApiClient(() => "token", fetchImpl) };
}

it("adds a Course to the Tray of the Variant shown, and reads the Tray back", async () => {
  const { sent, api } = client();

  const result = await addToTray(api, { ...FALL_2027, variant: "B" }, "89-110", VERSION);

  expect([sent[0]!.method, new URL(sent[0]!.url).pathname]).toEqual([
    "POST",
    "/api/timetable/2027/fall/tray",
  ]);
  await expect(sent[0]!.json()).resolves.toEqual({
    variant: "B",
    courseNumber: "89-110",
    basedOn: VERSION,
  });
  expect(result).toMatchObject({ kind: "served", tray: [ENTRY] });
});

it("takes a Course out of the Tray, naming no Variant for the primary", async () => {
  const { sent, api } = client();

  await removeFromTray(api, FALL_2027, "89-110", VERSION);

  expect([sent[0]!.method, new URL(sent[0]!.url).pathname]).toEqual([
    "DELETE",
    "/api/timetable/2027/fall/tray",
  ]);
  await expect(sent[0]!.json()).resolves.toEqual({ courseNumber: "89-110", basedOn: VERSION });
});

it("carries the Tray on every Timetable read", async () => {
  const { api } = client();

  await expect(fetchTimetable(api, FALL_2027)).resolves.toMatchObject({ tray: [ENTRY] });
});
