# Domain logic behind an HTTP API; the UI stays thin

All domain logic lives in `core` (pure) and `app` (use cases), exposed by `server` over a Hono HTTP API. `web` talks only to that API through Hono's typed client and never imports `core` or `app`. We chose this over running the domain in the browser, because the author wants a clean, maintainable boundary more than zero-latency interactions, and a localhost round trip is fast enough even for live Clash detection while dragging.

## Consequences

- The domain can be tested and reused without any UI.
- The API contract comes from the shared Zod schemas, so there is no OpenAPI code generation step.
- If a future build must run without a server (e.g. a static site), `app` gets an in-process transport. The UI does not change.
