import { hc } from "hono/client";
import type { AppType } from "@biu-cs-planner/server";

/**
 * The only way web reaches the domain. It knows the API contract and nothing else:
 * `AppType` is a type-only import, so no `core` or `app` code is ever bundled here.
 *
 * Same-origin in production; in development Vite proxies /api to the server.
 */
export const api = hc<AppType>("/");
