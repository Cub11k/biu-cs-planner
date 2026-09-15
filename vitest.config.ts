import { defineConfig } from "vitest/config";

// `core`, `app` and `server` run in Node, and so do the `web` modules that keep the
// browser at arm's length — they take what they need of it as an argument, so a fake
// stands in. Components get their own jsdom project once there are some worth testing;
// see docs/design.md, "Development".
export default defineConfig({
  test: {
    environment: "node",
    include: ["{core,app,server,web}/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // json-summary feeds the PR report; text is for a human running it locally.
      // "json" carries per-function hit counts, which is how the report names
      // the functions the tests never executed.
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "coverage",
      // `.tsx` is left out: a component is not measured until it can be rendered.
      include: ["{core,app,server,web}/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/__fixtures__/**"],
    },
  },
});
