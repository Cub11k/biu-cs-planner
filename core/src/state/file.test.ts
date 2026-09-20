import { expect, it } from "vitest";
import {
  parseStateFile,
  readStateFile,
  StateFileUnwritableError,
  stateJsonSchema,
  writeStateFile,
} from "./file.ts";
import type { Migrations } from "./migrate.ts";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  stateSchema,
  statusSchema,
  type State,
} from "./schema.ts";

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
      { courseNumber: "89-214", academicYear: 2027, semester: "summer", status: "registered" },
      {
        courseNumber: "89-550",
        academicYear: 2025,
        semester: "spring",
        status: "credited",
        grade: { kind: "pass-fail", passed: false },
      },
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

/**
 * The round trip that matters is through JSON, because that is what reaches disk. Every
 * status and both kinds of grade are in here for that reason rather than in a loop over the
 * schema, which would never touch a file.
 */
it("reads back a State File whole, every status and both grades among it", () => {
  const result = parseStateFile(onDisk(fullFile()));

  expect(result.warnings).toEqual([]);
  expect(result.state).toEqual(fullFile());
  expect(new Set(result.state?.attempts.map((attempt) => attempt.status))).toEqual(
    new Set(statusSchema.options),
  );
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

/**
 * The JSON Schema export exists so a State File can be hand-edited, and a list of bare
 * strings where objects belong is what hand-editing gets wrong. No one field is to blame
 * then, so the Warning carries none rather than carrying an empty one for a UI to render as
 * a cause that reads blank.
 */
it("names the entry, and no field, when an entry is the wrong shape entirely", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    pins: ["general-english"],
    attempts: [5],
  });

  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "attempts[0]" },
    { kind: "entry-dropped", at: "pins[0]" },
  ]);
});

/**
 * `null` is not "no Attempts" — it is something a hand edit or another tool wrote. Read as
 * an empty list it would open as an empty Plan, and autosave would write `[]` back over the
 * file a few seconds later. The one shape that could lose everything, and quietly.
 */
it("refuses to read a list written as null as an empty one", () => {
  const result = parseStateFile({ schemaVersion: CURRENT_STATE_SCHEMA_VERSION, attempts: null });

  expect(result.state?.attempts).toEqual([]);
  expect(result.warnings).toEqual([{ kind: "list-unreadable", at: "attempts" }]);
});

/**
 * A Pick is one Group for one Lesson Type of an Offering within a Variant. Two of them for
 * the same pair describe a week that cannot be drawn: the grid inks both Groups while the
 * Tray chip holds one Group number.
 */
it("warns about two Picks for the same Lesson Type of a Course, and keeps both", () => {
  const meetings = [{ semester: "fall", day: "monday", start: "10:00", end: "12:00" }];
  const result = parseStateFile({
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
              { courseNumber: "89-110", lessonType: "הרצאה", groupNumber: "01", meetings },
              { courseNumber: "89-110", lessonType: "תרגיל", groupNumber: "01", meetings },
              { courseNumber: "89-110", lessonType: "הרצאה", groupNumber: "02", meetings },
            ],
          },
        ],
      },
    ],
  });

  expect(result.state?.timetables[0]?.variants[0]?.picks).toHaveLength(3);
  expect(result.warnings).toEqual([
    {
      kind: "pick-not-unique",
      at: "timetables[0].variants[0]",
      courseNumber: "89-110",
      lessonType: "הרצאה",
    },
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

/**
 * Settings are read one at a time, so a student reading Hebrew whose Exam spacing got
 * corrupted does not also find their language reset to English — which autosave would then
 * write back to the file as though they had chosen it.
 */
it("keeps the settings it can read and defaults only the one it cannot", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    settings: { language: "he", examSpacingDays: "five" },
  });

  expect(result.state?.settings).toEqual({ language: "he", examSpacingDays: 3 });
  expect(result.warnings).toEqual([{ kind: "settings-unreadable", field: "examSpacingDays" }]);
});

