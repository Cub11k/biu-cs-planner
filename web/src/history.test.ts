import { expect, it } from "vitest";
import { createApiClient } from "./api.ts";
import { fetchAvailability, takeStep } from "./history.ts";

/**
 * The half of undo that lives in `web`: what the typed client actually sends to the three
 * routes #139 built, and what it makes of every answer they can give.
 *
 * No browser and no React here — the hook and the buttons are `history.browser.test.tsx`,
 * because what they are about is a click, an effect and a cascade. This file is about the
 * contract, which is why it can be asked without one.
 */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

/** A revision, in the shape the adapter produces: a SHA-256 of the file, as hex. */
const VERSION = "a".repeat(64);
const NEXT_VERSION = "b".repeat(64);

/** Stands in for the network, recording what the typed client actually sent. */
function client(answer: (request: Request) => Response | Promise<Response>) {
  const sent: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), "http://localhost:8900"), init);
    sent.push(request);
    return answer(request);
  }) as typeof fetch;
  return { sent, api: createApiClient(() => TOKEN, fetchImpl) };
}

const refusal = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 409,
    headers: { "content-type": "application/json" },
  });

it("asks whether undo and redo are available, with the launch token", async () => {
  const { sent, api } = client(() => Response.json({ canUndo: true, canRedo: false }));

  const available = await fetchAvailability(api);

  expect(new URL(sent[0]!.url).pathname).toBe("/api/history");
  expect(sent[0]!.method).toBe("GET");
  expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  expect(available).toEqual({ canUndo: true, canRedo: false });
});

it("says nothing about the buttons when the server does not answer that question", async () => {
  // Not `false`: a page that turned "nobody has said" into "neither is available" would be
  // making the server's claim for it. Both read as a disabled button; one of them is honest.
  const unreachable = client(() => Promise.reject(new Error("no server")));
  expect(await fetchAvailability(unreachable.api)).toBeUndefined();

  const unauthorized = client(() => new Response("", { status: 401 }));
  expect(await fetchAvailability(unauthorized.api)).toBeUndefined();

  const nonsense = client(() => Response.json({ offerings: [] }));
  expect(await fetchAvailability(nonsense.api)).toBeUndefined();

  // And the poll keeps its silence for a body that is not JSON at all, deliberately: this is
  // an ask and nobody pressed anything, so there is nothing the student is owed an account of
  // (#171's rule, kept by #206). The two steps below are acts and get one.
  //
  // **A 200, and the status is the whole of whether this assertion tests anything.** It was
  // written as a 500 and could not fail for the reason above it: `fetchAvailability` returns on
  // `!answer.ok` before `json()` is ever called, so a 500 exercises the same branch the 401 two
  // lines up already does and the body guard is never reached. Found by #209's reviewer, which
  // proved it by moving the body read outside the catch and watching all 23 tests here still pass.
  const unreadable = client(() => new Response("<h1>200</h1>", { status: 200 }));
  expect(await fetchAvailability(unreadable.api)).toBeUndefined();
});

it.each([
  { direction: "undo", path: "/api/history/undo" },
  { direction: "redo", path: "/api/history/redo" },
] as const)("posts a $direction to $path, carrying the revision on screen", async (step) => {
  const { sent, api } = client(() =>
    Response.json({
      label: "pick-group",
      at: 1_700_000_000_000,
      version: NEXT_VERSION,
      canUndo: false,
      canRedo: true,
      warnings: [],
    }),
  );

  const answer = await takeStep(api, step.direction, VERSION);

  expect(new URL(sent[0]!.url).pathname).toBe(step.path);
  expect(sent[0]!.method).toBe("POST");
  // An undo *is* a save and goes through the same external-edit guard (ADR-0013), so it says
  // what it was based on exactly as a Pick does.
  expect(await sent[0]!.json()).toEqual({ basedOn: VERSION });
  expect(answer).toEqual({
    kind: "moved",
    // the edit's own word for itself, which the UI translates — never shown as it arrives
    label: "pick-group",
    available: { canUndo: false, canRedo: true },
  });
});

it("takes the availability off a refusal too, so a wrong button corrects itself", async () => {
  // The server sends the flags with every answer for exactly this: a page that asked for an
  // undo it did not have can put its buttons right from the refusal rather than asking again.
  const { api } = client(() =>
    refusal({ reason: "nothing-to-undo", canUndo: false, canRedo: true, warnings: [] }),
  );

  const answer = await takeStep(api, "undo", VERSION);

  expect(answer).toEqual({
    kind: "refused",
    reason: "nothing-to-undo",
    warnings: [],
    available: { canUndo: false, canRedo: true },
  });
});

it.each([
  "nothing-to-undo",
  "nothing-to-redo",
  "state-file-missing",
  "history-invalidated",
  "state-file-changed",
  "state-file-unreadable",
  "workspace-refused",
  "workspace-not-ready",
  "backup-refused",
] as const)("carries the reason %s through unchanged", async (reason) => {
  const { api } = client(() => refusal({ reason, canUndo: true, canRedo: true, warnings: [] }));

  const answer = await takeStep(api, "undo", VERSION);

  // Named rather than mapped here: the sentence is the component's, and this module's job is
  // to hand the name over without flattening nine reasons into one.
  expect(answer).toEqual({
    kind: "refused",
    reason,
    warnings: [],
    available: { canUndo: true, canRedo: true },
  });
});

