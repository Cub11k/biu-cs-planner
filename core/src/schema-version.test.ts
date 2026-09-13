import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, isSupportedSchemaVersion } from "./schema-version.ts";

describe("isSupportedSchemaVersion", () => {
  it("accepts the current version", () => {
    expect(isSupportedSchemaVersion(CURRENT_SCHEMA_VERSION)).toBe(true);
  });

  it("rejects a version from a newer app", () => {
    expect(isSupportedSchemaVersion(CURRENT_SCHEMA_VERSION + 1)).toBe(false);
  });

  it("rejects versions that are not positive integers", () => {
    expect(isSupportedSchemaVersion(0)).toBe(false);
    expect(isSupportedSchemaVersion(-1)).toBe(false);
    expect(isSupportedSchemaVersion(1.5)).toBe(false);
  });
});
