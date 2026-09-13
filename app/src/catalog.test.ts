import { expect, it } from "vitest";
import { memoryWorkspace } from "./workspace.memory.ts";
import { importCrawl } from "./catalog.ts";

const CRAWL = {
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
  details: {},
};

it("imports a Raw Crawl and stores a Catalog that reads back", async () => {
  const workspace = memoryWorkspace({ created: true });

  const result = await importCrawl(workspace, CRAWL, { academicYear: 2027 });

  expect(result.stored).toBe(true);
  expect(result.stored && result.summary).toEqual({ offerings: 1, groups: 1, meetings: 1, exams: 0 });
  expect(workspace.written()).toEqual([{ kind: "catalog", academicYear: 2027 }]);

  const onDisk = await workspace.read({ kind: "catalog", academicYear: 2027 });
  expect(onDisk).toMatchObject({
    academicYear: 2027,
    offerings: [{ courseNumber: "89-110" }],
  });
});

it("refuses to import into a folder that is not a Workspace yet, and writes nothing", async () => {
  const workspace = memoryWorkspace();

  const result = await importCrawl(workspace, CRAWL, { academicYear: 2027 });

  expect(result.stored).toBe(false);
  expect(result.stored === false && result.reason).toBe("workspace-not-ready");
  expect(workspace.written()).toEqual([]);
});

it("merges into the Catalog already stored for that year", async () => {
  const workspace = memoryWorkspace({ created: true });
  await importCrawl(workspace, CRAWL, { academicYear: 2027 });

  const tirgul = {
    rows: [{ ...CRAWL.rows[0]!, group: "03", kind: "תרגיל", hours: "18:00 - 20:00" }],
  };
  const result = await importCrawl(workspace, tirgul, { academicYear: 2027 });

  expect(result.stored).toBe(true);
  // one Offering, now with both Groups: the second import did not replace the first
  expect(result.stored && result.summary).toEqual({
    offerings: 1,
    groups: 2,
    meetings: 2,
    exams: 0,
  });
});

it("refuses to overwrite a stored Catalog it cannot read, rather than losing it", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "catalog", academicYear: 2027 }, { hand: "edited badly" });

  const result = await importCrawl(workspace, CRAWL, { academicYear: 2027 });

  expect(result.stored).toBe(false);
  expect(result.stored === false && result.reason).toBe("stored-catalog-unreadable");
  expect(workspace.written()).toEqual([]);
});
