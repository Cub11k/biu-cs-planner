import { expect, it } from "vitest";
import { migrateForward, type Migration } from "./migrate.ts";

/** Invented versions, so the walk can be proven before a real version 2 exists. */
const bump = (to: number, change: (file: Record<string, unknown>) => void): Migration =>
  (file) => {
    const next = { ...(file as Record<string, unknown>) };
    change(next);
    next.schemaVersion = to;
    return next;
  };

const migrations: Record<number, Migration> = {
  1: bump(2, (file) => {
    file.language = file.lang;
    delete file.lang;
  }),
  2: bump(3, (file) => {
    file.pins = [];
  }),
};

it("walks a file forward one version at a time", () => {
  const result = migrateForward({ schemaVersion: 1, lang: "he" }, 1, 3, migrations);

  expect(result).toEqual({
    ok: true,
    file: { schemaVersion: 3, language: "he", pins: [] },
  });
});

it("leaves a file already at the current version untouched", () => {
  const file = { schemaVersion: 3, language: "he" };

  expect(migrateForward(file, 3, 3, migrations)).toEqual({ ok: true, file });
});

it("refuses a version no migration reads, naming it", () => {
  const result = migrateForward({ schemaVersion: 7 }, 7, 9, migrations);

  expect(result).toEqual({ ok: false, reason: "no-migration", version: 7 });
});

it("refuses a migration that does not advance the version", () => {
  const stuck: Record<number, Migration> = { 1: (file) => file };

  const result = migrateForward({ schemaVersion: 1 }, 1, 2, stuck);

  expect(result).toEqual({ ok: false, reason: "migration-failed", version: 1 });
});

it("refuses a migration that returns something that is not a file", () => {
  const notAnObject: Record<number, Migration> = { 1: () => "not a file" };
  const noRealVersion: Record<number, Migration> = { 1: () => ({ schemaVersion: "2" }) };

  expect(migrateForward({ schemaVersion: 1 }, 1, 2, notAnObject)).toEqual({
    ok: false,
    reason: "migration-failed",
    version: 1,
  });
  expect(migrateForward({ schemaVersion: 1 }, 1, 2, noRealVersion)).toEqual({
    ok: false,
    reason: "migration-failed",
    version: 1,
  });
});

it("refuses a migration that throws, rather than letting it escape", () => {
  const explodes: Record<number, Migration> = {
    1: () => {
      throw new Error("half-written file");
    },
  };

  const result = migrateForward({ schemaVersion: 1 }, 1, 2, explodes);

  expect(result).toEqual({ ok: false, reason: "migration-failed", version: 1 });
});

it("refuses a version below the whole chain, which is how a file too old is recognised", () => {
  expect(migrateForward({ schemaVersion: 0 }, 0, 3, migrations)).toEqual({
    ok: false,
    reason: "no-migration",
    version: 0,
  });
});
