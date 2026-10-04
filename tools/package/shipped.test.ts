import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENTRY, bundleIn, stagePackage } from "./stage.ts";

const run = promisify(execFile);

/** The repository root. */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** `web/`, which is the Vite project root. */
const WEB = join(ROOT, "web");

/**
 * The document a student actually opens (#211).
 *
 * Three files claim to be "the entry document" and only two of them were ever read.
 * `web/index.html` is the build's **input**, which `web/src/scheme.test.ts` scans as source
 * and `web/src/scheme.browser.test.tsx` loads with `?raw`. `server/src/ui.test.ts` builds
 * that input and asserts on the **output** `serveBuiltUi` hands a browser (#169, #194). What
 * an install serves is neither: it is `dist/ui/index.html`, which `builtUiRoot()` points at
 * and which this folder's copy step puts there.
 *
 * **What already looked at it, and how far that went.** release.yml installs the tarball,
 * starts the binary and greps the served page for `id="root"`; it also lists every path in
 * the tarball and rejects a `.test.` or a `.ts` among them. So the file was not quite
 * untested — but one `grep` for one attribute is all of it, nothing reads the file itself,
 * and it runs only on a packaging pull request or a tag. A copy step is exactly where a file
 * arrives truncated, stale, or not at all, and `id="root"` is in the first 40 bytes of the
 * body: a document cut off after `<head>` still fails, a document cut off after it does not.
 *
 * **It packs rather than reading `dist/ui` off the tree**, for the reason #194 gave for
 * building rather than reading `web/dist`: a tree's `dist/` may be absent, in which case a
 * test that reads it either skips or asserts against nothing, and it may be *stale*, which is
 * worse — the copy step deleted while an older `dist/ui` still holds a good document is the
 * regression this test exists for, and a reader of the tree would sail through it. So the
 * build, the copy and the pack all happen here, in throwaway folders, and the bytes come back
 * out of the tarball npm produced.
 *
 * **What it proves, and what it leaves to #169.** The claim is that what was packed is what
 * was built, whole — not that what was built is right. The stamp is required to be present
 * because equality alone would be satisfied by two blanks agreeing: a build that emitted an
 * empty document, faithfully copied, passes a byte comparison. Where the stamp sits, whether
 * it blocks and whether it runs before the module are `server/src/ui.test.ts`'s assertions
 * and are not repeated here.
 *
 * **It drives `web`'s build toolchain**, dynamically and for the same reasons
 * `server/src/ui.test.ts` does — see the ruling on #210 in `tools/pr-review/layering.ts`,
 * which says a test may and a shipped module may not. `tools/` is not a workspace and has no
 * `package.json` to declare `vite` in, which is part of why that ruling had to be a sentence
 * about a kind of file rather than a dependency added somewhere.
 */
