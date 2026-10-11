import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { EditHistory, Workspace } from "@biu-cs-planner/app";
import { z } from "zod";

/**
 * What every route module of the HTTP API shares: the body cap, the body and year parsers, and
 * the one mapping from a use case's result to a response. `./api.ts` composes the route modules;
 * each of them imports what it needs from here and nothing from another route module.
 */

/**
 * What a route module is built from: the Workspace it works in, and `into`, the undo stack every
 * editing route hands to its use case (`createApi` in `./api.ts` builds both, once per server).
 */
export type RouteDependencies = { workspace: Workspace; into: EditHistory };

/** A crawl of a whole department is large; a request far past that is not one. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * An Academic Year in a route path: four digits and nothing else, then the bound (#250). It used
 * to be `z.coerce.number()`, whose `Number()` reads `0x7e3` as 2019, `2e3` as 2000 and a
 * whitespace-padded `2027` as 2027, while its sibling `2027.5` got `400 bad-year`. One spelling of
 * a year, one answer. The pattern is a literal, never built from data (ADR-0007).
 */
export const yearSchema = z
  .string()
  .regex(/^\d{4}$/)
  .transform(Number)
  .pipe(z.number().int().min(1900).max(2200));

/** Every write route is capped, not just the one that carries a crawl. */
export const capped = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: "body-too-large" }, 413),
});

/**
 * `__proto__` and `constructor` are rejected outright rather than stripped, so a body
 * carrying them is refused instead of quietly half-accepted (docs/design.md, rule 2).
 * JSON.parse makes `__proto__` an own property, so it is visible to this walk.
 */
export function hasDangerousKey(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasDangerousKey(v, depth + 1));
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return true;
    if (hasDangerousKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/**
 * Which revision of the State File a save was based on: the one the page was showing when
 * the student clicked (docs/design.md, "External edits"). The page holds it because two
 * views of one plan open side by side is a real way of working — and a guard that lived only
 * on the server could not tell the second tab's stale save from the first tab's fresh one.
 *
 * **Absent means the save was based on there being no file**, which is the faithful spelling
 * of the `StateFileVersion | undefined` the domain takes: JSON has no `undefined`, and a
 * `null` synonym for the same claim would be a second way to say one thing. It is therefore
 * optional in the schema and not optional in effect — a client that leaves it out claims
 * there is no file, so it can create one and can never overwrite one. A forgotten revision
 * fails closed, which is the only direction this may fail in.
 *
 * Opaque here, as everywhere: it is compared and handed back, never parsed. No length or
 * shape is asserted beyond its being a string, because what a revision *is* belongs to the
 * Workspace adapter and the API must not grow a second opinion about it.
 */
export const basedOnSchema = z.string().optional();

/**
 * A request body, read the way the import route reads one: JSON, no dangerous key, then
 * the schema for the shape the route actually takes. It hands back the **name** of what
 * was wrong rather than a response, so the route says `c.json(...)` itself and the
 * contract `web` is typed from still knows what every answer looks like.
 *
 * This is the boundary that keeps `writeStateFile`'s `StateFileUnwritableError`
 * unreachable: a body that is not a Pick never reaches the domain, so no `State` is ever
 * built from one and there is no throw to catch (#80).
 */
export async function bodyAs<T>(
  c: Context,
  schema: z.ZodType<T>,
  notTheShape: string,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, error: "body-not-json" };
  }
  if (hasDangerousKey(body)) return { ok: false, error: "unsafe-keys" };

  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, error: notTheShape };

  return { ok: true, value: parsed.data };
}

/** A use case's result with its refused arm taken off: what a route has to put on the wire. */
export type Served<R> = Exclude<R, { kind: "refused" }>;

/** The refused arm of a use case's result, as its 409 carries it. */
type RefusalOf<R> = R extends { kind: "refused"; reason: infer Reason; warnings: infer W }
  ? { reason: Reason; warnings: W }
  : never;

/**
 * The refusal mapping, once for every area: a use case's result as a response. Served is a 200
 * carrying what `served` makes of it — each area says which of its fields go on the wire — and
 * refused is the named 409 a refusal has always been, its reason and its Warnings.
 *
 * `state-file-changed` is among the reasons, and a 409 is right for it: the request is well
 * formed and conflicts with the state of the file (#90). The page reloads and says so.
 *
 * Generic over the result rather than taking a `Response`, so each route's inferred `ApiType`
 * still carries both arms with the area's own types, and `hc<ApiType>` in `web` narrows the 409
 * to that area's refusal reasons (#366).
 */
export function answer<R extends { kind: string }, B>(
  c: Context,
  result: R,
  served: (result: Served<R>) => B,
) {
  if (result.kind === "refused") {
    const { reason, warnings } = result as unknown as RefusalOf<R>;
    // typed as the whole arm, not field by field: an indexed field of a type still generic here
    // is resolved to its constraint, and the 409 in `ApiType` would lose its reasons to `JSONValue`
    return c.json({ reason, warnings } as RefusalOf<R>, 409);
  }
  return c.json(served(result as Served<R>));
}
