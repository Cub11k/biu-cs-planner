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
 *
 * The walk keeps its own list of what is left to look at rather than calling itself. A State
 * File is untrusted input and JSON nests as deeply as it likes: a file a few thousand objects
 * deep would exhaust the call stack, and a guard that throws on the input it exists to refuse
 * is worse than no guard at all.
 */
export function findUnsafeKey(value: unknown): UnsafeKey | undefined {
  const pending: { node: unknown; at: string }[] = [{ node: value, at: "" }];

  // Grows as it goes, which is the walk: whatever is appended is visited in turn.
  for (let index = 0; index < pending.length; index++) {
    const { node, at } = pending[index]!;
    if (typeof node !== "object" || node === null) continue;

    if (Array.isArray(node)) {
      node.forEach((item, position) => pending.push({ node: item, at: `${at}[${position}]` }));
      continue;
    }

    const keys = Object.keys(node);
    for (const key of keys) {
      if (UNSAFE_KEYS.has(key)) return { key, at };
    }
    for (const key of keys) {
      const child = (node as Record<string, unknown>)[key];
      pending.push({ node: child, at: at ? `${at}.${key}` : key });
    }
  }

  return undefined;
}
