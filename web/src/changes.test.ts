import { expect, it } from "vitest";
import { createApiClient } from "./api.ts";
import {
  DEFAULT_EVERY_MS,
  pollWorkspaceChanges,
  workspaceChangePoll,
  type Repeat,
} from "./changes.ts";

const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

/**
 * Stands in for the server: answers the change count with whatever the test last set,
 * and records every ask. The real typed client is used, not a fake of it — the route path
 * and the response shape are half of what is being asserted.
 */
function servingRevision() {
  const asked: string[] = [];
  let changeCount = 0;
  let answer: () => Response = () => Response.json({ changeCount });

  const fetchImpl = (async (input: RequestInfo | URL) => {
    asked.push(new URL(String(input), "http://localhost:8900").pathname);
    return answer();
  }) as typeof fetch;

  return {
    asked,
    client: createApiClient(() => TOKEN, fetchImpl),
    moveTo: (next: number) => {
      changeCount = next;
    },
    failWith: (status: number) => {
      answer = () => new Response("no", { status });
    },
    refuseToAnswer: () => {
      answer = () => {
        throw new Error("the server is not running");
      };
    },
  };
}

/** Lets a started ask finish. One microtask is not enough: an ask awaits twice. */
const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** A manual clock: `tick()` runs the poll the way the interval would. */
function manualRepeat(): { repeat: Repeat; tick: () => void; running: () => boolean } {
  let pending: (() => void) | undefined;
  return {
    repeat: (poll) => {
      pending = poll;
      return () => {
        pending = undefined;
      };
    },
    tick: () => pending?.(),
    running: () => pending !== undefined,
  };
}

it("asks the API for the Workspace's change count, and nothing else", async () => {
  const server = servingRevision();
  const poll = workspaceChangePoll(server.client, () => {});

  await poll();

  expect(server.asked).toEqual(["/api/workspace/changes"]);
});

/** The first answer is the baseline: opening a page is not an external change. */
it("reports nothing on the first answer, whatever the count says", async () => {
  const server = servingRevision();
  server.moveTo(9);
  let changed = 0;
  const poll = workspaceChangePoll(server.client, () => (changed += 1));

  await poll();

  expect(changed).toBe(0);
});

it("reports a change once the count moves", async () => {
  const server = servingRevision();
  let changed = 0;
  const poll = workspaceChangePoll(server.client, () => (changed += 1));

  await poll();
  server.moveTo(1);
  await poll();

  expect(changed).toBe(1);
});

/** A count that has not moved is the ordinary case, and the quiet one. */
it("reports nothing while the count stays where it was", async () => {
  const server = servingRevision();
  let changed = 0;
  const poll = workspaceChangePoll(server.client, () => (changed += 1));

  await poll();
  await poll();
  await poll();

  expect(changed).toBe(0);
});

it("reports each further movement separately", async () => {
  const server = servingRevision();
  let changed = 0;
  const poll = workspaceChangePoll(server.client, () => (changed += 1));

  await poll();
  server.moveTo(1);
  await poll();
  server.moveTo(2);
  await poll();

  expect(changed).toBe(2);
});

/**
 * The server restarting sets the count back to 0, which is a movement and reloads the
 * page — which is right: a server that restarted may be looking at a different Workspace.
 */
it("treats the count going backwards as a change, not as nothing", async () => {
  const server = servingRevision();
  server.moveTo(7);
  let changed = 0;
  const poll = workspaceChangePoll(server.client, () => (changed += 1));

  await poll();
  server.moveTo(0);
  await poll();

  expect(changed).toBe(1);
});

/** A page with no launch token is refused, and a refusal is not news about the folder. */
it("reports nothing when the API refuses the ask", async () => {
  const server = servingRevision();
  let changed = 0;
  const poll = workspaceChangePoll(server.client, () => (changed += 1));

  await poll();
  server.failWith(401);
  await poll();
  await poll();

  expect(changed).toBe(0);
});

/** The server not being there is not a change either, and never an unhandled rejection. */
it("survives the server not answering at all", async () => {
  const server = servingRevision();
  let changed = 0;
  const poll = workspaceChangePoll(server.client, () => (changed += 1));

  server.refuseToAnswer();
  await expect(poll()).resolves.toBeUndefined();

  expect(changed).toBe(0);
});

/**
 * The baseline is taken as the page loads, not one interval later: a file that changes in
 * that first interval would otherwise be read into the baseline and never reported.
 */
it("asks once immediately, then once per tick, and stops when stopped", async () => {
  const server = servingRevision();
  const clock = manualRepeat();

  const stop = pollWorkspaceChanges(server.client, () => {}, { repeat: clock.repeat });
  await settled();

  expect(server.asked).toEqual(["/api/workspace/changes"]);

  clock.tick();
  await settled();

  expect(server.asked).toHaveLength(2);
  expect(clock.running()).toBe(true);

  stop();
  stop(); // stopping twice is a no-op, not a crash

  expect(clock.running()).toBe(false);
});

/**
 * The default repeating, through a real interval — the arrangement that actually ships, and
 * the one every test above replaces. `everyMs` is turned right down so this is the only
 * test here that waits at all, and it waits for milliseconds.
 */
it("keeps asking on its own clock when no repeat is given", async () => {
  const server = servingRevision();
  let changed = 0;
  const stop = pollWorkspaceChanges(server.client, () => (changed += 1), { everyMs: 5 });

  await new Promise((settle) => setTimeout(settle, 60));

  const askedWhileQuiet = server.asked.length;
  server.moveTo(1);
  await new Promise((settle) => setTimeout(settle, 60));
  stop();
  const askedAltogether = server.asked.length;

  expect(askedWhileQuiet).toBeGreaterThan(0);
  expect(changed).toBe(1);

  // and stopping really stops: no further ask arrives after it
  await new Promise((settle) => setTimeout(settle, 40));
  expect(server.asked.length).toBe(askedAltogether);
});

/** A value, not a guess: the interval is part of what the design promises. */
it("asks every two seconds by default", () => {
  expect(DEFAULT_EVERY_MS).toBe(2000);
});

/**
 * Stopping silences an answer that is already on its way. Without this, a poll in flight
 * when the page moves on would report a change to something that is no longer there.
 */
it("reports nothing from an ask that was already in flight when it stopped", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let count = 0;
  const fetchImpl = (async () => {
    // the first ask answers at once, so the poller has a baseline; the second is held
    if (count++ === 0) return Response.json({ changeCount: 0 });
    await held;
    return Response.json({ changeCount: 1 });
  }) as typeof fetch;

  const clock = manualRepeat();
  let changed = 0;
  const stop = pollWorkspaceChanges(createApiClient(() => TOKEN, fetchImpl), () => (changed += 1), {
    repeat: clock.repeat,
  });
  await settled();
  clock.tick(); // this ask is now waiting on `held`

  stop();
  release?.();
  await settled();

  expect(count).toBe(2); // the held ask really did answer
  expect(changed).toBe(0); // and reported nothing, because the poller had stopped
});
