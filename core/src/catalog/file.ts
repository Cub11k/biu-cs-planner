import { z } from "zod";
import { catalogSchema, CURRENT_CATALOG_SCHEMA_VERSION, type Catalog } from "./schema.ts";

export { CURRENT_CATALOG_SCHEMA_VERSION };

export type CatalogFileWarning =
  | { kind: "file-unreadable" }
  | { kind: "schema-version-too-new"; found: number }
  | { kind: "schema-version-unsupported"; found: number };

/**
 * Migrations that bring an older file up to the current version, keyed by the version they
 * read. There are none yet because there has only ever been one version; as versions accrue,
 * each new one adds the migration that reads the version before it, and OLDEST_READABLE stays
 * the lowest version a chain still reaches.
 */
const MIGRATIONS: Record<number, (file: unknown) => unknown> = {};

const OLDEST_READABLE = CURRENT_CATALOG_SCHEMA_VERSION;

const versionProbe = z.object({ schemaVersion: z.number() });

/**
 * JSON Schema for a Catalog file, so a hand-written or hand-edited file gets autocomplete
 * and inline errors in an editor. Generated from the Zod schema, never maintained by hand.
 */
export function catalogJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(catalogSchema) as Record<string, unknown>;
}

/**
 * Reads a Catalog file. Untrusted input: it never throws and never half-loads — either a
 * Catalog comes back or a Warning explaining why one did not.
 */
export function parseCatalogFile(input: unknown): {
  catalog?: Catalog;
  warnings: CatalogFileWarning[];
} {
  const probe = versionProbe.safeParse(input);
  if (!probe.success) return { warnings: [{ kind: "file-unreadable" }] };

  const found = probe.data.schemaVersion;
  if (found > CURRENT_CATALOG_SCHEMA_VERSION) {
    return { warnings: [{ kind: "schema-version-too-new", found }] };
  }
  if (found < OLDEST_READABLE) {
    return { warnings: [{ kind: "schema-version-unsupported", found }] };
  }

  let migrated = input;
  for (let version = found; version < CURRENT_CATALOG_SCHEMA_VERSION; version++) {
    const migrate = MIGRATIONS[version];
    if (!migrate) return { warnings: [{ kind: "schema-version-unsupported", found }] };
    migrated = migrate(migrated);
  }

  const parsed = catalogSchema.safeParse(migrated);
  if (!parsed.success) return { warnings: [{ kind: "file-unreadable" }] };

  return { catalog: parsed.data, warnings: [] };
}