it("falls back to every default when settings are not settings at all", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    settings: "hebrew, three days",
  });

  expect(result.state?.settings).toEqual({ language: "en", examSpacingDays: 3 });
  expect(result.warnings).toEqual([{ kind: "settings-unreadable" }]);
});

it("strips a setting it does not know", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    settings: { language: "he", theme: "dark" },
  });

  expect(result.state?.settings).toEqual({ language: "he", examSpacingDays: 3 });
  expect(result.warnings).toEqual([]);
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
 * A Blocked Time lies within the one Day it names and never wraps, so `23:00`–`01:00` keeps no
 * time free at all rather than running into the next Day. The file keeps the entry; the Warning
 * is what stops it from quietly keeping no time free.
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

/**
 * The other half of that night shift, and the reason this check reads minutes rather than
 * comparing strings: as an `end`, `00:00` is the end of the Day, so `22:00`–`00:00` keeps the
 * evening free and is the correct spelling of it. A Warning on the right answer is how a
 * student learns to ignore all of them (issue #48).
 */
it("says nothing about a Blocked Time that runs to the end of the Day", () => {
  const evening = fullFile();
  evening.timetables[0]!.blockedTimes = [
    { semester: "fall", day: "sunday", start: "22:00", end: "00:00", label: "work" },
    { semester: "fall", day: "monday", start: "23:59", end: "00:00", label: "the last minute" },
    { semester: "fall", day: "tuesday", start: "00:00", end: "08:00", label: "the night" },
  ];

  const result = parseStateFile(onDisk(evening));

  expect(result.state?.timetables[0]?.blockedTimes).toEqual(evening.timetables[0]!.blockedTimes);
  expect(result.warnings).toEqual([]);
});

/**
 * Read from both ends of the same spelling, `00:00`–`00:00` is 0 to 1440: a Blocked Time over
 * the whole Day. It is drawn full height, which is hard to enter by accident and impossible to
 * miss, so it is taken at its word rather than warned about (issue #48).
 */
it("takes a Blocked Time of 00:00 to 00:00 as the whole Day, and says nothing", () => {
  const allDay = fullFile();
  allDay.timetables[0]!.blockedTimes = [
    { semester: "fall", day: "sunday", start: "00:00", end: "00:00", label: "reserve duty" },
  ];

  const result = parseStateFile(onDisk(allDay));

  expect(result.state?.timetables[0]?.blockedTimes).toEqual(allDay.timetables[0]!.blockedTimes);
  expect(result.warnings).toEqual([]);
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

/**
 * Untrusted input: whatever arrives, a Warning comes back rather than an exception. Deep
 * nesting is the shape that breaks a reader written the obvious way, and the reader is the
 * last thing that may break — losing a student's file to a stack overflow is not an option.
 */
it("refuses a file nested far deeper than a call stack, without throwing", () => {
  let json = '{"name":"deep"}';
  for (let level = 0; level < 50_000; level++) json = `{"variants":[${json}]}`;
  const deep = JSON.parse(`{"schemaVersion":1,"timetables":[${json}]}`) as unknown;

  const result = parseStateFile(deep);

  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "timetables[0]", field: "academicYear" },
  ]);
  expect(result.state?.timetables).toEqual([]);
});

/**
 * A Timetable is the weekly schedule work for one Semester of one Academic Year. A second one
 * for the same pair splits a student's Variants across two places nothing distinguishes.
 */
it("warns about a second Timetable for the same Semester, and keeps both", () => {
  const result = parseStateFile({
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    timetables: [
      { academicYear: 2027, semester: "fall" },
      { academicYear: 2027, semester: "spring" },
      { academicYear: 2027, semester: "fall" },
    ],
  });

  expect(result.state?.timetables).toHaveLength(3);
  expect(result.warnings).toEqual([
    {
      kind: "timetable-not-unique",
      at: "timetables[2]",
      academicYear: 2027,
      semester: "fall",
    },
  ]);
});

