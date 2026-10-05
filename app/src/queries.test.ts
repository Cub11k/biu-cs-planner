import { expect, it } from "vitest";
import { memoryWorkspace } from "./workspace.memory.ts";
import { importCrawl } from "./catalog.ts";
import { getOffering, listOfferings } from "./queries.ts";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

const row = (overrides: Record<string, string> = {}) => ({
  code: "89110",
  name: "מבוא למדעי המחשב",
  group: "01",
  teachers: "פרופ' נועה אגמון",
  kind: "הרצאה",
  semester: "סמסטר א'",
  day: "ג'",
  hours: "15:00 - 18:00",
  lid: "808655",
  ...overrides,
});

/** The answer's read arm, failing the test when the Workspace refused instead. */
function read<T extends { kind: string }>(answer: T): Extract<T, { kind: "read" }> {
  expect(answer.kind).toBe("read");
  return answer as Extract<T, { kind: "read" }>;
}

async function workspaceWithCatalog() {
  const workspace = memoryWorkspace({ created: true });
  await importCrawl(
    workspace,
    {
      rows: [
        row(),
        row({ code: "89133", name: "חשבון 2", semester: "סמסטר ב'" }),
        row({ code: "89385", name: "סדנה", semester: "סמסטר א'\nסמסטר ב'", day: "", hours: "" }),
      ],
    },
    { academicYear: 2027 },
  );
  return workspace;
}

it("lists the Courses a Semester holds, Year-long ones included", async () => {
  const workspace = await workspaceWithCatalog();

  const fall = read(await listOfferings(workspace, { academicYear: 2027, semester: "fall" }));

  expect(fall.offerings?.map((o) => o.courseNumber)).toEqual(["89-110", "89-385"]);
  // a Year-long Course is given in Fall as much as in Spring
  expect(fall.offerings?.map((o) => o.semesters)).toEqual([["fall"], ["fall", "spring"]]);
});

it("lists a different set for the other Semester", async () => {
  const workspace = await workspaceWithCatalog();

  const spring = read(await listOfferings(workspace, { academicYear: 2027, semester: "spring" }));

  expect(spring.offerings?.map((o) => o.courseNumber)).toEqual(["89-133", "89-385"]);
});

it("returns one Course with its Groups, Meetings and Exams", async () => {
  const workspace = await workspaceWithCatalog();

  const found = read(await getOffering(workspace, { academicYear: 2027, courseNumber: "89-110" }));

  expect(found.offering?.nameHebrew).toBe("מבוא למדעי המחשב");
  expect(found.offering?.groups[0]?.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
  ]);
  expect(found.offering?.exams).toEqual({ known: false, sittings: [] });
});

it("says so when the year has no Catalog, rather than inventing an empty one", async () => {
  const workspace = memoryWorkspace({ created: true });

  const result = read(await listOfferings(workspace, { academicYear: 2030, semester: "fall" }));

  expect(result.offerings).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "no-catalog-for-year", academicYear: 2030 }]);
});

it("reports a stored Catalog it cannot read as a Warning, not a crash", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "catalog", academicYear: 2027 }, { nonsense: true });

  const result = read(await listOfferings(workspace, { academicYear: 2027, semester: "fall" }));

  expect(result.offerings).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "file-unreadable" }]);
});

/**
 * #249: the adapter's own words never reach the Warning. A deliberately hostile double, whose
 * refusal message is a path and whose subject names a file it was not asked about, is answered
 * with `app`'s sentence about the Catalog the query asked for — and only that.
 */
it("words a refusal itself, and carries nothing a hostile adapter wrote", async () => {
  const path = "/home/alice/Workspace/catalogs/2027.json";
  const hostile: Workspace = {
    ...memoryWorkspace({ created: true }),
    read: () =>
      Promise.reject(
        new WorkspaceRefusedError(
          { reason: "unreadable", subject: { kind: "state", name: "whatever-it-likes" } },
          path,
          { cause: new Error(path) },
        ),
      ),
  };

  // #149: a refusal is its own arm with no Warnings in it, carrying #249's reason code
  const expected = {
    kind: "refused",
    reason: "unreadable",
    sentence: "refusing the Catalog for the Academic Year 2027: it is there and cannot be read",
  };
  const listed = await listOfferings(hostile, { academicYear: 2027, semester: "fall" });
  expect(listed).toEqual(expected);
  const one = await getOffering(hostile, { academicYear: 2027, courseNumber: "89-110" });
  expect(one).toEqual(expected);
  expect(JSON.stringify([listed, one])).not.toContain("whatever-it-likes");
  expect(JSON.stringify([listed, one])).not.toContain(path);
});

/** A refusal whose `refusal` cannot even be read is still a refusal, and not a crashed request. */
it("answers a refusal it cannot read anything off as a refusal", async () => {
  // an accessor where the port declares a field, which only a cast or plain JavaScript can make
  const unreadable = Object.create(WorkspaceRefusedError.prototype, {
    refusal: {
      get() {
        throw new Error("/home/alice/Workspace/catalogs/2027.json");
      },
    },
  }) as WorkspaceRefusedError;
  const hostile: Workspace = {
    ...memoryWorkspace({ created: true }),
    read: () => Promise.reject(unreadable),
  };

  // still the refused arm, with no reason code because none could be read
  expect(await listOfferings(hostile, { academicYear: 2027, semester: "fall" })).toEqual({
    kind: "refused",
    sentence: "refusing the Catalog for the Academic Year 2027: the Workspace would not touch it",
  });
});
