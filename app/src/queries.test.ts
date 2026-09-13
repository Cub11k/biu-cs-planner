import { expect, it } from "vitest";
import { memoryWorkspace } from "./workspace.memory.ts";
import { importCrawl } from "./catalog.ts";
import { getOffering, listOfferings } from "./queries.ts";

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

  const fall = await listOfferings(workspace, { academicYear: 2027, semester: "fall" });

  expect(fall.offerings?.map((o) => o.courseNumber)).toEqual(["89-110", "89-385"]);
  // a Year-long Course is given in Fall as much as in Spring
  expect(fall.offerings?.map((o) => o.semesters)).toEqual([["fall"], ["fall", "spring"]]);
});

it("lists a different set for the other Semester", async () => {
  const workspace = await workspaceWithCatalog();

  const spring = await listOfferings(workspace, { academicYear: 2027, semester: "spring" });

  expect(spring.offerings?.map((o) => o.courseNumber)).toEqual(["89-133", "89-385"]);
});

it("returns one Course with its Groups, Meetings and Exams", async () => {
  const workspace = await workspaceWithCatalog();

  const found = await getOffering(workspace, { academicYear: 2027, courseNumber: "89-110" });

  expect(found.offering?.nameHebrew).toBe("מבוא למדעי המחשב");
  expect(found.offering?.groups[0]?.meetings).toEqual([
    { semester: "fall", day: "tuesday", start: "15:00", end: "18:00" },
  ]);
  expect(found.offering?.exams).toEqual({ known: false, sittings: [] });
});

it("says so when the year has no Catalog, rather than inventing an empty one", async () => {
  const workspace = memoryWorkspace({ created: true });

  const result = await listOfferings(workspace, { academicYear: 2030, semester: "fall" });

  expect(result.offerings).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "no-catalog-for-year", academicYear: 2030 }]);
});

it("reports a stored Catalog it cannot read as a Warning, not a crash", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "catalog", academicYear: 2027 }, { nonsense: true });

  const result = await listOfferings(workspace, { academicYear: 2027, semester: "fall" });

  expect(result.offerings).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "file-unreadable" }]);
});