/**
 * The writer. A save is a value and nothing else — `core` performs no I/O — so these tests
 * produce one the way the app will: read a file, and hand back what came back.
 */

/** The State the reader makes of a file, which is the only thing the writer is ever given. */
function stateOf(file: unknown): State {
  const { state, warnings } = parseStateFile(onDisk(file));
  expect(warnings).toEqual([]);
  if (!state) throw new Error("the fixture did not read");
  return state;
}

/** A file that leans on every default the schema has: a version and nothing else. */
const BARE_FILE = { schemaVersion: CURRENT_STATE_SCHEMA_VERSION };

/**
 * The defaults that are not at the top of the file: a Timetable without `variants` or
 * `blockedTimes`, holding a Variant without `picks` or `primary`. A writer that recorded a
 * nested default differently from the way the reader fills it would grow the file one level
 * down, where `BARE_FILE` cannot see it.
 */
const NESTED_DEFAULTS_FILE = {
  schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
  timetables: [
    // a Timetable with neither list
    { academicYear: 2027, semester: "fall" },
    // and a Variant with no Picks yet. `primary` is spelled out rather than defaulted: a
    // Variant that leans on that default leaves its Timetable with no primary at all, which
    // the reader reports as a Warning of its own, so it cannot appear in a clean round trip.
    {
      academicYear: 2027,
      semester: "spring",
      variants: [{ name: "first week", primary: true }],
    },
  ],
};

it("writes a State File the reader reads back unchanged", () => {
  const state = stateOf(fullFile());

  const reread = parseStateFile(onDisk(writeStateFile(state, { basedOn: undefined }).json));

  expect(reread.warnings).toEqual([]);
  expect(reread.state).toEqual(state);
});

/**
 * A read fills the defaulted fields in, so a writer that recorded them differently from the
 * way it reads them would change the file on every save — a Workspace on Dropbox syncing a
 * file that never settles. The second save is compared as text because that is what grows.
 */
it.each([
  ["a file that is a version and nothing else", BARE_FILE, ["attempts", "timetables", "pins"]],
  [
    "a file whose Timetable and Variant lean on their own defaults",
    NESTED_DEFAULTS_FILE,
    ["variants", "picks", "blockedTimes"],
  ],
])("round-trips %s, and saves it the same way twice", (_what, file, defaulted) => {
  const first = writeStateFile(stateOf(file), { basedOn: undefined });
  const reread = parseStateFile(onDisk(first.json));

  expect(reread.warnings).toEqual([]);
  expect(reread.state).toEqual(stateOf(file));

  const second = writeStateFile(reread.state!, { basedOn: "a-first-save" });
  expect(JSON.stringify(second.json)).toBe(JSON.stringify(first.json));
  // The defaults the file left out are recorded, rather than left out again: the growth this
  // guards against is a save that writes them differently from the way the reader fills them.
  for (const field of defaulted) expect(JSON.stringify(first.json)).toContain(`"${field}"`);
});

it("writes the version this build reads, not the one the value arrived carrying", () => {
  const stale: State = { ...stateOf(fullFile()), schemaVersion: CURRENT_STATE_SCHEMA_VERSION - 1 };

  expect(writeStateFile(stale, { basedOn: undefined }).json["schemaVersion"]).toBe(
    CURRENT_STATE_SCHEMA_VERSION,
  );
});

/**
 * An old file opens, is edited, and is saved back — at the version this build writes. The
 * stamp itself is pinned by the test above, which hands the writer a stale version directly:
 * while there is only one schema version, a reader-produced State is already current because
 * `readState` stamps it, so this covers the path rather than the stamp. When a real version 2
 * lands, a fixture at version 1 makes it falsifiable and this is where it joins in.
 */
