import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Two projects, because two different questions are being asked.
 *
 * `node` is everything that can answer without a browser: `core`, `app` and `server`, plus
 * the `web` modules that keep the browser at arm's length — they take what they need of it
 * as an argument, so a fake stands in. It needs nothing installed beyond `node_modules`.
 *
 * `browser` is the questions only an engine can answer: whether the week really reads
 * right to left, whether a time range survives a Hebrew line, whether the dark tokens
 * resolve, whether Chromium can draw Hebrew at all. `renderToStaticMarkup` returns a
 * string and jsdom has no layout engine, so neither can be asked there (issue #45).
 *
 * The browser project needs a Chromium on the machine, which `npm install` does not put
 * there: every install in this repository runs with `--ignore-scripts`, and Playwright's
 * browser download is a postinstall. `npm run install:browsers` is that download, made
 * explicit. Without one, `npm run test:node` runs the whole node project and passes.
 */
export default defineConfig({
  test: {
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
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["{core,app,server,web}/src/**/*.test.ts", "tools/**/*.test.ts"],
        },
      },
      {
        // The stylesheet is half of what is under test — a column's width, a sticky
        // corner and the dark tokens are all CSS — so the utilities are generated here
        // the way `web` generates them rather than left unresolved.
        plugins: [tailwindcss()],
        // Named up front rather than discovered mid-run: Vite reloads the page when it
        // optimizes a dependency it did not expect, and Vitest warns that a reload in the
        // middle of a test run is how flakes and duplicate runs happen. On a cold
        // node_modules/.vite -- which is every CI run -- that is exactly when it happens.
        optimizeDeps: { include: ["react", "react/jsx-dev-runtime", "react-dom/client"] },
        test: {
          name: "browser",
          include: ["web/src/**/*.browser.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            // A desk, not a phone: the default 414px viewport leaves a five-column week
            // about a hundred pixels to live in, and every geometry assertion would then
            // be measuring a collapsed grid rather than the one a student sees.
            viewport: { width: 1600, height: 900 },
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
