import { expect, it } from "vitest";
import type { Catalog, GroupPick, Offering } from "@biu-cs-planner/core";
import { CURRENT_CATALOG_SCHEMA_VERSION } from "@biu-cs-planner/core";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";
import { readExams } from "./exams.ts";
import { pickGroup } from "./picks.ts";
import { setSettings } from "./settings.ts";

/**
 * The exam period, read at the threshold the student stored (#164).
 *
 * The State File is written through the use cases rather than seeded, so what is under test is
 * the value a student's own edit put there and not a literal this file invented.
 */
const AT = { academicYear: 2027, semester: "fall" } as const;

/** Invented Offerings. No crawled data reaches a test (ADR-0006). */
function offering(courseNumber: string, dates: string[]): Offering {
  return {
    courseNumber,
    nameHebrew: `קורס ${courseNumber}`,
    credits: { known: true, total: 4 },
    semesters: ["fall"],
    groups: [],
    exams: {
      known: true,
      sittings: dates.map((date) => ({ moed: "מועד א", date, time: "09:00" })),
    },
  };
}

const catalog = (offerings: Offering[]): Catalog => ({
  schemaVersion: CURRENT_CATALOG_SCHEMA_VERSION,
  academicYear: 2027,
  // one entry per part merged in, and this Catalog was never merged from a Raw Crawl
  sources: [],
  offerings,
});

/** Two days apart: warned about at the design's three, silent at two. */
const TWO_DAYS = "2027-01-23";
/** Five days apart: silent at three, warned about once a student asks for a week. */
const FIVE_DAYS = "2027-01-26";

const pick = (courseNumber: string): GroupPick => ({
  courseNumber,
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "09:00", end: "11:00" }],
});

/**
 * A Workspace holding a Catalog and two Picks, with their Exams `secondExam` apart.
 *
 * The second date is a parameter because each direction of the threshold needs its own gap: a
 * pair two days apart is warned about at three and silent at two, while narrowing the threshold
 * over a pair *outside* it — or widening it over a pair already inside it — would pass whether
 * the stored threshold reached the check or not.
 */
async function twoExams(secondExam: string): Promise<MemoryWorkspace> {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed(
    { kind: "catalog", academicYear: 2027 },
    catalog([offering("89-110", ["2027-01-21"]), offering("89-112", [secondExam])]),
  );

  let version: string | undefined;
  for (const courseNumber of ["89-110", "89-112"]) {
    const saved = await pickGroup(workspace, AT, pick(courseNumber), { basedOn: version });
    expect(saved.kind).toBe("served");
    version = saved.kind === "served" ? saved.version : undefined;
  }
  return workspace;
}

/** The revision whatever reads next has to be based on, asked for the way a page asks. */
const versionOf = async (workspace: MemoryWorkspace): Promise<string | undefined> => {
  const read = await readExams(workspace, AT);
  return read.kind === "served" ? read.version : undefined;
};

/**
 * **The criterion the whole of #164 turns on**: the stored threshold reaches `checkExams`. Two
 * Exams two days apart are a spacing Warning at the design's three and nothing at all once the
 * student says two, and the only thing that changed between the two reads is the preference in
 * their State File.
 */
it("checks the Exams at the threshold the student stored, not at the default", async () => {
  const workspace = await twoExams(TWO_DAYS);

  const atThree = await readExams(workspace, AT);
  expect(atThree.kind === "served" && atThree.spacingDays).toBe(3);
  expect(atThree.kind === "served" && atThree.exams.warnings.map((w) => w.kind)).toEqual([
    "exam-spacing",
    "exam-spacing",
  ]);

  await setSettings(workspace, { examSpacingDays: 2 }, { basedOn: await versionOf(workspace) });

  const atTwo = await readExams(workspace, AT);
  expect(atTwo.kind === "served" && atTwo.spacingDays).toBe(2);
  expect(atTwo.kind === "served" && atTwo.exams.warnings).toEqual([]);
});

/** `0` is the student turning the spacing Warning off, which is what the bound allows it to be. */
it("raises no spacing Warning at a stored threshold of zero", async () => {
  const workspace = await twoExams(TWO_DAYS);

  await setSettings(workspace, { examSpacingDays: 0 }, { basedOn: await versionOf(workspace) });

  const off = await readExams(workspace, AT);
  expect(off.kind === "served" && off.spacingDays).toBe(0);
  expect(off.kind === "served" && off.exams.warnings).toEqual([]);
});

/**
 * Widening it the other way, over a gap the default is **silent** about: five days apart raises
 * nothing at three, so the Warnings afterwards can only be the stored seven reaching the check.
 */
it("warns about a wider gap once the student widens the threshold", async () => {
  const workspace = await twoExams(FIVE_DAYS);

  const atThree = await readExams(workspace, AT);
  expect(atThree.kind === "served" && atThree.exams.warnings).toEqual([]);

  await setSettings(workspace, { examSpacingDays: 7 }, { basedOn: await versionOf(workspace) });

  const wide = await readExams(workspace, AT);
  expect(wide.kind === "served" && wide.exams.warnings.map((w) => w.kind)).toEqual([
    "exam-spacing",
    "exam-spacing",
  ]);
});

