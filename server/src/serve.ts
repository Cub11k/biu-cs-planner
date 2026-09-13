import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { DEFAULT_PORT, LOOPBACK_HOST } from "./config.ts";

// Dev entry point. The real CLI entry (launch token, browser open, port fallback,
// single-instance lock) is its own ticket.
serve({ fetch: app.fetch, hostname: LOOPBACK_HOST, port: DEFAULT_PORT }, (info) => {
  console.log(`biu-cs-planner API on http://${LOOPBACK_HOST}:${info.port}`);
});
