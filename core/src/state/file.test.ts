import { expect, it } from "vitest";
import { parseStateFile, readStateFile, stateJsonSchema } from "./file.ts";
import type { Migrations } from "./migrate.ts";
import { CURRENT_STATE_SCHEMA_VERSION, stateSchema } from "./schema.ts";

/** What actually reaches disk: JSON, so every type has survived a round trip. */
function onDisk(state: unknown): unknown {
  return JSON.parse(JSON.stringify(state));
}

function fullFile() {
  return {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: [
      {
        courseNumber: "89-110",
        academicYear: 2026,
        semester: "fall",
        status: "failed",
        grade: { kind: "numeric", value: 44 },
      },
      {
        courseNumber: "89-110",
        academicYear: 2027,
        semester: "fall",
        status: "passed",
        grade: { kind: "numeric", value: 91 },
      },
      {
        courseNumber: "10-001",
        academicYear: 2026,
        semester: "spring",
        status: "exempt",
        grade: { kind: "pass-fail", passed: true },
      },
      { courseNumber: "89-230", academicYear: 2027, semester: "spring", status: "planned" },
    ],
    timetables: [
      {
        academicYear: 2027,
        semester: "fall",
        variants: [
          {
            name: "no Fridays",
            primary: true,
            picks: [
              {
                courseNumber: "89-110",
                lessonType: "הרצאה",
                groupNumber: "01",
                meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
              },
            ],
          },
          { name: "late starts", primary: false, picks: [] },
        ],
        blockedTimes: [
          { semester: "fall", day: "sunday", start: "08:00", end: "10:00", label: "commute" },
        ],
      },
    ],
    pins: [{ courseNumber: "10-001", requirementId: "general-english" }],
    settings: { language: "he", examSpacingDays: 5 },
  };
}

it("reads back a State File whole", () => {
  const result = parseStateFile(onDisk(fullFile()));

  expect(result.warnings).toEqual([]);
  expect(result.state).toEqual(fullFile());
});

it("returns a State that its own schema accepts, so the reader cannot drift from the schema", () => {
  const { state } = parseStateFile(onDisk(fullFile()));

  expect(stateSchema.safeParse(state).success).toBe(true);
});

it("opens a file that is a version and nothing else", () => {
  const result = parseStateFile({ schemaVersion: CURRENT_STATE_SCHEMA_VERSION });

  expect(result.warnings).toEqual([]);
  expect(result.state).toEqual({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: [],
    timetables: [],
    pins: [],
    settings: { language: "en", examSpacingDays: 3 },
  });
});

it("refuses a file that is not a State File, without throwing", () => {
  expect(parseStateFile({ nonsense: true })).toEqual({
    warnings: [{ kind: "file-unreadable" }],
  });
  expect(parseStateFile("a string")).toEqual({ warnings: [{ kind: "file-unreadable" }] });
  expect(parseStateFile(null)).toEqual({ warnings: [{ kind: "file-unreadable" }] });
});

it("refuses a file written by a newer app, saying so", () => {
  const result = parseStateFile({ ...fullFile(), schemaVersion: 99 });

  expect(result.state).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "schema-version-too-new", found: 99 }]);
});

it("refuses a file older than any migration it has", () => {
  const result = parseStateFile({ ...fullFile(), schemaVersion: 0 });

  expect(result.state).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "schema-version-unsupported", found: 0 }]);
});

it("refuses a file carrying a prototype-shaped key, naming it", () => {
  const hostile = JSON.parse(
    '{"schemaVersion":1,"settings":{"__proto__":{"isAdmin":true}}}',
  ) as unknown;

  const result = parseStateFile(hostile);

  expect(result.state).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "unsafe-key", key: "__proto__", at: "settings" }]);
  expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
});

it("drops the Attempts it cannot read and keeps the rest, naming each", () => {
  const file = {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    attempts: [
      { courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "passed" },
      { courseNumber: "89-230", academicYear: 2027, semester: "fall", status: "enrolled" },
      { courseNumber: "89-250", academicYear: 2027, semester: "fall" },
    ],
  };

  const result = parseStateFile(file);

  expect(result.state?.attempts).toHaveLength(1);
  expect(result.state?.attempts[0]?.courseNumber).toBe("89-110");
  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "attempts[1]", field: "status" },
    { kind: "entry-dropped", at: "attempts[2]", field: "status" },
  ]);
});

