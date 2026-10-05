import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import {
  createVariant,
  deleteVariant,
  duplicateVariant,
  renameVariant,
  setPrimaryVariant,
} from "./variants.ts";

/**
 * The Variant requests (#281): which route each reaches, what it sends, and that each answer is
 * read as the Timetable the screen already knows how to show.
 */
const TOKEN = "test-token";
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const VERSION = "a".repeat(64);

const served = {
  variantName: "B",
  variants: [
    { name: "A", primary: true },
    { name: "B", primary: false },
  ],
  variantWarnings: [],
  picks: [],
  clashes: [],
  version: VERSION,
  warnings: [],
};

function client(answer: () => Response) {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    sent.push(new Request(new URL(String(input), "http://localhost:8900"), init));
    return answer();
  }) as typeof fetch;
  return { sent, api: createApiClient(() => TOKEN, fetchImpl) };
}

const routeOf = (request: Request) => [request.method, new URL(request.url).pathname];

it("creates a Variant with the name typed, or with none for the next letter", async () => {
  const { sent, api } = client(() => Response.json(served));

  const result = await createVariant(api, FALL_2027, "Sunday off", VERSION);
  await createVariant(api, FALL_2027, undefined, VERSION);

  expect(routeOf(sent[0]!)).toEqual(["POST", "/api/timetable/2027/fall/variants"]);
  await expect(sent[0]!.json()).resolves.toEqual({ name: "Sunday off", basedOn: VERSION });
  await expect(sent[1]!.json()).resolves.toEqual({ basedOn: VERSION });
  expect(result).toMatchObject({ kind: "served", variantName: "B", variants: served.variants });
});

it("duplicates the Variant shown", async () => {
  const { sent, api } = client(() => Response.json(served));

  await duplicateVariant(api, { ...FALL_2027, variant: "A" }, VERSION);

  expect(routeOf(sent[0]!)).toEqual(["POST", "/api/timetable/2027/fall/variants/duplicate"]);
  await expect(sent[0]!.json()).resolves.toEqual({ variant: "A", basedOn: VERSION });
});

it("renames, makes primary and deletes the Variant named", async () => {
  const { sent, api } = client(() => Response.json(served));

  await renameVariant(api, FALL_2027, "A", "Mornings", VERSION);
  await setPrimaryVariant(api, FALL_2027, "B", VERSION);
  await deleteVariant(api, FALL_2027, "B", VERSION);

  expect(sent.map(routeOf)).toEqual([
    ["POST", "/api/timetable/2027/fall/variants/rename"],
    ["POST", "/api/timetable/2027/fall/variants/primary"],
    ["DELETE", "/api/timetable/2027/fall/variants"],
  ]);
  await expect(sent[0]!.json()).resolves.toEqual({
    variant: "A",
    name: "Mornings",
    basedOn: VERSION,
  });
  await expect(sent[1]!.json()).resolves.toEqual({ variant: "B", basedOn: VERSION });
  await expect(sent[2]!.json()).resolves.toEqual({ variant: "B", basedOn: VERSION });
});

it("reads a refused Variant edit the way a refused Pick is read", async () => {
  const { api } = client(() =>
    Response.json({ reason: "state-file-changed", warnings: [] }, { status: 409 }),
  );

  await expect(deleteVariant(api, FALL_2027, "B", VERSION)).resolves.toEqual({
    kind: "refused",
    reason: "state-file-changed",
    warnings: [],
  });
});