it("keeps the Warnings a refusal carried", async () => {
  const { api } = client(() =>
    refusal({
      reason: "state-file-unreadable",
      canUndo: true,
      canRedo: false,
      warnings: [{ kind: "file-unreadable" }],
    }),
  );

  const answer = await takeStep(api, "undo", VERSION);

  expect(answer.kind === "refused" && answer.warnings).toEqual([{ kind: "file-unreadable" }]);
});

it("names no reason and no availability for an answer neither shape fits", async () => {
  // The 400 on a malformed body: an answer the contract has and this module cannot provoke,
  // because it never sends one. It must not be read as a reason, and it must not be allowed
  // to claim anything about the two buttons.
  const { api } = client(
    () =>
      new Response(JSON.stringify({ error: "not-a-history-step" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );

  expect(await takeStep(api, "undo", VERSION)).toEqual({
    kind: "refused",
    reason: undefined,
    warnings: [],
    available: undefined,
  });
});

it("tells a page with no launch token from a server that is not there", async () => {
  // The guard answers before the route does, so 401 is not one of the route's own answers —
  // and the two ask the student for entirely different things (ADR-0004).
  const unauthorized = client(() => new Response("", { status: 401 }));
  expect(await takeStep(unauthorized.api, "undo", VERSION)).toEqual({ kind: "unauthorized" });

  const gone = client(() => Promise.reject(new TypeError("Failed to fetch")));
  expect(await takeStep(gone.api, "redo", VERSION)).toEqual({ kind: "unreachable" });
});

it("sends no revision when the page is showing a State File that does not exist", async () => {
  // `undefined` is the claim that there is no file, which the server fails closed on. It is
  // sendable, and the screen's job is not to send it (#111) — but the wrapper must not
  // quietly substitute something either.
  const { sent, api } = client(() =>
    refusal({ reason: "state-file-missing", canUndo: true, canRedo: false, warnings: [] }),
  );

  await takeStep(api, "undo", undefined);

  expect(await sent[0]!.json()).toEqual({});
});

/**
 * **An answer whose body is not JSON, which is the hole #206 is named for.** `history.ts` was
 * not in #171's census and read both of its bodies outside the catch, exactly as
 * `timetable/picks.ts` and `timetable/offerings.ts` did: an undo or a redo answered with one
 * **rejected**, the rejection escaped into `useHistory.step`, and the student read nothing.
 *
 * Not a hypothetical. In development `web/vite.config.ts` proxies `/api` to the server and Vite
 * answers an HTML 500 page when the target refuses the connection, so "the server is not
 * running" arrives as a response with an unparseable body rather than as a failed request; an
 * unmatched `/api/...` path is hono's plain-text 404, which a bundle newer than its server
 * produces.
 *
 * Both directions, because the only difference between them is the path.
 */
it.each([
  { what: "an HTML error page, as Vite's proxy answers with", body: "<h1>500</h1>", status: 500 },
  { what: "hono's plain-text 404", body: "Not Found", status: 404 },
  { what: "a 409 carrying no JSON refusal", body: "<html>", status: 409 },
  { what: "a 200 whose body is not JSON at all", body: "<html>", status: 200 },
])("reads $what as an answer it could not read, rather than rejecting", async (answer) => {
  const unreadable = (): Response =>
    new Response(answer.body, {
      status: answer.status,
      headers: { "content-type": "text/html" },
    });

  // resolves, and resolves to its own arm: not `refused`, which the screen says as a cause, and
  // not `unreachable`, which would send the student to look at a server that answered them
  await expect(takeStep(client(unreadable).api, "undo", VERSION)).resolves.toEqual({
    kind: "unreadable-answer",
  });
  await expect(takeStep(client(unreadable).api, "redo", VERSION)).resolves.toEqual({
    kind: "unreadable-answer",
  });
});

/**
 * The 200 said on its own, because it is the one that carries the trap: the step may perfectly
 * well have been taken. Nothing may be read off this answer — not a reason, not a label, and
 * above all not the two availability flags, which arrive in the body nobody could read.
 */
it("claims nothing at all off a 200 whose body it could not read", async () => {
  const { api } = client(() => new Response("<html>", { status: 200 }));

  const step = await takeStep(api, "undo", VERSION);

  expect(step).toEqual({ kind: "unreadable-answer" });
  expect("available" in step).toBe(false);
  expect("reason" in step).toBe(false);
});

/** A 401 is still the guard's, read before the body is touched at all. */
it("reads a 401 with an unparseable body as this page having no launch token", async () => {
  const { api } = client(() => new Response("<h1>401</h1>", { status: 401 }));

  expect(await takeStep(api, "undo", VERSION)).toEqual({ kind: "unauthorized" });
});

/**
 * A body of JSON `null`, served and refused (#230): `body.label` and `body.warnings` both threw
 * on it, outside any `try`, which is the silence #206 closed reached by another input.
 */
it.each([200, 409])("reads a %i whose body is null as unreadable", async (status) => {
  const { api } = client(() => Response.json(null, { status }));

  await expect(takeStep(api, "undo", VERSION)).resolves.toEqual({ kind: "unreadable-answer" });
});
