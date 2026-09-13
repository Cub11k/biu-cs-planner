/**
 * Every Catalog, Requirements File and State File carries a `schemaVersion`, and
 * migration functions upgrade older files on load (docs/design.md, "Data").
 *
 * This is the floor the real Zod schemas build on; the "Schemas and migrations"
 * ticket replaces the placeholder body, not the contract.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export function isSupportedSchemaVersion(version: number): boolean {
  return Number.isInteger(version) && version >= 1 && version <= CURRENT_SCHEMA_VERSION;
}
