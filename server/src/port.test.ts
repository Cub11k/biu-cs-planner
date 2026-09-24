import { createServer } from "node:net";
import { expect, it } from "vitest";
import { onAFreePort } from "./port.ts";

/** What a listener rejects with when something else already holds the port. */
function addressInUse(): NodeJS.ErrnoException {
  return Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
}

it("uses the port it prefers when nothing holds it", async () => {
  const tried: number[] = [];

  const { port } = await onAFreePort(async (candidate) => {
    tried.push(candidate);
    return "listening";
  }, 8900);

  expect(port).toBe(8900);
  expect(tried).toEqual([8900]);
});

it("moves to the next free port when the preferred one is taken", async () => {
  const taken = new Set([8900, 8901]);

  const { port } = await onAFreePort(async (candidate) => {
    if (taken.has(candidate)) throw addressInUse();
    return candidate;
  }, 8900);

  // the caller compares this with the preferred port to tell the student it moved
  expect(port).toBe(8902);
});

it("gives up with one message instead of twenty when every port is taken", async () => {
  await expect(
    onAFreePort(async () => {
      throw addressInUse();
    }, 8900, 3),
  ).rejects.toThrow("8900 to 8902");
});

it("does not retry a failure that would repeat identically", async () => {
  let attempts = 0;
  const denied = Object.assign(new Error("listen EACCES"), { code: "EACCES" });

  await expect(
    onAFreePort(async () => {
      attempts += 1;
      throw denied;
    }, 8900),
  ).rejects.toThrow("EACCES");
  expect(attempts).toBe(1);
});

it("steps past a port a real socket is holding", async () => {
  const blocker = createServer();
  const busy = await new Promise<number>((settle) => {
    blocker.listen(0, "127.0.0.1", () => {
      const address = blocker.address();
      settle(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  try {
    const { listening, port } = await onAFreePort(
      (candidate) =>
        new Promise<ReturnType<typeof createServer>>((settle, fail) => {
          const server = createServer();
          server.once("error", fail);
          server.listen(candidate, "127.0.0.1", () => settle(server));
        }),
      busy,
    );

    expect(port).toBe(busy + 1);
    listening.close();
  } finally {
    blocker.close();
  }
});