it("serves the sittings in date order, so the rail can space its marks", async () => {
  const workspace = await twoExams(TWO_DAYS);

  const read = await readExams(workspace, AT);

  expect(read.kind === "served" && read.exams.sittings).toEqual([
    { courseNumber: "89-110", moed: "מועד א", date: "2027-01-21", time: "09:00", daysSincePrevious: undefined },
    { courseNumber: "89-112", moed: "מועד א", date: "2027-01-23", time: "09:00", daysSincePrevious: 2 },
  ]);
});

/**
 * One Course, two Lesson Types, one exam-bearing Offering. A Pick is per Lesson Type, so the
 * same Course arrives twice and must not be reported as Clashing with itself — nor counted twice
 * among the Courses whose Exams are unknown.
 */
it("counts a Course once however many Lesson Types are picked for it", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "catalog", academicYear: 2027 }, catalog([offering("89-110", ["2027-01-21"])]));
  const lecture = await pickGroup(workspace, AT, pick("89-110"), { basedOn: undefined });
  await pickGroup(
    workspace,
    AT,
    { ...pick("89-110"), lessonType: "תרגיל" },
    { basedOn: lecture.kind === "served" ? lecture.version : undefined },
  );

  const read = await readExams(workspace, AT);

  expect(read.kind === "served" && read.exams.sittings).toHaveLength(1);
  expect(read.kind === "served" && read.exams.warnings).toEqual([]);
});

/**
 * Two Offerings of one Course in one Academic Year, which a Catalog can hold: it keys an Offering
 * by its Course **and its Semesters** (`offeringKey`, `core/src/shoham/changes.ts`), so a Fall one
 * and a Year-long one are two entries and both answer to a Fall query. Both sets of sittings reach
 * the rail — `checkExams`'s own doc promises exactly that ("Two Offerings of one Course whose
 * Exams genuinely differ both survive, because the whole sitting is the key and not the course
 * number"), and a `Map` keyed by course number in the app layer would have made the promise
 * unkeepable by dropping whichever came first.
 *
 * The Course is still one Course, so nothing counts it twice: three distinct sittings, and none of
 * them reported as Clashing with the Course they belong to.
 */
it("keeps both Offerings when one Course has two in the same year", async () => {
  const workspace = memoryWorkspace({ created: true });
  const fall = offering("89-110", ["2027-01-21"]);
  const yearLong: Offering = {
    ...offering("89-110", ["2027-01-28", "2027-02-04"]),
    semesters: ["fall", "spring"],
  };
  workspace.seed({ kind: "catalog", academicYear: 2027 }, catalog([fall, yearLong]));
  await pickGroup(workspace, AT, pick("89-110"), { basedOn: undefined });

  const read = await readExams(workspace, AT);

  expect(read.kind === "served" && read.exams.sittings.map((s) => s.date)).toEqual([
    "2027-01-21",
    "2027-01-28",
    "2027-02-04",
  ]);
  expect(read.kind === "served" && read.exams.coursesWithUnknownExams).toBe(0);
});

/** The Variant the answer is about, named as the week's answer names it. */
it("names the Variant it answered for", async () => {
  const workspace = await twoExams(TWO_DAYS);

  const read = await readExams(workspace, AT);

  expect(read.kind === "served" && read.variantName).toBe("A");
});

/**
 * A Course the Catalog cannot answer for is still part of the student's Semester, so it is handed
 * to the check with its Exams unknown rather than left out: a rail that simply omitted it would
 * imply an exam period it had no business implying. Every way of not knowing lands here — no
 * Catalog for the year, a Course that is not in the one there is, an Offering nobody has published
 * Exams for — and the Catalog's own Warnings say which.
 */
it("counts a picked Course the Catalog cannot answer for as one whose Exams are unknown", async () => {
  const workspace = memoryWorkspace({ created: true });
  await pickGroup(workspace, AT, pick("89-110"), { basedOn: undefined });

  const read = await readExams(workspace, AT);

  expect(read.kind).toBe("served");
  expect(read.kind === "served" && read.exams.coursesWithUnknownExams).toBe(1);
  expect(read.kind === "served" && read.exams.sittings).toEqual([]);
  // and why it could not be answered for travels with it, about the Catalog and not the State File
  expect(read.kind === "served" && read.catalogWarnings).toEqual([
    { kind: "no-catalog-for-year", academicYear: 2027 },
  ]);
  expect(read.kind === "served" && read.warnings).toEqual([]);
});

it("answers an empty exam period before anything is picked, rather than failing", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "catalog", academicYear: 2027 }, catalog([offering("89-110", ["2027-01-21"])]));

  const read = await readExams(workspace, AT);

  expect(read.kind).toBe("served");
  // the Catalog's Exams are not the student's: nothing is picked, so there is nothing to sit
  expect(read.kind === "served" && read.exams.sittings).toEqual([]);
  expect(read.kind === "served" && read.exams.coursesWithUnknownExams).toBe(0);
});

/**
 * The State File holds both the Picks and the threshold, so a State File that cannot be read
 * leaves no question to answer and this refuses exactly as `readTimetable` does. A Catalog that
 * cannot be served is the other case and is deliberately not a refusal.
 */
it("refuses when the State File cannot be read, as the week does", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "state", name: "me" }, { schemaVersion: 99 });

  const read = await readExams(workspace, AT);

  expect(read).toMatchObject({
    kind: "refused",
    reason: "state-file-unreadable",
    warnings: [{ kind: "schema-version-too-new", found: 99 }],
  });
});
