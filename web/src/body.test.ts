import { expect, it } from "vitest";
import { readBody, UNAUTHORIZED } from "./body.ts";

/**
 * Reading one answer's body, and the one status the contract does not describe.
 *
 * One copy of the reader, shared by `settings.ts`, `history.ts`, `timetable/picks.ts` and
 * `timetable/offerings.ts` — there were three, two of them still let `json()` reject (#171), and
 * `history.ts` was a fourth that nobody had counted (#206). These tests moved here from
 * `api.test.ts` with the module they are about (#208).
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

/**
 * The status the five sites compare against — four `read` functions and `changes.ts`'s poll
 * closure — measured against a real `Response`
 * rather than against the literal they each used to write — which is the only way this can fail
 * for the reason it is named after. `expect(UNAUTHORIZED).toBe(401)` restates the declaration and
 * would pass for any number both sides agreed on.
 */
it("is the status a refused launch token actually arrives with", () => {
  expect(new Response("", { status: 401 }).status).toBe(UNAUTHORIZED);
});
