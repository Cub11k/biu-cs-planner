import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { builtUiRoot, serveBuiltUi } from "./ui.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "biu-ui-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><div id=root></div>");
  await writeFile(join(root, "assets", "index-abc.js"), "export const app = 1;\n");
  await writeFile(join(root, "assets", "index-abc.css"), ":root{--ground:white}\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ui() {
  return new Hono().get("*", serveBuiltUi(root));
}

async function get(path: string, app = ui()): Promise<Response> {
  return app.request(`http://localhost:8900${path}`);
}

it("serves the entry document at the root", async () => {
  const response = await get("/");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toContain('id=root');
});

it("serves a hashed asset with its own type, cached forever", async () => {
  const response = await get("/assets/index-abc.js");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
  // the name carries a content hash, so this file can never be the stale one
  expect(response.headers.get("Cache-Control")).toContain("immutable");
});

it("makes the browser re-read the entry document, which names the hashed assets", async () => {
  expect((await get("/")).headers.get("Cache-Control")).toBe("no-cache");
});

it("sends the entry document for a deep link, so a reload reaches the app", async () => {
  const response = await get("/timetable/2027");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
});

it("keeps a missing asset a 404 rather than answering a script with HTML", async () => {
  // HTML in place of a script is a syntax error in the console instead of a plain miss
  expect((await get("/assets/gone-123.js")).status).toBe(404);
});

it("leaves /api to the API even where the API has no route", async () => {
  const app = new Hono()
    .get("/api/health", (c) => c.json({ ok: true }))
    .get("*", serveBuiltUi(root));

  expect((await get("/api/health", app)).status).toBe(200);
  expect((await get("/api/nothing-here", app)).status).toBe(404);
});

it.each([
  "/../../../etc/passwd",
  "/assets/../../secret",
  "/%2e%2e%2f%2e%2e%2fetc/passwd",
  "/%2e%2e/%2e%2e/etc/passwd",
])("refuses to read %s from outside the built UI", async (path) => {
  const outside = join(root, "..", "secret");
  await writeFile(outside, "not yours");
  try {
    const response = await get(path);

    expect(await response.text()).not.toContain("not yours");
  } finally {
    await rm(outside, { force: true });
  }
});

it("tells the browser not to guess a type and not to frame the page", async () => {
  const response = await get("/assets/index-abc.css");

  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
});

