import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import {
  choosePrograms,
  fetchProgress,
  fetchRequirementsFiles,
  pinCourse,
  tickManual,
  unpinCourse,
  untickManual,
} from "./progress.ts";

/**
 * The half of Progress that lives in `web` (#288): what the typed client sends, and what it makes
 * of every answer the API can give. The Program is invented (ADR-0006).
 */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

const SERVED = {
  programs: [],
  stoppedEarly: false,
  solverWarnings: [],
  programWarnings: [],
  pinWarnings: [
    { kind: "pin-file-not-chosen", courseNumber: "89-110", requirementId: "intro", requirementsFile: "math" },
  ],
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

it("asks for Progress with the launch token, and reads what is served", async () => {
  const { sent, api } = client(() => Response.json(SERVED));

  const result = await fetchProgress(api);

  expect(new URL(sent[0]!.url).pathname).toBe("/api/progress");
  expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  expect(result).toEqual({
    kind: "served",
    programs: [],
    stoppedEarly: false,
    solverWarnings: [],
    programWarnings: [],
    pinWarnings: SERVED.pinWarnings,
    stateWarnings: [{ kind: "cohort-unreadable" }],
    version: "a".repeat(64),
  });
});

it("sends each edit to its route with the revision it was based on", async () => {
  const { sent, api } = client(() => Response.json(SERVED));
  const pin = { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "intro" };
  const tick = { requirementsFile: "cs-2027", requirementId: "hebrew" };

  await pinCourse(api, pin, "v1");
  await unpinCourse(api, pin, "v2");
  await tickManual(api, tick, "v3");
  await untickManual(api, tick, "v4");

  expect(sent.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    "POST /api/progress/pins",
    "DELETE /api/progress/pins",
    "POST /api/progress/ticks",
    "DELETE /api/progress/ticks",
  ]);
  expect(await Promise.all(sent.map((request) => request.json()))).toEqual([
    { ...pin, basedOn: "v1" },
    { ...pin, basedOn: "v2" },
    { ...tick, basedOn: "v3" },
    { ...tick, basedOn: "v4" },
  ]);
});

it("reads a refusal, a 401, an unreadable body and no server apart", async () => {
  const refused = client(() => Response.json({ reason: "state-file-changed", warnings: [] }, { status: 409 }));
  expect(await fetchProgress(refused.api)).toEqual({ kind: "refused", reason: "state-file-changed" });

  const unauthorized = client(() => Response.json({ error: "unauthorized" }, { status: 401 }));
  expect(await fetchProgress(unauthorized.api)).toEqual({ kind: "unauthorized" });

  const html = client(() => new Response("<html>", { status: 500 }));
  expect(await fetchProgress(html.api)).toEqual({ kind: "unreadable-answer" });
  const notJson = client(() => new Response("nope", { status: 200 }));
  expect(await fetchProgress(notJson.api)).toEqual({ kind: "unreadable-answer" });

  const gone = client(() => {
    throw new TypeError("fetch failed");
  });
  expect(await fetchProgress(gone.api)).toEqual({ kind: "unreachable" });
});

it("chooses the Programs as a whole list, and reads what became of it", async () => {
  const saved = client(() => Response.json({ cohort: null, programs: [], programWarnings: [], warnings: [] }));
  expect(await choosePrograms(saved.api, [{ requirementsFile: "cs-2027", track: "ai" }], "v1")).toEqual({
    kind: "saved",
  });
  expect(saved.sent[0]!.method).toBe("PUT");
  expect(await saved.sent[0]!.json()).toEqual({
    programs: [{ requirementsFile: "cs-2027", track: "ai" }],
    basedOn: "v1",
  });

  const refused = client(() => Response.json({ reason: "workspace-not-ready", warnings: [] }, { status: 409 }));
  expect(await choosePrograms(refused.api, [], undefined)).toEqual({
    kind: "refused",
    reason: "workspace-not-ready",
  });
  const unauthorized = client(() => Response.json({ error: "unauthorized" }, { status: 401 }));
  expect(await choosePrograms(unauthorized.api, [], undefined)).toEqual({ kind: "unauthorized" });
  const gone = client(() => {
    throw new TypeError("fetch failed");
  });
  expect(await choosePrograms(gone.api, [], undefined)).toEqual({ kind: "unreachable" });
});

it("lists the Requirements Files, or nothing when they cannot be had", async () => {
  const files = [{ name: "notes", status: "not-requirements", warnings: [] }];
  expect(await fetchRequirementsFiles(client(() => Response.json({ files })).api)).toEqual(files);
  expect(
    await fetchRequirementsFiles(client(() => Response.json({ reason: "workspace-refused" }, { status: 409 })).api),
  ).toBeUndefined();
});
