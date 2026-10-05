import { parseStateFile, type GroupPick, type State } from "@biu-cs-planner/core";
import { expect, it } from "vitest";
import type { EditHistory, StateEdit } from "./edit.ts";
import { readExams } from "./exams.ts";
import { DEFAULT_STATE_FILE, pickGroup, readTimetable, type TimetableRef } from "./picks.ts";
import {
  addVariant,
  duplicateVariantAs,
  makeVariantPrimary,
  removeVariant,
  renameVariantAs,
} from "./variants.ts";
import { memoryWorkspace, type MemoryWorkspace } from "./workspace.memory.ts";

/**
 * The Variant use cases through the Workspace port: `core`'s edit applied, saved through the one
 * guarded writer, and read back. That they reach a real disk and a real undo stack is
 * `server/src/api.test.ts`.
 *
 * Fixture data is invented. 89-110 is a real BIU course number, the Meetings are not, and no
 * crawled data is committed to this repo (ADR-0006).
 */
const FALL_2027 = { academicYear: 2027, semester: "fall" } as const;
const REF = { kind: "state", name: DEFAULT_STATE_FILE } as const;

const LECTURE: GroupPick = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};

const ready = (): MemoryWorkspace => memoryWorkspace({ created: true });

async function stored(workspace: MemoryWorkspace): Promise<State | undefined> {
  return parseStateFile((await workspace.readStateFile(REF))?.data).state;
}

/** The revision the last read served, which is what a page's next edit is based on. */
async function now(workspace: MemoryWorkspace, at: TimetableRef = FALL_2027) {
  const read = await readTimetable(workspace, at);
  return { basedOn: read.kind === "served" ? read.version : undefined };
}

const collecting = (): EditHistory & { pushed: StateEdit[] } => {
  const pushed: StateEdit[] = [];
  return { pushed, push: (edit) => pushed.push(edit), wrote: () => {} };
};

/** The tabs a Timetable view carries, as `[name, primary]`. */
const tabsOf = (result: Awaited<ReturnType<typeof readTimetable>>) =>
  result.kind === "served" ? result.view.variants.map((v) => [v.name, v.primary]) : undefined;

/** A file holding A (primary, with a Pick) and an empty B. */
async function twoVariants(): Promise<MemoryWorkspace> {
  const workspace = ready();
  await pickGroup(workspace, FALL_2027, LECTURE, await now(workspace));
  await addVariant(workspace, FALL_2027, { name: "B" }, await now(workspace));
  return workspace;
}

it("creates a Variant and answers about it, with every tab of the Timetable", async () => {
  const workspace = await twoVariants();

  const result = await addVariant(workspace, FALL_2027, { name: "Sunday off" }, await now(workspace));

  expect(result).toMatchObject({
    kind: "served",
    view: { variantName: "Sunday off", picks: [], variantWarnings: [] },
  });
  expect(tabsOf(result)).toEqual([
    ["A", true],
    ["B", false],
    ["Sunday off", false],
  ]);
  expect((await stored(workspace))?.timetables[0]?.variants.map((v) => v.name)).toEqual([
    "A",
    "B",
    "Sunday off",
  ]);
});

it("names a new Variant with the first free letter when the student gives none", async () => {
  const workspace = await twoVariants();

  const result = await addVariant(workspace, FALL_2027, {}, await now(workspace));

  expect(result).toMatchObject({ kind: "served", view: { variantName: "C" } });
});

it("creates the first Variant of a Semester the file has never mentioned", async () => {
  const workspace = ready();

  const result = await addVariant(workspace, FALL_2027, {}, await now(workspace));

  expect(tabsOf(result)).toEqual([["A", true]]);
});

it("duplicates the Variant named, Picks and all, and answers about the copy", async () => {
  const workspace = await twoVariants();

  const result = await duplicateVariantAs(
    workspace,
    { ...FALL_2027, variant: "A" },
    {},
    await now(workspace),
  );

  expect(result).toMatchObject({ kind: "served", view: { variantName: "C", picks: [LECTURE] } });
  expect(tabsOf(result)).toEqual([
    ["A", true],
    ["C", false],
    ["B", false],
  ]);
});

it("renames a Variant, answers about it, and warns when the name is taken", async () => {
  const workspace = await twoVariants();

  const renamed = await renameVariantAs(
    workspace,
    { ...FALL_2027, variant: "B" },
    "A",
    await now(workspace),
  );

  // the edit went through: the Warning travels with it rather than standing in its way
  expect(tabsOf(renamed)).toEqual([
    ["A", true],
    ["A", false],
  ]);
  expect(renamed).toMatchObject({
    kind: "served",
    view: { variantWarnings: [{ kind: "variant-name-not-unique", name: "A" }] },
  });
});

it("marks a Variant primary, unmarking the old one, and answers about it", async () => {
  const workspace = await twoVariants();

  const result = await makeVariantPrimary(
    workspace,
    { ...FALL_2027, variant: "B" },
    await now(workspace),
  );

  expect(result).toMatchObject({ kind: "served", view: { variantName: "B" } });
  expect(tabsOf(result)).toEqual([
    ["A", false],
    ["B", true],
  ]);
});

it("deletes the primary, promotes the next, and answers about the new primary", async () => {
  const workspace = await twoVariants();

  const result = await removeVariant(workspace, { ...FALL_2027, variant: "A" }, await now(workspace));

  expect(result).toMatchObject({ kind: "served", view: { variantName: "B", picks: [] } });
  expect(tabsOf(result)).toEqual([["B", true]]);
});

