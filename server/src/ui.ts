import { readFile } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";

/**
 * The built UI, served off disk by the same server that serves the API — one origin, so
 * the `Origin` check on writes and the strict same-origin rules hold in the browser the
 * student actually uses (ADR-0002, ADR-0004).
 *
 * It is deliberately not part of `createApi`: `web` derives its typed client from that
 * app's type, and a catch-all route for files is not part of the API contract.
 *
 * No token is asked for here. The token arrives in the fragment of the URL the launcher
 * prints, and the page is what reads it — a page that could not load could never present
 * one. What the token protects is `/api/*`, which is where the Workspace is.
 */

/** Where the bundle keeps the built UI: `dist/cli.js` and `dist/ui/` are siblings. */
export function builtUiRoot(): string {
  return fileURLToPath(new URL("ui", import.meta.url));
}

const INDEX = "index.html";

/**
 * Only the types Vite emits, plus the fonts and images a UI grows into. An extension
 * that is not here is served as bytes, never guessed at — with `nosniff` below, an
 * unknown file is inert rather than whatever the browser would have made of it.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Sent with every file.
 *
 * `nosniff` stops a browser from deciding a file is something more interesting than its
 * declared type, and `frame-ancestors 'none'` keeps the planner out of anyone else's
 * page — the clickjacking half of the UI hardening in docs/design.md. The rest of that
 * strict CSP belongs with the screens it constrains, not here: `default-src 'self'`
 * also governs inline `style` attributes, which the agreed Timetable grid positions
 * blocks with, and that is a decision for the ticket that builds it.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

/** Vite puts a content hash in every asset name, so an asset is never the stale one. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** The entry document names those assets, so it must be re-read every time. */
const REVALIDATE = "no-cache";

/**
 * Serves one file from `root`, falling back to the entry document for paths that are
 * routes rather than files — a reload on a deep link must reach the app, not a 404.
 *
 * A missing file that *looks* like a file (it has an extension) stays a 404: answering
 * a mistyped script URL with HTML would hand the browser a syntax error instead of the
 * plain truth that the asset is not there.
 */
export function serveBuiltUi(root: string) {
  const base = resolve(root);

  return async (c: Context): Promise<Response> => {
    // `/api/*` is the API's, whether or not it has a route there; answering with the
    // app's HTML would turn a typo in a client into an unparseable "success"
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return c.notFound();

    const requested = underRoot(base, c.req.path);
    if (requested === undefined) return c.notFound();

    const file = await read(requested);
    if (file !== undefined) return respond(file, requested, c.req.path);

    if (extname(requested) !== "") return c.notFound();

    const index = await read(resolve(base, INDEX));
    if (index === undefined) return c.notFound();
    return respond(index, INDEX, "/");
  };
}

/**
 * The file a request path names, or nothing when it names a place outside the built UI.
 *
 * The path is normalised first so `..` segments collapse, and then checked against the
 * root anyway: normalising is what makes the common case right, and the check is what
 * makes the uncommon one safe.
 */
function underRoot(base: string, path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;

  const target = resolve(base, `.${normalize(decoded)}`);
  return target === base || target.startsWith(base + sep) ? target : undefined;
}

async function read(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    // missing, or a directory, or unreadable: all of them are "not a file to serve"
    return undefined;
  }
}

function respond(bytes: Buffer, path: string, requestPath: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": requestPath.startsWith("/assets/") ? IMMUTABLE : REVALIDATE,
    },
  });
}
