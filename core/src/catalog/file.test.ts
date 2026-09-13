import { expect, it } from "vitest";
import { parseCatalogFile, catalogJsonSchema, CURRENT_CATALOG_SCHEMA_VERSION } from "./file.ts";
import { importRawCrawl } from "../shoham/import.ts";

function catalogOnDisk() {
  const { catalog } = importRawCrawl(
    {
      rows: [
        {
          code: "89110",
          name: "מבוא למדעי המחשב",
          group: "01",
          teachers: "פרופ' נועה אגמון",
          kind: "הרצאה",
          semester: "סמסטר א'",
          day: "ג'",
          hours: "15:00 - 18:00",
          lid: "808655",
        },
      ],
    },
    { academicYear: 2027 },
  );
  // what actually reaches disk: JSON, so every type has survived a round trip
  return JSON.parse(JSON.stringify(catalog)) as unknown;
}

it("reads back a Catalog the Importer produced", () => {
  const result = parseCatalogFile(catalogOnDisk());

  expect(result.warnings).toEqual([]);
  expect(result.catalog?.schemaVersion).toBe(CURRENT_CATALOG_SCHEMA_VERSION);
  expect(result.catalog?.offerings[0]?.courseNumber).toBe("89-110");
});

it("refuses a file that is not a Catalog, without throwing", () => {
  const result = parseCatalogFile({ nonsense: true });

  expect(result.catalog).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "file-unreadable" }]);
});

it("refuses a file written by a newer app", () => {
  const future = { ...(catalogOnDisk() as object), schemaVersion: 99 };

  const result = parseCatalogFile(future);

  expect(result.catalog).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "schema-version-too-new", found: 99 }]);
});

it("exports JSON Schema, so a hand-written Catalog gets editor support", () => {
  const schema = catalogJsonSchema();

  expect(schema).toMatchObject({
    type: "object",
    properties: {
      schemaVersion: { type: "number" },
      academicYear: { type: "number" },
      offerings: { type: "array" },
    },
  });
  expect(schema.required).toEqual(
    expect.arrayContaining(["schemaVersion", "academicYear", "offerings"]),
  );
});
