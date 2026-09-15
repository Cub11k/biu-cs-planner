import { chmod, cp, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * The last step of `npm run build`: it puts the two things the published package runs on
 * next to each other in one folder.
 *
 *   dist/cli.js   the whole server, bundled by esbuild — the `bin` entry
 *   dist/ui/      the built UI, as Vite emitted it
 *
 * `files` in package.json then names `dist` and nothing else, which is what keeps source,
 * tests and fixtures out of the tarball. Building into one folder rather than publishing
 * `server/dist` and `web/dist` separately is why that list can stay a single line.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));

const BUNDLE = join(root, "dist", "cli.js");
const BUILT_UI = join(root, "web", "dist");
const SHIPPED_UI = join(root, "dist", "ui");

/** The entry document, without which the bundle would serve a 404 to every visitor. */
const ENTRY = "index.html";

async function main(): Promise<void> {
  await requireFile(BUNDLE, "npm run build --workspace server");
  await requireFile(join(BUILT_UI, ENTRY), "npm run build --workspace web");

  // replaced rather than merged: a stale asset from an earlier build would otherwise
  // ride along in the tarball forever, since every name carries its own content hash
  await rm(SHIPPED_UI, { recursive: true, force: true });
  await cp(BUILT_UI, SHIPPED_UI, { recursive: true });

  // npm makes a bin entry executable when it links it, but a tarball unpacked by hand
  // or run straight out of dist/ should work too
  await chmod(BUNDLE, 0o755);

  const shipped = await readdir(SHIPPED_UI);
  console.log(`dist/cli.js and dist/ui/ (${shipped.length} entries) are ready to pack.`);
}

async function requireFile(path: string, howToMakeIt: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    throw new Error(`Missing ${path.slice(root.length)} — run \`${howToMakeIt}\` first.`);
  }
}

await main();
