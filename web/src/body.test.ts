import { expect, it } from "vitest";
import { readBody } from "./body.ts";

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

/**
 * A body that is JSON and not an object is not one any caller can read a field off, so it is
 * an answer this page cannot read (#230). `null` is the case the ticket was filed for: this file
 * used to assert it came back `readable: true`, and every caller then threw on it, outside any
 * `try`, with the student told nothing. The others fail the same way at `"warnings" in body`.
 */
it.each([
  ["null", null],
  ["a number", 0],
  ["a string", "ok"],
  ["a boolean", true],
  ["an array", []],
])("says a body that is %s is not readable, although it is JSON", async (_, value) => {
  await expect(readBody(() => Response.json(value).json())).resolves.toEqual({
    readable: false,
  });
});
