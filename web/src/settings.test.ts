import { expect, it } from "vitest";
import { createApiClient } from "./api.ts";
import { fetchSettings, saveSettings } from "./settings.ts";

/**
 * The half of the settings that lives in `web`: what the typed client actually sends to the two
 * routes #115 added, and what it makes of every answer they can give.
 *
 * No browser and no React here — the hook, the switch and the document flipping to `rtl` are
 * `settings.browser.test.tsx`, because what those are about is a click, an effect and the DOM.
 * This file is about the contract, which is why it can be asked without one.
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

const served = (over: Record<string, unknown> = {}): Response =>
  Response.json({
    language: "en",
    examSpacingDays: 3,
    version: VERSION,
    warnings: [],
    ...over,
  });

it("asks for the preferences at /api/settings, with the launch token", async () => {
  const { sent, api } = client(() => served({ language: "he", examSpacingDays: 5 }));

  const result = await fetchSettings(api);

  expect(new URL(sent[0]!.url).pathname).toBe("/api/settings");
  expect(sent[0]!.method).toBe("GET");
  expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  expect(result).toEqual({
    kind: "served",
    language: "he",
    examSpacingDays: 5,
    version: VERSION,
    warnings: [],
  });
});

/**
 * The Warning `core` has always raised, arriving where a component can show it. Until #115 there
 * was no route to carry it and nothing above `core` that could have.
 */
it("carries the settings-unreadable Warning the answer came with", async () => {
  const { api } = client(() =>
    served({ warnings: [{ kind: "settings-unreadable", field: "examSpacingDays" }] }),
  );

  const result = await fetchSettings(api);

  expect(result).toMatchObject({
    kind: "served",
    warnings: [{ kind: "settings-unreadable", field: "examSpacingDays" }],
  });
});

/**
 * A language this build has no strings for is read as *never told* rather than crashing `t()` or
 * being turned into English. `./scheme.ts` gives every way of not knowing that same one answer, and
 * the caller keeps what is on screen — the file holds a language, and this page not knowing the
 * word for it is not the student having chosen English.
 */
it("says nothing about the language when the answer names one it cannot render", async () => {
  const { api } = client(() => served({ language: "fr" }));

  const result = await fetchSettings(api);

  expect(result).toMatchObject({ kind: "served", language: undefined, examSpacingDays: 3 });
});

it("patches the change to /api/settings, carrying the revision it is based on", async () => {
  const { sent, api } = client(() => served({ language: "he", version: NEXT_VERSION }));

  const result = await saveSettings(api, { language: "he" }, VERSION);

  expect(new URL(sent[0]!.url).pathname).toBe("/api/settings");
  expect(sent[0]!.method).toBe("PATCH");
  await expect(sent[0]!.json()).resolves.toEqual({ language: "he", basedOn: VERSION });
  expect(result).toMatchObject({ kind: "served", language: "he", version: NEXT_VERSION });
});

/**
 * A change names the preferences it means to change and nothing else. A body that carried both
 * would reset the one the student was not changing — which is why the route is a PATCH and why
 * `basedOn` is the only thing added here.
 */
it("sends only the preference it was asked to change", async () => {
  const { sent, api } = client(() => served());

  await saveSettings(api, { examSpacingDays: 10 }, VERSION);

  await expect(sent[0]!.json()).resolves.toEqual({ examSpacingDays: 10, basedOn: VERSION });
});

it("sends an absent revision as an absent field, which is the claim that there is no file", async () => {
  const { sent, api } = client(() => served());

  await saveSettings(api, { language: "he" }, undefined);

  // JSON has no `undefined`, and a `null` synonym would be a second way to say one thing
  await expect(sent[0]!.json()).resolves.toEqual({ language: "he" });
});

/**
 * **A preference change can be refused**, which is the consequence of keeping a preference in a
 * guarded document. Each reason comes back named so the screen can say something true about it.
 */
it.each([
  "state-file-changed",
  "state-file-unreadable",
  "workspace-not-ready",
  "workspace-refused",
] as const)("reads a %s refusal as the reason it is", async (reason) => {
  const { api } = client(() => refusal({ reason, warnings: [] }));

  expect(await saveSettings(api, { language: "he" }, VERSION)).toEqual({
    kind: "refused",
    reason,
    warnings: [],
  });
});

it("reads a refusal that names no reason as a refusal, rather than inventing one", async () => {
  const { api } = client(() => new Response("{}", { status: 400 }));

  expect(await saveSettings(api, { language: "he" }, VERSION)).toEqual({
    kind: "refused",
    reason: undefined,
    warnings: [],
  });
});

/** The guard answers before the route does, so 401 is not one of the route's own answers. */
it("reads a 401 as this page having no launch token", async () => {
  const { api } = client(() => new Response("", { status: 401 }));

  expect(await fetchSettings(api)).toEqual({ kind: "unauthorized" });
  expect(await saveSettings(api, { language: "he" }, VERSION)).toEqual({ kind: "unauthorized" });
});

/**
 * Only the request failing is the server not being there. An answer this module cannot make sense
 * of is a contract problem, and calling it "unreachable" would send the student to look at a
 * server that answered them — which is why the answer is read outside the catch.
 */
it("reads a request that never arrived as the server not being there", async () => {
  const { api } = client(() => Promise.reject(new Error("no server")));

  expect(await fetchSettings(api)).toEqual({ kind: "unreachable" });
  expect(await saveSettings(api, { language: "he" }, VERSION)).toEqual({ kind: "unreachable" });
});

/**
 * A response whose body is not JSON, which is **not** a hypothetical contract problem.
 *
 * In development `web/vite.config.ts` proxies `/api` to the server, and Vite answers with an HTML
 * 500 page when the target refuses the connection — so "the server is not running" arrives as a
 * response with an unparseable body rather than as a failed request. An unmatched `/api/...` path
 * is hono's plain-text 404 (`server/src/ui.ts`), which a bundle newer than its server produces.
 *
 * It used to make both functions **reject**, which escaped both callers in `useSettings`: `saving`
 * was never cleared and the language switch stayed disabled and silent for the life of the page.
 */
it.each([
  { what: "an HTML error page, as Vite's proxy answers with", body: "<h1>500</h1>", status: 500 },
  { what: "hono's plain-text 404", body: "Not Found", status: 404 },
  { what: "hono's plain-text 500", body: "Internal Server Error", status: 500 },
  { what: "a 200 whose body is not JSON at all", body: "<html>", status: 200 },
])("reads $what as an answer with nothing to go on, rather than rejecting", async (answer) => {
  const { api } = client(
    () => new Response(answer.body, { status: answer.status, headers: { "content-type": "text/html" } }),
  );

  // resolves, and resolves to the floor: nothing here to act on, and no cause invented
  await expect(fetchSettings(api)).resolves.toEqual({
    kind: "refused",
    reason: undefined,
    warnings: [],
  });
  await expect(saveSettings(api, { language: "he" }, VERSION)).resolves.toEqual({
    kind: "refused",
    reason: undefined,
    warnings: [],
  });
});

/** A 401 is still the guard's, read before the body is touched at all. */
it("reads a 401 with an unparseable body as this page having no launch token", async () => {
  const { api } = client(() => new Response("<h1>401</h1>", { status: 401 }));

  expect(await fetchSettings(api)).toEqual({ kind: "unauthorized" });
});
