import { expect, it } from "vitest";
import { app } from "./app.ts";
import { CURRENT_SCHEMA_VERSION } from "@biu-cs-planner/core";

it("reports health without authentication", async () => {
  const response = await app.request("/api/health");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  });
});

it("404s an unknown route", async () => {
  const response = await app.request("/api/nope");

  expect(response.status).toBe(404);
});