it("drops one bad Pick without losing the Variant around it", () => {
  const file = {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    timetables: [
      {
        academicYear: 2027,
        semester: "fall",
        variants: [
          {
            name: "no Fridays",
            primary: true,
            picks: [
              { courseNumber: "89-110", lessonType: "הרצאה", groupNumber: "01" },
              {
                courseNumber: "89-230",
                lessonType: "תרגיל",
                groupNumber: "02",
                meetings: [{ semester: "fall", day: "monday", start: "10:00", end: "11:00" }],
              },
            ],
          },
        ],
      },
    ],
  };

  const result = parseStateFile(file);

  expect(result.state?.timetables[0]?.variants[0]?.name).toBe("no Fridays");
  expect(result.state?.timetables[0]?.variants[0]?.picks).toHaveLength(1);
  expect(result.warnings).toEqual([
    {
      kind: "entry-dropped",
      at: "timetables[0].variants[0].picks[0]",
      field: "meetings",
    },
  ]);
});

it("keeps a Timetable whose Variants are not a list at all", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    timetables: [{ academicYear: 2027, semester: "fall", variants: "none" }],
  });

  expect(result.state?.timetables[0]?.variants).toEqual([]);
  expect(result.warnings).toEqual([
    { kind: "list-unreadable", at: "timetables[0].variants" },
  ]);
});

it("falls back to default settings it cannot read, rather than losing the file", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    settings: { language: "klingon", examSpacingDays: 5 },
  });

  expect(result.state?.settings).toEqual({ language: "en", examSpacingDays: 3 });
  expect(result.warnings).toEqual([{ kind: "settings-unreadable", field: "language" }]);
});

it("warns when a Timetable has no one primary Variant, and opens it anyway", () => {
  const two = fullFile();
  two.timetables[0]!.variants[1]!.primary = true;

  const result = parseStateFile(onDisk(two));

  expect(result.state?.timetables[0]?.variants).toHaveLength(2);
  expect(result.warnings).toEqual([
    { kind: "primary-variant-not-unique", at: "timetables[0]", primaries: 2 },
  ]);
});

it("warns when no Variant of a Timetable is primary", () => {
  const none = fullFile();
  none.timetables[0]!.variants[0]!.primary = false;

  const result = parseStateFile(onDisk(none));

  expect(result.warnings).toEqual([
    { kind: "primary-variant-not-unique", at: "timetables[0]", primaries: 0 },
  ]);
});

it("says nothing about a Timetable that has no Variants yet", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    timetables: [{ academicYear: 2027, semester: "fall" }],
  });

  expect(result.warnings).toEqual([]);
});

it("warns when a Blocked Time sits in a different Semester from its Timetable", () => {
  const stray = fullFile();
  stray.timetables[0]!.blockedTimes[0]!.semester = "spring";

  const result = parseStateFile(onDisk(stray));

  expect(result.state?.timetables[0]?.blockedTimes).toHaveLength(1);
  expect(result.warnings).toEqual([
    {
      kind: "blocked-time-semester-mismatch",
      at: "timetables[0].blockedTimes[0]",
      semester: "spring",
    },
  ]);
});

/**
 * Comparing zero-padded "HH:MM" as strings is what every consumer of this shape will do, and
 * `23:00`–`01:00` is empty under that comparison rather than wrapping into the next Day. The
 * file keeps the entry; the Warning is what stops it from quietly keeping no time free.
 */
it("warns about a Blocked Time that ends at or before it starts, and keeps it", () => {
  const nightShift = fullFile();
  nightShift.timetables[0]!.blockedTimes = [
    { semester: "fall", day: "sunday", start: "23:00", end: "01:00", label: "night shift" },
    { semester: "fall", day: "monday", start: "10:00", end: "10:00", label: "nothing at all" },
    { semester: "fall", day: "tuesday", start: "08:00", end: "10:00", label: "commute" },
  ];

  const result = parseStateFile(onDisk(nightShift));

  expect(result.state?.timetables[0]?.blockedTimes).toHaveLength(3);
  expect(result.warnings).toEqual([
    {
      kind: "blocked-time-does-not-advance",
      at: "timetables[0].blockedTimes[0]",
      start: "23:00",
      end: "01:00",
    },
    {
      kind: "blocked-time-does-not-advance",
      at: "timetables[0].blockedTimes[1]",
      start: "10:00",
      end: "10:00",
    },
  ]);
});

it("strips a key it does not know rather than carrying it", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    gpa: 92.4,
    attempts: [
      {
        courseNumber: "89-110",
        academicYear: 2027,
        semester: "fall",
        status: "passed",
        creditsCounted: 5,
      },
    ],
  });

  expect(result.state).not.toHaveProperty("gpa");
  expect(result.state?.attempts[0]).not.toHaveProperty("creditsCounted");
  expect(result.warnings).toEqual([]);
});

