import { Hono } from "hono";
import { CURRENT_SCHEMA_VERSION } from "@biu-cs-planner/core";

/**
 * The HTTP API exposes domain operations, never file paths.
 *
 * Only `/api/health` exists so far. Bearer-token auth, Host/Origin checks and the
 * JSON-only write rules from ADR-0004 arrive with their own ticket; health stays
 * unauthenticated so a launcher can probe a running instance.
 */
export const app = new Hono().get("/api/health", (c) =>
  c.json({ ok: true, schemaVersion: CURRENT_SCHEMA_VERSION } as const),
);

/** `web` imports this type only, never the runtime (docs/design.md, "Architecture"). */
export type AppType = typeof app;
