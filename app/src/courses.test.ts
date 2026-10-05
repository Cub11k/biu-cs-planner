import { expect, it } from "vitest";
import { readCourses } from "./courses.ts";
import { WorkspaceRefusedError, type Workspace, type WorkspaceRef } from "./workspace.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * The Course names and credits the Plan screen draws on its cards (#292): from the Requirements
 * Files first — the chosen Programs' own before the rest — and a name the files do not give from
 * the most recent Catalog. Credits never come from a Catalog (ADR-0008). Course numbers, names and
 * files are invented (ADR-0006).
 */
const REF = { kind: "state", name: "me" } as const;

const file = (name: string, courses: unknown[]) => ({
  schemaVersion: 1,
  program: { id: name, name: { he: name } },
  courses,
  requirements: [],
});

/** A Catalog of one Academic Year holding one Offering per `[number, Hebrew, English?]`. */
const catalog = (academicYear: number, offerings: Array<[string, string, string?]>) => ({
  schemaVersion: 1,
  academicYear,
  offerings: offerings.map(([courseNumber, nameHebrew, nameEnglish]) => ({
    courseNumber,
    nameHebrew,
    ...(nameEnglish === undefined ? {} : { nameEnglish }),
    credits: { known: true, total: 99 },
    semesters: ["fall"],
    groups: [],
    exams: { known: false, sittings: [] },
  })),
  sources: [],
});

const seeded = (): MemoryWorkspace => memoryWorkspace({ created: true });

it("knows no Course in an empty Workspace, and writes nothing", async () => {
  const workspace = seeded();

  expect(await readCourses(workspace)).toEqual({ courses: [] });
  expect(workspace.written()).toEqual([]);
});

it("names a Course and gives its credits from a Requirements File", async () => {
  const workspace = seeded();
  workspace.seed(
    { kind: "requirements", name: "cs-2027" },
    file("cs", [{ number: "89-110", name: { he: "מבוא", en: "Introduction" }, credits: 6 }, { number: "89-111" }]),
  );

  expect(await readCourses(workspace)).toEqual({
    courses: [
      { courseNumber: "89-110", name: { he: "מבוא", en: "Introduction" }, credits: 6 },
      { courseNumber: "89-111" },
    ],
  });
});

it("takes a name the files do not give from the most recent Catalog, and never its credits", async () => {
  const workspace = seeded();
  workspace.seed({ kind: "requirements", name: "cs-2027" }, file("cs", [{ number: "89-110", credits: 6 }]));
  workspace.seed({ kind: "catalog", academicYear: 2026 }, catalog(2026, [["89-110", "ישן"], ["89-999", "ישן"]]));
  workspace.seed(
    { kind: "catalog", academicYear: 2027 },
    catalog(2027, [
      ["89-110", "מבוא", "Introduction"],
      ["89-220", "מבנים"],
    ]),
  );

  expect(await readCourses(workspace)).toEqual({
    courses: [
      { courseNumber: "89-110", name: { he: "מבוא", en: "Introduction" }, credits: 6 },
      { courseNumber: "89-220", name: { he: "מבנים" } },
    ],
  });
});

it("keeps a name the Requirements File gives over the Catalog's", async () => {
  const workspace = seeded();
  workspace.seed({ kind: "requirements", name: "cs-2027" }, file("cs", [{ number: "89-110", name: { he: "מהקובץ" } }]));
  workspace.seed({ kind: "catalog", academicYear: 2027 }, catalog(2027, [["89-110", "מהקטלוג", "From the Catalog"]]));

  expect(await readCourses(workspace)).toEqual({ courses: [{ courseNumber: "89-110", name: { he: "מהקובץ" } }] });
});

it("falls back to an older Catalog when the most recent one cannot be read", async () => {
  const workspace = seeded();
  workspace.seed({ kind: "catalog", academicYear: 2026 }, catalog(2026, [["89-110", "מבוא"]]));
  workspace.seed({ kind: "catalog", academicYear: 2027 }, { notACatalog: true });

  expect(await readCourses(workspace)).toEqual({ courses: [{ courseNumber: "89-110", name: { he: "מבוא" } }] });
});

it("reads the chosen Programs' files before the others, as the credit-load check does", async () => {
  const workspace = seeded();
  // listed first by name, and not chosen
  workspace.seed({ kind: "requirements", name: "a-other" }, file("other", [{ number: "89-110", credits: 2 }]));
  workspace.seed({ kind: "requirements", name: "cs-2027" }, file("cs", [{ number: "89-110", credits: 6 }]));
  workspace.seed(REF, { schemaVersion: 1, programs: [{ requirementsFile: "cs-2027" }] });

  expect(await readCourses(workspace, { stateFile: "me" })).toEqual({
    courses: [{ courseNumber: "89-110", credits: 6 }],
  });

  // with no Program chosen, the files are read in the order the Workspace lists them
  expect(await readCourses(memoryWorkspaceWith(workspace, "a-other", "cs-2027"))).toEqual({
    courses: [{ courseNumber: "89-110", credits: 2 }],
  });
});

it("still knows the Courses when the State File cannot be read", async () => {
  const workspace = seeded();
  workspace.seed({ kind: "requirements", name: "cs-2027" }, file("cs", [{ number: "89-110", credits: 6 }]));
  workspace.seed(REF, { notAStateFile: true });

  expect(await readCourses(workspace, { stateFile: "me" })).toEqual({
    courses: [{ courseNumber: "89-110", credits: 6 }],
  });
});

it("answers with what it could read when the Workspace refuses a folder or a file, rather than failing", async () => {
  const inner = seeded();
  inner.seed({ kind: "requirements", name: "cs-2027" }, file("cs", [{ number: "89-110", credits: 6 }]));
  inner.seed({ kind: "catalog", academicYear: 2027 }, catalog(2027, [["89-220", "מבנים"]]));
  const refusing = (kind: WorkspaceRef["kind"]): Workspace => ({
    ...inner,
    list: async (listed) => {
      if (listed === kind) throw new WorkspaceRefusedError({ reason: "unreadable", subject: { kind: "folder", folder: "catalogs" } } as never, "no");
      return inner.list(listed);
    },
  });

  expect(await readCourses(refusing("catalog"))).toEqual({ courses: [{ courseNumber: "89-110", credits: 6 }] });
  expect(await readCourses(refusing("requirements"))).toEqual({
    courses: [{ courseNumber: "89-220", name: { he: "מבנים" } }],
  });

  const unreadableCatalog: Workspace = {
    ...inner,
    read: async (ref) => {
      if (ref.kind === "catalog") throw new WorkspaceRefusedError({ reason: "unreadable", subject: ref } as never, "no");
      return inner.read(ref);
    },
  };
  expect(await readCourses(unreadableCatalog)).toEqual({ courses: [{ courseNumber: "89-110", credits: 6 }] });
});

/** A fresh Workspace holding only the named Requirements Files of `from`, and no State File. */
function memoryWorkspaceWith(from: MemoryWorkspace, ...names: string[]): Workspace {
  return {
    ...from,
    readStateFile: async () => undefined,
    list: async (kind) => (kind === "requirements" ? names.map((name) => ({ kind: "requirements", name }) as const) : from.list(kind)),
  };
}
