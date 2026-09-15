/**
 * Migrations run on load, so a State File written by an older build keeps opening. Version 1
 * needs none, but the runner ships with it: retrofitting migration onto files already on
 * students' disks is exactly the situation it exists to prevent.
 */

/** Reads a file at one version and returns it at the next one. */
export type Migration = (file: unknown) => unknown;

/** Keyed by the version the migration reads, so version 3's migration is `MIGRATIONS[3]`. */
export type Migrations = Readonly<Record<number, Migration>>;

export type MigrationOutcome =
  | { ok: true; file: unknown }
  /**
   * `no-migration`: nothing reads that version, so the chain stops there — which is also how
   *   a file older than anything this build still opens is recognised, without a second
   *   constant saying how far back the chain reaches.
   * `migration-failed`: the step threw, or returned a file still at the version it read.
   */
  | { ok: false; reason: "no-migration" | "migration-failed"; version: number };

function versionOf(file: unknown): number | undefined {
  if (typeof file !== "object" || file === null) return undefined;
  const version = (file as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === "number" ? version : undefined;
}

/**
 * Walks a file forward one version at a time. The table is a parameter rather than a
 * module-level constant so the walk can be tested against invented versions while the real
 * one is still empty.
 */
export function migrateForward(
  file: unknown,
  from: number,
  to: number,
  migrations: Migrations,
): MigrationOutcome {
  let migrated = file;

  for (let version = from; version < to; version++) {
    const migrate = migrations[version];
    if (!migrate) return { ok: false, reason: "no-migration", version };

    let next: unknown;
    try {
      next = migrate(migrated);
    } catch {
      // A migration is our own code, but a half-written file can still trip it, and losing
      // the file to an exception is the one outcome that is never acceptable.
      return { ok: false, reason: "migration-failed", version };
    }

    // A step that forgets to stamp the version it produced would make the next step read
    // the wrong shape, so the walk stops here rather than carrying the mistake forward.
    if (versionOf(next) !== version + 1) {
      return { ok: false, reason: "migration-failed", version };
    }
    migrated = next;
  }

  return { ok: true, file: migrated };
}
