import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import { fetchRegistration, markRegistered, unmarkRegistered } from "./registration.ts";

/**
 * The half of marking a Variant registered that lives in `web` (#297): what the typed client sends
 * for the preview, the mark and the unmark, and what it makes of a preview it cannot use.
 *
 * Fixture data is invented, and no crawled data is committed to this repo (ADR-0006).
 */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";
const VERSION = "a".repeat(64);
const QUERY = { academicYear: 2027, semester: "fall", variant: "B", position: 1 } as const;

function client(answer: (request: Request) => Response | Promise<Response>) {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    const request = new Request(new URL(String(input), "http://localhost:8900"), init);
    sent.push(request);
    return answer(request);
  }) as typeof fetch;
  return { sent, api: createApiClient(() => TOKEN, fetchImpl) };
}

it("asks for the preview of the Variant named, and reads what it would change", async () => {
  const { sent, api } = client(() =>
    Response.json({ variantName: "B", variantPosition: 1, planDiffs: [], registers: ["89-110"], version: VERSION, warnings: [] }),
  );

  expect(await fetchRegistration(api, QUERY)).toEqual({
    kind: "served",
    variantName: "B",
    planDiffs: [],
    registers: ["89-110"],
    version: VERSION,
  });
  const url = new URL(sent[0]!.url);
  expect(url.pathname).toBe("/api/timetable/2027/fall/registration");
  expect(url.search).toBe("?variant=B&position=1");
});

it("calls every preview it cannot use unavailable, so only the mark is offered", async () => {
  const answers = [
    () => Response.json({ reason: "state-file-unreadable", warnings: [] }, { status: 409 }),
    () => new Response("<html>"),
    () => Response.json({ variantName: "B", version: VERSION }),
    () => {
      throw new TypeError("connection refused");
    },
  ];
  for (const answer of answers) {
    const { api } = client(answer);
    expect(await fetchRegistration(api, QUERY)).toEqual({ kind: "unavailable" });
  }
});

it("always sends the student's answer to the offer with the mark, and nothing with the unmark", async () => {
  const served = () => Response.json({ variantName: "B", picks: [], clashes: [], version: VERSION, warnings: [] });
  const marking = client(served);
  await markRegistered(marking.api, QUERY, "B", false, VERSION);
  expect(marking.sent[0]!.method).toBe("POST");
  expect(new URL(marking.sent[0]!.url).pathname).toBe("/api/timetable/2027/fall/variants/registered");
  await expect(marking.sent[0]!.json()).resolves.toEqual({ variant: "B", position: 1, applyDiffs: false, basedOn: VERSION });

  const unmarking = client(served);
  await unmarkRegistered(unmarking.api, QUERY, "B", VERSION);
  expect(unmarking.sent[0]!.method).toBe("DELETE");
  await expect(unmarking.sent[0]!.json()).resolves.toEqual({ variant: "B", position: 1, basedOn: VERSION });
});
