import { expect, it } from "vitest";
import { createApiClient, readBody } from "./api.ts";

const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

/** Stands in for the network: records what was sent and answers something JSON-shaped. */
function recordingFetch() {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    const request = new Request(new URL(String(input), "http://localhost:8900"), init);
    sent.push(request);
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

it("sends the token on a read", async () => {
  const { sent, fetchImpl } = recordingFetch();
  const api = createApiClient(() => TOKEN, fetchImpl);

  await api.api.health.$get();

  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
});

it("sends the token on a write too", async () => {
  const { sent, fetchImpl } = recordingFetch();
  const api = createApiClient(() => TOKEN, fetchImpl);

  await api.api.workspace.$post();

  expect(sent[0]!.method).toBe("POST");
  expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
});

it("sends the token on every request, not only the first", async () => {
  const { sent, fetchImpl } = recordingFetch();
  const api = createApiClient(() => TOKEN, fetchImpl);

  await api.api.health.$get();
  await api.api.workspace.$get();
  await api.api.catalog[":year"].offerings[":courseNumber"].$get({
    param: { year: "2027", courseNumber: "89-110" },
  });

  expect(sent).toHaveLength(3);
  for (const request of sent) {
    expect(request.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  }
});

it("reads the token when it sends, not when the client is made", async () => {
  // the client is built as the module loads, and the token is claimed from the URL
  // after that, so a client that captured the token up front would send nothing
  const { sent, fetchImpl } = recordingFetch();
  let token: string | undefined;
  const api = createApiClient(() => token, fetchImpl);

  await api.api.health.$get();
  token = TOKEN;
  await api.api.health.$get();

  expect(sent[0]!.headers.get("Authorization")).toBeNull();
  expect(sent[1]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
});

it("sends no Authorization header at all when there is no token", async () => {
  const { sent, fetchImpl } = recordingFetch();
  const api = createApiClient(() => undefined, fetchImpl);

  await api.api.health.$get();

  // "Bearer undefined" would be a token the server has to refuse; no header is honest
  expect(sent[0]!.headers.has("Authorization")).toBe(false);
});

/**
 * Reading one answer's body. One copy of this, shared by `settings.ts`, `timetable/picks.ts`
 * and `timetable/offerings.ts` — there were three, and two of them still let `json()` reject
 * (#171).
 */
it("hands back a body it could read", async () => {
  const read = await readBody(() => Response.json({ offerings: [] }).json());

  expect(read).toEqual({ readable: true, body: { offerings: [] } });
});

it("says a body is not readable rather than rejecting, for the HTML a dev proxy answers", async () => {
  const answer = new Response("<!doctype html><h1>500 Internal Server Error</h1>", {
    status: 500,
    headers: { "content-type": "text/html" },
  });

  await expect(readBody(() => answer.json())).resolves.toEqual({ readable: false });
});

it("carries no body on an answer it could not read, so nothing can be read off one", async () => {
  const read = await readBody(() => new Response("404 Not Found", { status: 404 }).json());

  expect(read.readable).toBe(false);
  expect("body" in read).toBe(false);
});

/** An empty body is the commonest unreadable one: a 204, or a refusal that sent nothing. */
it("says an empty body is not readable", async () => {
  await expect(readBody(() => new Response("").json())).resolves.toEqual({ readable: false });
});

/** Only the read is guarded: a `null` body really is JSON, and is handed back as one. */
it("hands back a body that is JSON but says nothing", async () => {
  await expect(readBody(() => Response.json(null).json())).resolves.toEqual({
    readable: true,
    body: null,
  });
});
