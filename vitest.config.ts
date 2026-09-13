import { defineConfig } from "vitest/config";

// `core`, `app` and `server` run in Node. `web` gets its own jsdom project once
// there are components worth testing; see docs/design.md, "Development".
export default defineConfig({
  test: {
    environment: "node",
    include: ["{core,app,server}/src/**/*.test.ts"],
  },
});