it("exports JSON Schema, so a hand-edited State File gets editor support", () => {
  const schema = stateJsonSchema();

  expect(schema).toMatchObject({
    type: "object",
    properties: {
      schemaVersion: { type: "number" },
      attempts: { type: "array" },
      timetables: { type: "array" },
      pins: { type: "array" },
      settings: { type: "object" },
    },
  });
  // Only the version is required: everything a new State File leaves out has a default,
  // and a hand-written file that omits it should not be flagged in the editor.
  expect(schema.required).toEqual(["schemaVersion"]);
});

/**
 * The rule that outlives this ticket: a State File references Courses by course number and
 * holds no pointer into a Catalog. The list is exhaustive on purpose — a new field anywhere
 * in the schema fails this test, which is the moment to check it against the rule.
 */
it("names Courses by course number and nothing by Catalog entry", () => {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        Object.keys(value).forEach((name) => names.add(name));
      }
      walk(value);
    }
  };
  walk(stateJsonSchema());

  expect([...names].sort()).toEqual([
    "academicYear",
    "attempts",
    "blockedTimes",
    "courseNumber",
    "day",
    "end",
    "examSpacingDays",
    "grade",
    "groupNumber",
    "kind",
    "label",
    "language",
    "lessonType",
    "meetings",
    "name",
    "passed",
    "picks",
    "pins",
    "primary",
    "requirementId",
    "schemaVersion",
    "semester",
    "settings",
    "start",
    "status",
    "timetables",
    "value",
    "variants",
  ]);
});

it("drops a Variant it cannot read and keeps the Timetable around it", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    timetables: [
      { academicYear: 2027, semester: "fall", variants: [{ picks: [] }, { name: "ok" }] },
    ],
  });

  expect(result.state?.timetables[0]?.variants).toEqual([{ name: "ok", primary: false, picks: [] }]);
  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "timetables[0].variants[0]", field: "name" },
    { kind: "primary-variant-not-unique", at: "timetables[0]", primaries: 0 },
  ]);
});

it("drops a Timetable it cannot read and keeps the rest of the file", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    timetables: [{ semester: "fall" }, { academicYear: 2027, semester: "spring" }],
    pins: [{ courseNumber: "10-001", requirementId: "general-english" }],
  });

  expect(result.state?.timetables).toHaveLength(1);
  expect(result.state?.pins).toHaveLength(1);
  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "timetables[0]", field: "academicYear" },
  ]);
});

/**
 * Version 1 needs no migration, so the wiring between the runner and the Warnings it turns
 * into is exercised against invented versions. When a real version 2 lands this is where a
 * fixture at the hand-written older version joins in.
 */
const pretendCurrent = CURRENT_STATE_SCHEMA_VERSION;

it("refuses a file the chain of migrations does not reach back to", () => {
  // The chain reads the version before the current one, but not the one before that.
  const chain: Migrations = {
    [pretendCurrent - 1]: () => ({ schemaVersion: pretendCurrent }),
  };

  const result = readStateFile({ schemaVersion: pretendCurrent - 2 }, chain);

  expect(result.state).toBeUndefined();
  expect(result.warnings).toEqual([
    { kind: "schema-version-unsupported", found: pretendCurrent - 2 },
  ]);
});

it("refuses a file whose migration cannot finish, naming the step that stopped", () => {
  const broken: Migrations = {
    [pretendCurrent - 1]: () => {
      throw new Error("half-written file");
    },
  };

  const result = readStateFile({ schemaVersion: pretendCurrent - 1 }, broken);

  expect(result.state).toBeUndefined();
  expect(result.warnings).toEqual([
    { kind: "migration-failed", found: pretendCurrent - 1, version: pretendCurrent - 1 },
  ]);
});

it("reads a file an older version was migrated forward from", () => {
  const chain: Migrations = {
    [pretendCurrent - 1]: (file) => ({
      schemaVersion: pretendCurrent,
      attempts: (file as { courses?: unknown }).courses,
    }),
  };

  const result = readStateFile(
    {
      schemaVersion: pretendCurrent - 1,
      courses: [
        { courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "passed" },
      ],
    },
    chain,
  );

  expect(result.warnings).toEqual([]);
  expect(result.state?.attempts[0]?.courseNumber).toBe("89-110");
});

it("refuses input that arrives as a list rather than a file", () => {
  expect(parseStateFile([{ schemaVersion: CURRENT_STATE_SCHEMA_VERSION }])).toEqual({
    warnings: [{ kind: "file-unreadable" }],
  });
});

it("refuses a migration that hands back something that is not a file", () => {
  const wayward: Migrations = {
    [pretendCurrent - 1]: () => Object.assign([], { schemaVersion: pretendCurrent }),
  };

  const result = readStateFile({ schemaVersion: pretendCurrent - 1 }, wayward);

  expect(result.state).toBeUndefined();
  expect(result.warnings).toEqual([{ kind: "file-unreadable" }]);
});