it("answers 404 when the UI was never built, instead of failing to start", async () => {
  const empty = await mkdtemp(join(tmpdir(), "biu-ui-empty-"));
  try {
    const app = new Hono().get("*", serveBuiltUi(empty));

    expect((await get("/", app)).status).toBe(404);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

it("looks for the built UI beside the bundle, not beside the Workspace", () => {
  // `dist/cli.js` and `dist/ui/` are siblings, and the student's current directory —
  // which is the Workspace — must never be what decides which files are served
  expect(builtUiRoot().endsWith(`${sep}ui`)).toBe(true);
  expect(builtUiRoot()).not.toBe(join(process.cwd(), "ui"));
});

/**
 * The entry document a student actually loads (#169).
 *
 * Every other test of the blocking scheme stamp reads **`web/index.html`**, the input to the
 * build: `web/src/scheme.test.ts` scans it as source and `web/src/scheme.browser.test.tsx`
 * loads it into an iframe with `?raw`. This serves **the build's output**, which is what
 * `serveBuiltUi` hands a browser. The gap between the two is total and silent: a Vite upgrade
 * that minified the document, hoisted its tags, or injected the module script somewhere else
 * would move the stamp after the module or drop it, every one of those tests would still pass,
 * and every student would see a flash of the scheme they did not choose on every load.
 *
 * **It lives here, in `server`, because the claim is about the document the server serves.**
 * `tools/package/` was the other candidate and it is the honest home for "the tarball has the
 * files in it" — it copies `web/dist` to `dist/ui` and checks nothing about their contents.
 * What is at stake here is not that a file was copied but that a *request for `/`* is answered
 * with a document whose first script is the stamp, so the assertion is made on a response from
 * `serveBuiltUi` and not on a file read off disk. That also covers the step `tools/package`
 * could not: this is the path a deep-link reload takes too.
 *
 * **And it builds rather than reading a build someone else made.** Reading `web/dist` would be
 * faster and would pass vacuously in two ways this project has been bitten by: absent, where a
 * test that skips reports green, and *stale*, which is worse — the stamp deleted from
 * `web/index.html` while an older `dist/` still carries it is exactly the regression this test
 * exists for, and a reader of `dist/` would sail through it. The build costs about a second,
 * which is the whole reason that trade is available.
 *
 * Nothing here imports `web`: `server` may not (`tools/pr-review/layering.ts`), and it does
 * not need to. The two names the stamp depends on are taken out of `web/index.html` itself and
 * required to survive into the output, and `web/src/scheme.test.ts` is what ties that file to
 * the constants `scheme.ts` exports.
 */
describe("the entry document the build produces", () => {
  /** The repository's `web/`, which is the Vite project root. */
  const WEB = fileURLToPath(new URL("../../web/", import.meta.url));

  let built: string;
  let served: string;

  beforeAll(async () => {
    built = await mkdtemp(join(tmpdir(), "biu-ui-build-"));
    // Vite's own API rather than a spawned `npm run build`: the same `web/vite.config.ts` is
    // read, and the output goes to a temporary folder instead of `web/dist`, so running the
    // suite neither depends on nor disturbs whatever is already built in the tree.
    //
    // `vite` is declared by `web` and not by `server`, and this resolves it through the npm
    // workspace's hoisted `node_modules` — which `vitest`, a root devDependency, also requires
    // as a peer, so a tree that can run this suite at all has it. Imported dynamically because
    // it is a test's build tool rather than anything `server` ships: a specifier at the top of
    // this file would read as `server` depending on Vite, and `erasableSyntaxOnly` keeps no
    // type-only shelter for a value import. If it ever stops resolving, this hook throws and
    // the block fails loudly rather than skipping.
    const { build } = await import("vite");
    await build({ root: WEB, logLevel: "warn", build: { outDir: built, emptyOutDir: true } });

    const response = await new Hono()
      .get("*", serveBuiltUi(built))
      .request("http://localhost:8900/");
    // A build that produced no entry document answers 404 here, which fails the whole block
    // rather than letting the assertions below read an empty string and agree with each other.
    expect(response.status).toBe(200);
    served = await response.text();
  }, 180_000);

  afterAll(async () => {
    await rm(built, { recursive: true, force: true });
  });

  /** Every `<script>` in a document, with its attributes and where it sits. */
  function scripts(html: string): { attributes: string; body: string; at: number }[] {
    return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map((found) => ({
      attributes: found[1] ?? "",
      body: found[2] ?? "",
      at: found.index ?? -1,
    }));
  }

  const inline = (html: string) => scripts(html).filter((one) => !one.attributes.includes("src"));
  const external = (html: string) => scripts(html).filter((one) => one.attributes.includes("src"));

  /** Whitespace is the build's to rearrange; what the stamp *says* is not. */
  const squashed = (source: string) => source.replace(/\s+/g, " ").trim();

  it("carries the one blocking stamp it was given, saying what it said", async () => {
    const source = inline(await readFile(join(WEB, "index.html"), "utf8"));
    expect(source).toHaveLength(1);

    const stamps = inline(served);
    expect(stamps).toHaveLength(1);
    const body = stamps[0]?.body ?? "";

    // It still reads the store and still writes an attribute. Asserted on the *output*, so
    // that the comparison below cannot be two blanks agreeing: a build that emitted an empty
    // script would satisfy an equality against a source that had also been emptied.
    expect(body).toContain("localStorage.getItem(");
    expect(body).toContain("setAttribute(");

    // The key and the attribute name, taken out of the source rather than spelled here —
    // `server` may not import `web`, and `web/src/scheme.test.ts` is what makes those two
    // literals the ones `scheme.ts` exports. They have to be in the output verbatim, because
    // an attribute the stylesheet does not key off is not a palette.
    const literals = source[0]?.body.match(/"[^"]*"/g) ?? [];
    expect(literals).toHaveLength(2);
    for (const literal of literals) expect(body).toContain(literal);

    // And the whole of it survived rather than a recognisable part. Equality modulo
    // whitespace, because re-indenting is a build's business and rewriting is not: should Vite
    // ever start minifying this script, this line is what asks someone to look.
    expect(squashed(body)).toBe(squashed(source[0]?.body ?? ""));
  });

  it("runs that stamp in <head>, ahead of the module the build emitted", async () => {
    const stamp = inline(served)[0];
    const modules = external(served);

    // Classic and blocking: no attributes at all, so not `type="module"` — which is deferred —
    // and carrying neither `defer` nor `async`. Any of the three and it runs after a paint,
    // which is the whole of what it is for and a change no palette assertion would notice.
    expect(stamp?.attributes.trim()).toBe("");

    expect(stamp?.at ?? -1).toBeGreaterThan(-1);
    expect(stamp?.at ?? -1).toBeLessThan(served.indexOf("</head>"));

    // The emitted module, and not `/src/main.tsx`: its `src` is a hashed asset that is in the
    // build. That is what says this document came out of a build at all — a test pointed at
    // the source file by mistake would pass every assertion above and fail here.
    expect(modules).toHaveLength(1);
    const src = /src="([^"]*)"/.exec(modules[0]?.attributes ?? "")?.[1] ?? "";
    expect(src).not.toBe("/src/main.tsx");
    expect(await readdir(join(built, "assets"))).toContain(src.replace("/assets/", ""));

    expect(stamp?.at ?? -1).toBeLessThan(modules[0]?.at ?? -1);
  });
});