it("writes a file that migrated forward on the way in at the current version", () => {
  const chain: Migrations = {
    [pretendCurrent - 1]: (file) => ({
      schemaVersion: pretendCurrent,
      attempts: (file as { courses?: unknown }).courses,
    }),
  };
  const { state } = readStateFile(
    {
      schemaVersion: pretendCurrent - 1,
      courses: [
        { courseNumber: "89-110", academicYear: 2027, semester: "fall", status: "passed" },
      ],
    },
    chain,
  );

  const save = writeStateFile(state!, { basedOn: "the-old-file" });

  expect(save.json["schemaVersion"]).toBe(CURRENT_STATE_SCHEMA_VERSION);
  expect(parseStateFile(onDisk(save.json)).state?.attempts[0]?.courseNumber).toBe("89-110");
});

/**
 * ADR-0013: the save path is the undo path, so a save carries the version of the file it was
 * based on and the external-edit guard applies to an undo exactly as to a first-hand edit.
 * Enforcing the refusal is a later ticket; carrying the version is this one's job.
 */
it("carries the version of the file the save was based on", () => {
  const state = stateOf(fullFile());

  expect(writeStateFile(state, { basedOn: "a-version-of-the-file" })).toMatchObject({
    basedOn: "a-version-of-the-file",
  });
  // Nothing to be based on: the State File does not exist yet, and a file appearing where
  // the save expected none is the same breach as one that changed underneath it.
  expect(writeStateFile(state, { basedOn: undefined }).basedOn).toBeUndefined();
});

it("leaves out what the schema does not know, so it cannot write a file the reader refuses", () => {
  // Only a cast reaches here. `notes` is a hand edit or an older build's field; `__proto__`
  // is one of the three prototype-shaped keys the reader refuses a whole file for, so writing
  // it back would cost the student the file. `JSON.parse` is what makes it an own key at all.
  const meddled = JSON.parse(
    '{"schemaVersion":1,"attempts":[],"timetables":[],"pins":[],' +
      '"settings":{"language":"en","examSpacingDays":3},' +
      '"notes":"hand-edited","__proto__":{"isAdmin":true}}',
  ) as State;

  const save = writeStateFile(meddled, { basedOn: undefined });

  expect(Object.keys(save.json).sort()).toEqual([
    "attempts",
    "pins",
    "schemaVersion",
    "settings",
    "timetables",
  ]);
  expect(parseStateFile(onDisk(save.json)).warnings).toEqual([]);
});

/**
 * The reader is forgiving on purpose — one unreadable Pick costs a Pick, not the Variant
 * holding it — because a file is untrusted input. The writer has no such latitude: its input
 * is this app's own value, so a value the schema rejects is a bug here, and writing it would
 * silently cost the student whatever the next read then dropped.
 */
it("refuses a value the reader could not read back, naming the part that was wrong", () => {
  const broken = {
    ...stateOf(fullFile()),
    attempts: [{ courseNumber: "89-110" }],
  } as unknown as State;

  // Named rather than a bare Error, and carrying where it went wrong, so that whatever routes
  // a save can tell a bug in this build from a disk that would not take the file.
  expect(() => writeStateFile(broken, { basedOn: undefined })).toThrow(StateFileUnwritableError);
  try {
    writeStateFile(broken, { basedOn: undefined });
  } catch (error) {
    expect((error as StateFileUnwritableError).at).toBe("attempts.0.academicYear");
  }
});

/**
 * Autosave saves after a delay, so the value a save was made of must not keep changing while
 * it waits: what is written is what the state held when the writer was called.
 */
it("writes a value detached from the State it was made from", () => {
  const state = stateOf(fullFile());

  const save = writeStateFile(state, { basedOn: undefined });
  state.attempts.push({
    courseNumber: "89-999",
    academicYear: 2027,
    semester: "fall",
    status: "planned",
  });
  state.timetables[0]!.variants[0]!.name = "renamed after the save";

  expect(parseStateFile(onDisk(save.json)).state).toEqual(stateOf(fullFile()));
});