describe("the document the package ships", () => {
  /** Every file in the tarball, by its path inside it, `package/` prefix included. */
  let packed: Map<string, Buffer>;
  /** The built document, as it was before the copy step touched it. */
  let built: string;
  /** `web/index.html`, the build's input, which the two required literals come out of. */
  let source: string;

  let build: string;
  let stage: string;

  beforeAll(async () => {
    build = await mkdtemp(join(tmpdir(), "biu-pack-build-"));
    stage = await mkdtemp(join(tmpdir(), "biu-pack-stage-"));

    // Vite's own API, reading the same `web/vite.config.ts`, into a folder of its own: the
    // suite neither depends on nor disturbs whatever is already built in the tree.
    const vite = await import("vite");
    await vite.build({ root: WEB, logLevel: "warn", build: { outDir: build, emptyOutDir: true } });
    built = await readFile(join(build, ENTRY), "utf8");
    source = await readFile(join(WEB, ENTRY), "utf8");

    // The staging root needs the real `package.json`, because `files` in it is what decides
    // whether `dist/ui` reaches the tarball at all — a copy step that worked and a `files`
    // list that stopped naming `dist` are the same failure to a student. README and LICENSE
    // are left out: npm includes what is there, and neither of them is part of this claim.
    await copyFile(join(ROOT, "package.json"), join(stage, "package.json"));

    // A stand-in for the bundle, which `stagePackage` requires and makes executable. Its
    // contents are `server`'s build and are no part of what is asserted below; what matters
    // is that the copy step runs with both halves present, the way `npm run build` runs it.
    await mkdir(join(stage, "dist"), { recursive: true });
    await writeFile(bundleIn(stage), "#!/usr/bin/env node\n");

    // The real copy step, not a re-implementation of it.
    await stagePackage({ root: stage, builtUi: build });

    // A decoy outside `dist`, so that "nothing but the package" below is a claim which can
    // fail. Without it the staging root holds only `package.json` and `dist/`, and there is
    // nothing available to stray — the assertion would pass whatever `files` said. This is
    // the small version of release.yml's stowaway grep, which makes the same claim over the
    // real tree and is still the one that matters.
    await writeFile(join(stage, "not-the-package.ts"), "export const stowaway = 1;\n");

    const { stdout } = await run(npm(), ["pack", "--ignore-scripts", "--json"], { cwd: stage });
    packed = unpack(await readFile(join(stage, tarballFrom(stdout))));
  }, 180_000);

  afterAll(async () => {
    await rm(build, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  });

  /** A path inside `dist/ui`, spelled the way a package tarball spells it. */
  const shipped = (...parts: string[]): string => ["package", "dist", "ui", ...parts].join("/");

  /** The packed entry document, as text. */
  const packedEntry = (): string => packed.get(shipped(ENTRY))?.toString("utf8") ?? "";

  it("is in the tarball, where builtUiRoot will look for it", () => {
    // Named rather than searched for: `dist/ui/index.html` beside `dist/cli.js` is what
    // `server/src/ui.ts` resolves, so a document packed anywhere else is a 404 to a student.
    expect([...packed.keys()]).toContain(shipped(ENTRY));
    expect([...packed.keys()]).toContain("package/dist/cli.js");
  });

  it("is the document the build produced, byte for byte", () => {
    // The whole of the copy step's claim. A truncated copy, a stale one, or no copy at all is
    // this line going red, and nothing else in the repository reads these bytes.
    expect(packedEntry()).toBe(built);
  });

  it("carries the blocking scheme stamp a student loads before first paint", () => {
    // The key and the attribute name, taken out of `web/index.html` rather than spelled here
    // — `web/src/scheme.test.ts` is what ties those two literals to what `scheme.ts` exports,
    // and #194 requires the same two of the built document for the same reason. Required of
    // the *packed* bytes, so the comparison above cannot be two blanks agreeing.
    const literals = stampLiterals(source);
    expect(literals).toHaveLength(2);
    for (const literal of literals) expect(packedEntry()).toContain(literal);

    expect(packedEntry()).toContain("localStorage.getItem(");
    expect(packedEntry()).toContain("setAttribute(");
  });

  it("ships every asset that document names, not only the document", () => {
    // A copy step that copied one file would pass every assertion above and leave a student
    // with a page that loads nothing. Every `/assets/` reference rather than the module
    // script alone: the build emits a stylesheet `<link>` as well, and the palette that
    // `data-theme` selects is in it, so a page that found its script and not its stylesheet
    // would be the scheme bug #146 fixed, wearing a different hat.
    const referenced = [
      ...packedEntry().matchAll(/(?:src|href)="(\/assets\/[^"]*)"/g),
    ].map((found) => found[1] ?? "");

    expect(referenced.length).toBeGreaterThan(0);
    for (const asset of referenced) {
      expect([...packed.keys()]).toContain(shipped("assets", asset.slice("/assets/".length)));
    }

    // Hashed names, and no `/src/main.tsx` anywhere: that is what says these bytes came out
    // of a build rather than being the source document copied by mistake.
    expect(referenced.some((asset) => asset.endsWith(".js"))).toBe(true);
    expect(packedEntry()).not.toContain("/src/main.tsx");
  });

  it("leaves the decoy beside it out, because files is still an allowlist", () => {
    // `not-the-package.ts` is in the root this was packed from and must not be in the
    // tarball. `files` naming `dist`, `README.md` and `LICENSE` is what keeps it out, and a
    // `files` that had stopped being an allowlist is what would let it in.
    const strays = [...packed.keys()].filter(
      (path) => !path.startsWith("package/dist/") && path !== "package/package.json",
    );
    expect(strays).toEqual([]);
  });
});

/** `npm`, by the name this platform starts it under. */
const npm = (): string => (process.platform === "win32" ? "npm.cmd" : "npm");

/** The tarball `npm pack --json` says it wrote. */
function tarballFrom(stdout: string): string {
  const reported: unknown = JSON.parse(stdout);
  const first = Array.isArray(reported) ? (reported[0] as { filename?: unknown }) : undefined;
  if (typeof first?.filename !== "string") throw new Error(`npm pack named no tarball: ${stdout}`);
  return first.filename;
}

/**
 * The string literals in a document's one inline script — the store key and the attribute
 * name, in `web/index.html`'s case. Taken out of the source rather than written down, so the
 * two cannot drift apart; `server/src/ui.test.ts` reads them the same way.
 */
function stampLiterals(html: string): string[] {
  const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(
    (found) => !(found[1] ?? "").includes("src"),
  );
  if (inline.length !== 1) throw new Error(`expected one inline script, found ${inline.length}`);
  return (inline[0]?.[2] ?? "").match(/"[^"]*"/g) ?? [];
}

/**
 * The files in a gzipped tarball, by their path inside it.
 *
 * A tar is 512-byte headers, each followed by its file's bytes padded to 512. Read here
 * rather than shelled out to: `tar` is a different program on every platform, and a test that
 * opens the package should not depend on which one is installed. Only regular files are kept,
 * which is all npm puts in a package tarball.
 *
 * **ustar only**, which is as far as this needs to go: a name is the `name` field, or the
 * `prefix` field joined to it, which together carry about 255 characters — and the paths in
 * question are `package/dist/ui/assets/index-<8 chars>.js`. A PAX or GNU long-name extension
 * header would be skipped here as a non-regular entry; nothing npm packs for this package
 * produces one.
 */
function unpack(tarball: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tarball);
  const files = new Map<string, Buffer>();

  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    const name = field(header.subarray(0, 100));
    // Two zero-filled blocks end an archive, and the first of them is enough to stop at.
    if (name === "") break;
    const prefix = field(header.subarray(345, 500));
    const size = Number.parseInt(field(header.subarray(124, 136)).trim(), 8);
    // Said out loud rather than ending the walk: `NaN` makes the loop condition false, so a
    // corrupt archive would otherwise read as a short one and fail as a missing file.
    if (!Number.isFinite(size)) throw new Error(`unreadable size on ${name} in the tarball`);
    const kind = field(header.subarray(156, 157));

    at += 512;
    if (kind === "0" || kind === "") {
      files.set(prefix === "" ? name : `${prefix}/${name}`, tar.subarray(at, at + size));
    }
    at += Math.ceil(size / 512) * 512;
  }

  return files;
}

/** One NUL-padded header field as the string it holds. */
function field(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}
