import { Hono } from "hono";
import { expect, it } from "vitest";
import { onlyTheLauncher } from "./guard.ts";

const TOKEN = "a-test-token-long-enough-to-look-like-one";

/** A stand-in for the real API: one read and one write, both behind the guard. */
const guarded = () => {
  const app = new Hono();
  app.use("/api/*", onlyTheLauncher({ token: TOKEN, openPaths: ["/api/health"] }));
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/thing", (c) => c.json({ read: true }));
  app.post("/api/thing", (c) => c.json({ wrote: true }));
  return app;
};

const bearer = { Authorization: `Bearer ${TOKEN}` };

const read = (headers: Record<string, string>, path = "/api/thing") =>
  guarded().request(`http://localhost:8900${path}`, { headers });

const write = (headers: Record<string, string>, body = "{}") =>
  guarded().request("http://localhost:8900/api/thing", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });

it("lets through a request that carries the token", async () => {
  const response = await read(bearer);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ read: true });
});

it("refuses a request with no token at all", async () => {
  const response = await read({});

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
});

it("refuses a request whose token is the wrong one", async () => {
  expect((await read({ Authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
  expect((await read({ Authorization: "Bearer " })).status).toBe(401);
  expect((await read({ Authorization: TOKEN })).status).toBe(401);
  expect((await read({ Authorization: `Basic ${TOKEN}` })).status).toBe(401);
});

it("compares tokens without leaking where they start to differ", async () => {
  // a prefix of the real token is no closer to getting in than an unrelated string
  expect((await read({ Authorization: `Bearer ${TOKEN.slice(0, -1)}` })).status).toBe(401);
});

it("leaves the health endpoint open, so a launcher can probe a running instance", async () => {
  const response = await read({}, "/api/health");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});

it("refuses a request whose Host is not localhost, whatever its token says", async () => {
  const response = await guarded().request("http://evil.example/api/thing", {
    headers: bearer,
  });

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: "host-not-localhost" });
});

it("checks Host on the open health endpoint too, so rebinding cannot probe for the app", async () => {
  const response = await guarded().request("http://evil.example/api/health");

  expect(response.status).toBe(403);
});

it("accepts the names loopback answers to, on any port", async () => {
  for (const host of ["localhost", "localhost:8900", "127.0.0.1:5173", "[::1]:8900"]) {
    const response = await guarded().request(`http://${host}/api/thing`, { headers: bearer });
    expect(response.status, host).toBe(200);
  }
});

it("refuses a host that merely ends in localhost", async () => {
  for (const host of ["notlocalhost", "localhost.evil.example", "127.0.0.1.evil.example"]) {
    const response = await guarded().request(`http://${host}/api/thing`, { headers: bearer });
    expect(response.status, host).toBe(403);
  }
});

it("reads the Host header in preference to the URL it was asked for", async () => {
  // this is the shape of a DNS rebinding request: loopback address, attacker's name
  const response = await guarded().request("http://127.0.0.1:8900/api/thing", {
    headers: { ...bearer, Host: "evil.example" },
  });

  expect(response.status).toBe(403);
});

it("refuses a write sent from another site, while letting its reads through", async () => {
  const cross = { Origin: "https://evil.example" };

  const wrote = await write({ ...bearer, ...cross });
  expect(wrote.status).toBe(403);
  await expect(wrote.json()).resolves.toEqual({ error: "cross-site" });

  // a read is not a change, and blocking it would break nothing an attacker can read anyway
  const got = await read({ ...bearer, ...cross });
  expect(got.status).toBe(200);
});

it("lets a write from the page itself through, whichever localhost port served it", async () => {
  for (const origin of ["http://localhost:8900", "http://127.0.0.1:5173"]) {
    const response = await write({ ...bearer, Origin: origin });
    expect(response.status, origin).toBe(200);
  }
});

it("lets through a write with no Origin at all, which is how a terminal client sends one", async () => {
  expect((await write(bearer)).status).toBe(200);
});

it("refuses a write whose body is not declared JSON", async () => {
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const response = await guarded().request("http://localhost:8900/api/thing", {
      method: "POST",
      headers: { ...bearer, "Content-Type": type },
      body: "{}",
    });
    expect(response.status, type).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "content-type-not-json" });
  }
});

it("refuses a write that declares no content type", async () => {
  const response = await guarded().request("http://localhost:8900/api/thing", {
    method: "POST",
    headers: bearer,
  });

  expect(response.status).toBe(415);
});

it("accepts a content type that carries a charset", async () => {
  const response = await write({ ...bearer, "Content-Type": "application/json; charset=utf-8" });

  expect(response.status).toBe(200);
});

it("checks the token on a write too, not only on a read", async () => {
  expect((await write({})).status).toBe(401);
});

it("refuses a write whose Origin is opaque, which is what a sandboxed frame sends", async () => {
  const response = await write({ ...bearer, Origin: "null" });

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: "cross-site" });
});

it("refuses a write whose Origin is localhost over https, which this server never is", async () => {
  // it is not the page this server handed out, whatever the hostname says
  expect((await write({ ...bearer, Origin: "https://localhost:8900" })).status).toBe(403);
});

it("treats every method that is not a read as a write", async () => {
  const app = new Hono();
  app.use("/api/*", onlyTheLauncher({ token: TOKEN }));
  app.all("/api/thing", (c) => c.json({ ok: true }));

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const crossSite = await app.request("http://localhost:8900/api/thing", {
      method,
      headers: { ...bearer, "Content-Type": "application/json", Origin: "https://evil.example" },
    });
    expect(crossSite.status, method).toBe(403);

    const form = await app.request("http://localhost:8900/api/thing", {
      method,
      headers: { ...bearer, "Content-Type": "text/plain" },
    });
    expect(form.status, method).toBe(415);
  }
});

it("makes a cross-site preflight fail, because it carries no token to offer", async () => {
  // a browser never attaches Authorization to a preflight, so OPTIONS is refused and
  // the request it was asking about is never sent
  const response = await guarded().request("http://localhost:8900/api/thing", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example" },
  });

  expect(response.status).toBe(401);
});

it("answers no CORS headers, so a refusal is not readable by the site that asked", async () => {
  const response = await read({ ...bearer, Origin: "https://evil.example" });

  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
});
