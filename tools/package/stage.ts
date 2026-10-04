import { chmod, cp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The last step of `npm run build`, as a function rather than a script.
 *
 * It puts the two things the published package runs on next to each other in one folder:
 *
 *   dist/cli.js   the whole server, bundled by esbuild — the `bin` entry
 *   dist/ui/      the built UI, as Vite emitted it
 *
 * `files` in package.json then names `dist` and nothing else, which is what keeps source,
 * tests and fixtures out of the tarball. Building into one folder rather than publishing
 * `server/dist` and `web/dist` separately is why that list can stay a single line.
 *
 * **Why it takes its roots as arguments instead of reading them off `import.meta.url`.**
 * `tools/package/shipped.test.ts` runs this copy for real and then packs the result, which
 * is the only way to open the document a student installs rather than the one the build
 * emitted (#211). It cannot do that against the repository itself: packing the tree would
 * need a full `npm run build` first and would overwrite whatever is already in `dist/`.
 * `main.ts` passes the repository's own paths, so `npm run build` is unchanged.
 */
export type Staging = {
  /** The package root to build into — the repository, or a staging copy of it. */
  root: string;
  /** The built UI to copy in: `web/dist` for a real build. */
  builtUi: string;
};

/** The entry document, without which the bundle would serve a 404 to every visitor. */
export const ENTRY = "index.html";

/** The bundled server, which `bin` in package.json points at. */
export const bundleIn = (root: string): string => join(root, "dist", "cli.js");

/** Where the built UI has to be for `builtUiRoot()` in `server/src/ui.ts` to find it. */
export const shippedUiIn = (root: string): string => join(root, "dist", "ui");

/** Stages the package, and answers with what `dist/ui/` ended up holding. */
export async function stagePackage({ root, builtUi }: Staging): Promise<string[]> {
  const bundle = bundleIn(root);
  const shippedUi = shippedUiIn(root);

  await requireFile(bundle, root, "npm run build --workspace server");
  await requireFile(join(builtUi, ENTRY), root, "npm run build --workspace web");

  // replaced rather than merged: a stale asset from an earlier build would otherwise
  // ride along in the tarball forever, since every name carries its own content hash
  await rm(shippedUi, { recursive: true, force: true });
  await cp(builtUi, shippedUi, { recursive: true });

  // npm makes a bin entry executable when it links it, but a tarball unpacked by hand
  // or run straight out of dist/ should work too
  await chmod(bundle, 0o755);

  return readdir(shippedUi);
}

async function requireFile(path: string, root: string, howToMakeIt: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    throw new Error(`Missing ${path.slice(root.length)} — run \`${howToMakeIt}\` first.`);
  }
}
