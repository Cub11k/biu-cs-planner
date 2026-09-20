import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

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
 * The browser project needs a Chromium on the machine, and `npm install` does not put one
 * there: `playwright@1.63` ships no install script at all, so nothing downloads a browser
 * unless something asks. `npm run install:browsers` asks. (Were a future version to bring
 * the postinstall back, `--ignore-scripts` would stop it, so this stays the way it is
 * rather than becoming implicit again.) Without a browser, `npm run test:node` runs the
 * whole node project and passes.
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
          // `.tsx` as well as `.ts`: the PR report lists the titles in every `*.test.ts?(x)`
          // it finds, so a `web/src/**/*.test.tsx` that no project ran would be reported as
          // a claim the suite proves. The browser project's files are the exception.
          include: ["{core,app,server,web}/src/**/*.test.ts?(x)", "tools/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.browser.test.tsx"],
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
            // be measuring a collapsed grid rather than the one a student sees. Wide
            // enough, too, that a tile's detail line does not wrap between its two clock
            // times, which is what the times assertion needs in order to mean anything.
            viewport: { width: 1920, height: 900 },
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
