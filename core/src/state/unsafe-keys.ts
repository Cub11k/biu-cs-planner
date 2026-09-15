/**
 * `__proto__`, `constructor` and `prototype` are rejected outright rather than stripped
 * (`docs/design.md`, "API and data rules"). Zod would drop them as unknown keys, but a
 * State File carrying one was not written by this app, and opening it hopefully is the
 * wrong instinct: the file is refused and the key is named.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type UnsafeKey = { key: string; at: string };

/**
 * The first prototype-shaped key in a parsed JSON value, with the path to the object holding
 * it (`""` for the file itself). `JSON.parse` is what makes `__proto__` an own key at all,
 * which is why the walk looks at own keys rather than at what the object inherits.
 */
export function findUnsafeKey(value: unknown, at = ""): UnsafeKey | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findUnsafeKey(item, `${at}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) return { key, at };
  }
  for (const key of Object.keys(value)) {
    const found = findUnsafeKey((value as Record<string, unknown>)[key], at ? `${at}.${key}` : key);
    if (found) return found;
  }
  return undefined;
}
