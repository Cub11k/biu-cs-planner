import { defineConfig } from "vitest/config";

// `core`, `app` and `server` run in Node. `web` gets its own jsdom project once
// there are components worth testing; see docs/design.md, "Development".
export default defineConfig({
  test: {
    environment: "node",
    include: ["{core,app,server}/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // json-summary feeds the PR report; text is for a human running it locally.
      // "json" carries per-function hit counts, which is how the report names
      // the functions the tests never executed.
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "coverage",
      include: ["{core,app,server}/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/__fixtures__/**"],
    },
  },
});
