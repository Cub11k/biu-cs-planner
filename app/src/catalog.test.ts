import { expect, it } from "vitest";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";
import { importCrawl } from "./catalog.ts";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

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

  // The part re-carries the lecture beside the tirgul it brings. A part speaks for the
  // Offerings it carries rows for (ADR-0011), so one naming the tirgul alone would be saying
  // the lecture is gone rather than adding to it.
  const tirgul = {
    rows: [
      CRAWL.rows[0]!,
      { ...CRAWL.rows[0]!, group: "03", kind: "תרגיל", hours: "18:00 - 20:00", lid: "822335" },
    ],
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

/**
 * The port's third answer to a read: not the bytes and not absence, but a file that is there
 * whose bytes cannot be got at — a mode bit, a directory in its place, failing hardware (#109).
 *
 * The refusal is injected rather than produced, as `cannotBeRead` in `./edit.test.ts` injects
 * it and for the same reason: the double has no unreadable files and is deliberately given no
 * knob for one, so what is under test here is the mapping, and the adapter that raises it for
 * real is tested against a real folder (`server/src/workspace.fs.test.ts`).
 */
const cannotBeRead = (workspace: MemoryWorkspace): Workspace => ({
  ...workspace,
  read: () =>
    Promise.reject(
      new WorkspaceRefusedError("refusing catalogs/2027.json: it is there and cannot be read (EISDIR)"),
    ),
});

/**
 * #116 where it reaches this use case, and #130's third ask.
 *
 * The test above is a stored Catalog whose **bytes** are not a Catalog. This one is a stored
 * Catalog the port refuses outright, which used to come back as `undefined` — indistinguishable
 * from a year with no Catalog at all — so the import merged into nothing and wrote the result
 * over a year's Offerings it had never read. The hole was closed in the adapter and in the port's
 * contract; until now this use case's own test file said nothing about it, so nothing here
 * failed if the `catch` above `parseCatalogFile` were dropped.
 */
it("refuses an import when the stored Catalog cannot be read at all, and writes nothing", async () => {
  const workspace = memoryWorkspace({ created: true });

  const result = await importCrawl(cannotBeRead(workspace), CRAWL, { academicYear: 2027 });

  expect(result.stored).toBe(false);
  expect(result.stored === false && result.reason).toBe("workspace-refused");
  // and nothing was merged into nothing and written over it
  expect(workspace.written()).toEqual([]);
});