it("reads the primary when no Variant is named, and the named one when it exists", async () => {
  const workspace = await twoVariants();
  await makeVariantPrimary(workspace, { ...FALL_2027, variant: "B" }, await now(workspace));

  expect(await readTimetable(workspace, FALL_2027)).toMatchObject({
    view: { variantName: "B", picks: [] },
  });
  expect(await readTimetable(workspace, { ...FALL_2027, variant: "A" })).toMatchObject({
    view: { variantName: "A", picks: [LECTURE] },
  });
  // a tab another window deleted reads as the primary rather than as an empty week
  expect(await readTimetable(workspace, { ...FALL_2027, variant: "gone" })).toMatchObject({
    view: { variantName: "B" },
  });
});

it("reads the exam period of the Variant named, and of the primary by default", async () => {
  const workspace = await twoVariants();
  await makeVariantPrimary(workspace, { ...FALL_2027, variant: "B" }, await now(workspace));

  expect(await readExams(workspace, FALL_2027)).toMatchObject({ variantName: "B" });
  expect(await readExams(workspace, { ...FALL_2027, variant: "A" })).toMatchObject({
    variantName: "A",
    exams: { coursesWithUnknownExams: 1 },
  });
});

it("picks into the Variant named, not into the primary", async () => {
  const workspace = await twoVariants();

  await pickGroup(workspace, { ...FALL_2027, variant: "B" }, LECTURE, await now(workspace));

  const variants = (await stored(workspace))?.timetables[0]?.variants;
  expect(variants?.map((v) => [v.name, v.picks.length])).toEqual([
    ["A", 1],
    ["B", 1],
  ]);
});

it("refuses a Variant edit based on a revision the file has moved past", async () => {
  const workspace = await twoVariants();
  const stale = await now(workspace);
  await addVariant(workspace, FALL_2027, { name: "C" }, await now(workspace));

  const result = await removeVariant(workspace, { ...FALL_2027, variant: "B" }, stale);

  expect(result).toMatchObject({ kind: "refused", reason: "state-file-changed" });
  expect((await stored(workspace))?.timetables[0]?.variants.map((v) => v.name)).toEqual([
    "A",
    "B",
    "C",
  ]);
});

it("gives each Variant edit its own label, so each is one undo step", async () => {
  const workspace = await twoVariants();
  const history = collecting();
  const step = async () => ({ ...(await now(workspace)), history });

  await addVariant(workspace, FALL_2027, {}, await step());
  await duplicateVariantAs(workspace, FALL_2027, {}, await step());
  await renameVariantAs(workspace, { ...FALL_2027, variant: "B" }, "Sunday off", await step());
  await makeVariantPrimary(workspace, { ...FALL_2027, variant: "C" }, await step());
  await removeVariant(workspace, { ...FALL_2027, variant: "C" }, await step());

  expect(history.pushed.map((edit) => edit.label)).toEqual([
    "create-variant",
    "duplicate-variant",
    "rename-variant",
    "set-primary-variant",
    "delete-variant",
  ]);
  // each entry holds the Variants as they stood before its own edit
  expect(history.pushed[4]?.previous.timetables[0]?.variants.map((v) => v.name)).toEqual([
    "A",
    "D",
    "Sunday off",
    "C",
  ]);
});

it("writes nothing for a rename that changes nothing", async () => {
  const workspace = await twoVariants();
  const before = workspace.written().length;

  const result = await renameVariantAs(
    workspace,
    { ...FALL_2027, variant: "B" },
    "B",
    await now(workspace),
  );

  expect(result).toMatchObject({ kind: "served", view: { variantName: "B" } });
  expect(workspace.written()).toHaveLength(before);
});

/**
 * #322 through the use cases: after a rename into a taken name — which goes through, with its
 * Warning — the second Variant of that name is reached by the position its answer carries, for a
 * read, a Pick and a rename back out of the collision.
 */
it("reaches both Variants of one name by the position each answer carries", async () => {
  const workspace = await twoVariants();

  const renamed = await renameVariantAs(workspace, { ...FALL_2027, variant: "B" }, "A", await now(workspace));
  expect(renamed).toMatchObject({
    kind: "served",
    view: {
      variantName: "A",
      variantPosition: 1,
      variantWarnings: [{ kind: "variant-name-not-unique", name: "A" }],
    },
  });

  const second = { ...FALL_2027, variant: "A", position: 1 };
  const read = await readTimetable(workspace, second);
  expect(read).toMatchObject({ kind: "served", view: { variantPosition: 1, picks: [] } });
  const first = await readTimetable(workspace, { ...FALL_2027, variant: "A" });
  expect(first).toMatchObject({ kind: "served", view: { variantPosition: 0, picks: [LECTURE] } });

  await pickGroup(workspace, second, { ...LECTURE, groupNumber: "02" }, await now(workspace));
  expect((await stored(workspace))?.timetables[0]?.variants.map((v) => v.picks.map((p) => p.groupNumber))).toEqual([
    ["01"],
    ["02"],
  ]);

  const out = await renameVariantAs(workspace, second, "C", await now(workspace));
  expect(out).toMatchObject({ kind: "served", view: { variantName: "C", variantPosition: 1, variantWarnings: [] } });
});

it("answers a created or duplicated Variant with its own position, even under a taken name", async () => {
  const workspace = await twoVariants();

  const created = await addVariant(workspace, FALL_2027, { name: "A" }, await now(workspace));
  expect(created).toMatchObject({ kind: "served", view: { variantName: "A", variantPosition: 2, picks: [] } });

  const copied = await duplicateVariantAs(workspace, { ...FALL_2027, variant: "A" }, { name: "B" }, await now(workspace));
  expect(copied).toMatchObject({ kind: "served", view: { variantName: "B", variantPosition: 1, picks: [LECTURE] } });
});
