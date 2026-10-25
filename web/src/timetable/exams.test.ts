import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import { fetchExams } from "./exams.ts";

/**
 * The exam rail's reader (#419): what the typed client asks for, and that every answer which is not
 * an exam period comes back as *not had* rather than as an empty one (#184's ruling). Invented data.
 */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";
const QUERY = { academicYear: 2027, semester: "spring", variant: "B", position: 1 } as const;

function client(answer: () => Response) {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    sent.push(new Request(new URL(String(input), "http://localhost:8900"), init));
    return answer();
  }) as typeof fetch;
  return { sent, api: createApiClient(() => TOKEN, fetchImpl) };
}

const SERVED = {
  variantName: "B",
  exams: {
    sittings: [{ courseNumber: "89-110", moed: "מועד א", date: "2027-06-21", time: "09:00", yearLong: false }],
    warnings: [],
    coursesWithUnknownExams: 1,
  },
  spacingDays: 4,
  version: "v1",
  warnings: [],
  catalogWarnings: [],
  catalogRefused: null,
};

it("asks for the exam period of the Semester and Variant named, and reads it", async () => {
  const { sent, api } = client(() => Response.json(SERVED));

  expect(await fetchExams(api, QUERY)).toEqual({
    variantName: "B",
    sittings: SERVED.exams.sittings,
    warnings: [],
    coursesWithUnknownExams: 1,
    spacingDays: 4,
  });
  const url = new URL(sent[0]!.url);
  expect(url.pathname).toBe("/api/timetable/2027/spring/exams");
  expect(url.search).toBe("?variant=B&position=1");
});

it("has no exam period from a refusal, the guard, or an answer without its lists", async () => {
  const refused = client(() => Response.json({ reason: "state-file-unreadable", warnings: [] }, { status: 409 }));
  const guarded = client(() => new Response(null, { status: 401 }));
  const partial = client(() => Response.json({ ...SERVED, exams: { coursesWithUnknownExams: 0 } }));

  expect(await fetchExams(refused.api, QUERY)).toBeUndefined();
  expect(await fetchExams(guarded.api, QUERY)).toBeUndefined();
  expect(await fetchExams(partial.api, QUERY)).toBeUndefined();
});
