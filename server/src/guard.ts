import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

/**
 * What stands between the planner and everything else that can reach the port: another
 * OS user, and any website the student has open in the same browser (ADR-0004).
 *
 * The name is the whole rule — the server is reachable only by the student who launched
 * it — and no single one of the four checks below is enough for that on its own.
 *
 * Four checks, cheapest and most structural first:
 *
 *   Host          a name that is not loopback means the request arrived through DNS
 *                 rebinding, not from a student typing localhost
 *   Origin        a write from another site is a forgery; a read is not a change
 *   Content-Type  a JSON body cannot be sent by an HTML form, which is what a
 *                 cross-site forgery has to work with when it cannot preflight
 *   Authorization the launch token, which only the student who started the server has
 *
 * None of these produces a Warning: they are not domain checks on an edit the student
 * made, they are refusals to treat a request as the student's at all.
 */
export type GuardOptions = {
  /** The launch token every request must carry. */
  token: string;
  /** Paths that need no token — the health probe, so a launcher can find a live server. */
  openPaths?: readonly string[];
};

/** Reads change nothing, so they are exempt from the Origin and Content-Type checks. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The names loopback answers to. Matched whole, after the port is removed, so
 * `localhost.evil.example` is not one of them.
 */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function onlyTheLauncher({ token, openPaths = [] }: GuardOptions) {
  const open = new Set(openPaths);
  const expected = digest(token);

  return createMiddleware(async (c, next) => {
    if (!isLoopbackHost(c.req.header("Host") ?? hostOf(c.req.url))) {
      return c.json({ error: "host-not-localhost" }, 403);
    }

    if (!READ_METHODS.has(c.req.method)) {
      const origin = c.req.header("Origin");
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        return c.json({ error: "cross-site" }, 403);
      }
      if (!isJsonContentType(c.req.header("Content-Type"))) {
        return c.json({ error: "content-type-not-json" }, 415);
      }
    }

    if (!open.has(c.req.path) && !carriesToken(c.req.header("Authorization"), expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    await next();
  });
}

/**
 * A `Host` of `evil.example` reaching a server bound to 127.0.0.1 means the browser
 * resolved an attacker's name to loopback — the request is the attacker's page, not the
 * student's. The port is whatever the server ended up on, so it is not checked.
 */
function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  return LOOPBACK_NAMES.has(hostWithoutPort(host).toLowerCase());
}

/**
 * The adapter builds the request URL out of the `Host` header, so the two agree on a
 * real request. They come apart only where there is no header to read — a synthetic
 * request in a test — and then the URL is the authority.
 */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** `[::1]:8900` keeps its brackets; `localhost:8900` loses its port. */
function hostWithoutPort(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1) || host;
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * The page is served from loopback — in development by Vite on another port, which is
 * why the port is not pinned. Anything else is another site.
 */
function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // "null", which a sandboxed frame sends, lands here and is refused
    return false;
  }
  return url.protocol === "http:" && LOOPBACK_NAMES.has(url.hostname.toLowerCase());
}

/**
 * Only `application/json`. A form post — the one cross-site write a browser makes
 * without a preflight — can only declare a form type, so this closes that door even
 * before the Origin check is consulted.
 */
function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return contentType.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/**
 * Compared as fixed-length digests, so neither the length of the real token nor the
 * position of the first wrong character can be read off how long the check took.
 */
function carriesToken(header: string | undefined, expected: Buffer): boolean {
  if (header === undefined) return false;

  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return false;

  const offered = rest.join(" ").trim();
  if (offered === "") return false;

  return timingSafeEqual(digest(offered), expected);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
