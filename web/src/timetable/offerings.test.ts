import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import type { Offering } from "./catalog.ts";
import { fetchOfferings } from "./offerings.ts";

const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

const OFFERING: Offering = {
  courseNumber: "89-110",
  nameHebrew: "מבוא למדעי המחשב",
  credits: { known: true, total: 3 },
  semesters: ["fall"],
  groups: [],
  exams: { known: false, sittings: [] },
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

it("asks for one Academic Year and Semester, with the launch token", async () => {
  const { sent, api } = client(() => Response.json({ offerings: [], warnings: [] }));

  await fetchOfferings(api, { academicYear: 2027, semester: "fall" });

  const url = new URL(sent[0]!.url);
  expect(url.pathname).toBe("/api/catalog/2027/offerings");
  expect(url.searchParams.get("semester")).toBe("fall");
  expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
});

it("hands back the Offerings it was served", async () => {
  const { api } = client(() => Response.json({ offerings: [OFFERING], warnings: [] }));

  const result = await fetchOfferings(api, { academicYear: 2027, semester: "fall" });

  expect(result).toEqual({ kind: "served", offerings: [OFFERING] });
});

it("says the year has no Catalog, and carries the Warning that says so", async () => {
  const warnings = [{ kind: "no-catalog-for-year", academicYear: 2027 }];
  const { api } = client(() => Response.json({ warnings }, { status: 404 }));

  const result = await fetchOfferings(api, { academicYear: 2027, semester: "fall" });

  expect(result).toEqual({ kind: "refused", warnings });
});

it("keeps a Catalog that could not be read apart from one that is not there", async () => {
  const warnings = [{ kind: "schema-version-too-new", found: 2 }];
  const { api } = client(() => Response.json({ warnings }, { status: 404 }));

  const result = await fetchOfferings(api, { academicYear: 2027, semester: "fall" });

  // the file is there; telling the student to import a crawl would not help them
  expect(result).toEqual({ kind: "refused", warnings });
});

it("keeps a Workspace refusal apart from absence", async () => {
  const warnings = [{ kind: "workspace-refused", reason: "not a catalog" }];
  const { api } = client(() => Response.json({ warnings }, { status: 409 }));

  const result = await fetchOfferings(api, { academicYear: 2027, semester: "fall" });

  expect(result).toEqual({ kind: "refused", warnings });
});

it("says so when the page has no launch token, rather than blaming the Catalog", async () => {
  const { api } = client(() => Response.json({ error: "unauthorized" }, { status: 401 }));

  const result = await fetchOfferings(api, { academicYear: 2027, semester: "fall" });

  expect(result).toEqual({ kind: "unauthorized" });
});

it("says the API is unreachable rather than throwing at the screen", async () => {
  const { api } = client(() => {
    throw new Error("connection refused");
  });

  const result = await fetchOfferings(api, { academicYear: 2027, semester: "fall" });

  expect(result).toEqual({ kind: "unreachable" });
});
