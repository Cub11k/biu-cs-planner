import { expect, it } from "vitest";
import { parseRequirementsFile, requirementsJsonSchema } from "./file.ts";
import { CURRENT_REQUIREMENTS_SCHEMA_VERSION, requirementsFileSchema } from "./schema.ts";

/** What actually reaches the reader: JSON, so every value has survived a round trip. */
function onDisk(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * A small file using every building block, every Pool kind and every Prerequisite kind, written
 * for this test. No real Requirements File ships with the code (ADR-0006).
 */
function fullFile() {
  return {
    schemaVersion: CURRENT_REQUIREMENTS_SCHEMA_VERSION,
    program: { id: "cs-single", name: { he: "מדעי המחשב", en: "Computer Science" } },
    cohorts: [{ academicYear: 2027, semester: "fall" }],
    policies: { passingGrade: 56, gradeAttempt: "latest" },
    pools: [
      { id: "advanced", kind: "range", department: "89", from: 300, to: 399 },
      { id: "seminars", kind: "list", courses: ["89-501", "89-502"], name: { he: "סמינרים" } },
      { id: "math", kind: "prefix", prefix: "88-" },
    ],
    courseSets: [{ id: "first-year", courses: ["89-110", "89-111"] }],
    courses: [
      { number: "89-110", credits: 5, offeringPattern: "fall", name: { he: "מבוא" } },
      {
        number: "89-111",
        credits: 4,
        offeringPattern: "spring",
        prerequisites: { kind: "passed", course: "89-110", minGrade: 70 },
      },
      {
        number: "89-210",
        credits: 4,
        offeringPattern: "year-long",
        prerequisites: {
          kind: "allOf",
          of: [
            { kind: "set", set: "first-year" },
            {
              kind: "anyOf",
              of: [
                { kind: "passed", course: "88-101", allowConcurrent: true },
                { kind: "manual", text: { he: "באישור המרצה", en: "Lecturer approval" } },
              ],
            },
          ],
        },
      },
    ],
    equivalences: [{ from: "89-109", to: "89-110" }],
    requirements: [
      { id: "intro", kind: "course", course: "89-110" },
      {
        id: "core",
        kind: "allOf",
        name: { he: "חובה" },
        of: [
          { id: "ds", kind: "course", course: "89-111" },
          {
            id: "two-of",
            kind: "nOf",
            n: 2,
            of: [
              { id: "algo", kind: "course", course: "89-210" },
              { id: "logic", kind: "course", course: "89-211" },
              { id: "theory", kind: "course", course: "89-212" },
            ],
          },
        ],
      },
      { id: "electives", kind: "credits", min: 12, pool: "advanced" },
      { id: "seminar-cap", kind: "cap", max: 4, pool: "seminars" },
      { id: "calc-overlap", kind: "exclusive", courses: ["88-101", "88-102"] },
      { id: "english", kind: "manual", text: { he: "אנגלית", en: "English" } },
    ],
    tracks: [
      {
        id: "ai",
        name: { he: "בינה מלאכותית", en: "AI" },
        requirements: [{ id: "ai-ml", kind: "course", course: "89-391" }],
      },
    ],
    doubleCounting: {
      within: [{ requirements: ["electives", "ai-ml"], pool: "advanced" }],
      acrossPrograms: { pool: "math" },
    },
    suggestedLayout: [{ studyYear: 1, semester: "fall", courses: ["89-110"] }],
    deadlines: [{ by: { studyYear: 1, semester: "spring" }, courses: ["89-110", "89-111"] }],
  };
}

/** The file with one part replaced, for the cases that break exactly that part. */
function withPart(part: string, value: unknown): Record<string, unknown> {
  return { ...fullFile(), [part]: value };
}

function minimalFile(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: CURRENT_REQUIREMENTS_SCHEMA_VERSION,
    program: { id: "p", name: { he: "תכנית" } },
    ...extra,
  };
}

it("reads back every building block, Pool kind and Prerequisite kind as written", () => {
  const result = parseRequirementsFile(onDisk(fullFile()));

  expect(result.warnings).toEqual([]);
  expect(result.file).toEqual(fullFile());
});

it("fills in what a minimal file leaves out, and says nothing about it", () => {
  const result = parseRequirementsFile(onDisk(minimalFile()));

  expect(result.warnings).toEqual([]);
  expect(result.file).toEqual({
    ...minimalFile(),
    cohorts: [],
    policies: { passingGrade: 60, gradeAttempt: "best" },
    pools: [],
    courseSets: [],
    courses: [],
    equivalences: [],
    requirements: [],
    tracks: [],
    doubleCounting: { within: [] },
    suggestedLayout: [],
    deadlines: [],
  });
});

it("refuses what is not a Requirements File at all, without throwing", () => {
  for (const notAFile of [null, "text", 42, [], {}, { nonsense: true }]) {
    expect(parseRequirementsFile(notAFile)).toEqual({ warnings: [{ kind: "file-unreadable" }] });
  }
});

it("refuses a file whose head is unreadable: no Program, or a Program without an id", () => {
  const { program: _program, ...headless } = fullFile();

  expect(parseRequirementsFile(onDisk(headless))).toEqual({
    warnings: [{ kind: "file-unreadable" }],
  });
  expect(parseRequirementsFile(onDisk(withPart("program", { name: { he: "x" } })))).toEqual({
    warnings: [{ kind: "file-unreadable" }],
  });
});

it("refuses a file written by a newer app, and one older than anything it reads", () => {
  expect(parseRequirementsFile(onDisk(withPart("schemaVersion", 99)))).toEqual({
    warnings: [{ kind: "schema-version-too-new", found: 99 }],
  });
  expect(parseRequirementsFile(onDisk(withPart("schemaVersion", 0)))).toEqual({
    warnings: [{ kind: "schema-version-unsupported", found: 0 }],
  });
});

it("refuses a file carrying a prototype-shaped key and names where it sits", () => {
  const poisoned = JSON.parse(
    '{"schemaVersion":1,"program":{"id":"p","name":{"he":"x"}},' +
      '"requirements":[{"id":"a","kind":"manual","text":{"he":"x"},"__proto__":{}}]}',
  );

  expect(parseRequirementsFile(poisoned)).toEqual({
    warnings: [{ kind: "unsafe-key", key: "__proto__", at: "requirements[0]" }],
  });
});

it("drops one unreadable Requirement, names it and the field, and keeps its siblings", () => {
  const file = minimalFile({
    requirements: [
      { id: "a", kind: "course", course: "89-110" },
      { id: "b", kind: "credits", min: "many", pool: "x" },
      { id: "c", kind: "manual", text: { he: "x" } },
    ],
    pools: [{ id: "x", kind: "prefix", prefix: "89-" }],
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "requirements[1]", field: "min" },
  ]);
  expect(result.file?.requirements.map((r) => r.id)).toEqual(["a", "c"]);
});

it("drops a Requirement of a kind the vocabulary does not have", () => {
  const file = minimalFile({
    requirements: [{ id: "a", kind: "someOf", of: [] }, { id: "b", kind: "manual", text: { he: "x" } }],
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "requirements[0]", field: "kind" },
  ]);
  expect(result.file?.requirements.map((r) => r.id)).toEqual(["b"]);
});

it("drops an entry that is not an object without blaming one field", () => {
  const result = parseRequirementsFile(onDisk(minimalFile({ requirements: ["intro"] })));

  expect(result.warnings).toEqual([{ kind: "entry-dropped", at: "requirements[0]" }]);
  expect(result.file?.requirements).toEqual([]);
});

it("drops an unreadable child deep in the tree and keeps the parent and the other children", () => {
  const file = minimalFile({
    requirements: [
      {
        id: "core",
        kind: "allOf",
        of: [
          { id: "ds", kind: "course", course: "89-111" },
          {
            id: "pick",
            kind: "nOf",
            n: 1,
            of: [{ kind: "course", course: "89-210" }, { id: "logic", kind: "course", course: "89-211" }],
          },
        ],
      },
    ],
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "requirements[0].of[1].of[0]", field: "id" },
  ]);
  expect(result.file?.requirements).toEqual([
    {
      id: "core",
      kind: "allOf",
      of: [
        { id: "ds", kind: "course", course: "89-111" },
        { id: "pick", kind: "nOf", n: 1, of: [{ id: "logic", kind: "course", course: "89-211" }] },
      ],
    },
  ]);
});

it("reports a list that is not a list and reads it as empty", () => {
  const result = parseRequirementsFile(
    onDisk(minimalFile({ requirements: { id: "a" }, pools: "all of them" })),
  );

  expect(result.warnings).toEqual(
    expect.arrayContaining([
      { kind: "list-unreadable", at: "requirements" },
      { kind: "list-unreadable", at: "pools" },
    ]),
  );
  expect(result.warnings).toHaveLength(2);
  expect(result.file?.requirements).toEqual([]);
  expect(result.file?.pools).toEqual([]);
});

it("reports a duplicate Requirement id, keeps the first and drops the later one", () => {
  const file = minimalFile({
    requirements: [
      { id: "intro", kind: "course", course: "89-110" },
      { id: "core", kind: "allOf", of: [{ id: "intro", kind: "course", course: "89-111" }] },
    ],
    tracks: [
      {
        id: "ai",
        name: { he: "x" },
        requirements: [{ id: "core", kind: "manual", text: { he: "x" } }],
      },
    ],
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    {
      kind: "duplicate-id",
      namespace: "requirement",
      id: "intro",
      at: "requirements[1].of[0]",
      first: "requirements[0]",
    },
    {
      kind: "duplicate-id",
      namespace: "requirement",
      id: "core",
      at: "tracks[0].requirements[0]",
      first: "requirements[1]",
    },
  ]);
  expect(result.file?.requirements).toEqual([
    { id: "intro", kind: "course", course: "89-110" },
    { id: "core", kind: "allOf", of: [] },
  ]);
  expect(result.file?.tracks[0]?.requirements).toEqual([]);
});

it("reports duplicate Pool, Course set, Track, Course and Equivalence entries, keeping the first", () => {
  const file = minimalFile({
    pools: [
      { id: "x", kind: "prefix", prefix: "89-" },
      { id: "x", kind: "prefix", prefix: "88-" },
    ],
    courseSets: [
      { id: "s", courses: ["89-110"] },
      { id: "s", courses: [] },
    ],
    tracks: [
      { id: "t", name: { he: "1" } },
      { id: "t", name: { he: "2" } },
    ],
    courses: [
      { number: "89-110", credits: 5 },
      { number: "89-110", credits: 3 },
    ],
    equivalences: [
      { from: "89-109", to: "89-110" },
      { from: "89-109", to: "89-111" },
    ],
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    { kind: "duplicate-id", namespace: "pool", id: "x", at: "pools[1]", first: "pools[0]" },
    {
      kind: "duplicate-id",
      namespace: "course-set",
      id: "s",
      at: "courseSets[1]",
      first: "courseSets[0]",
    },
    { kind: "duplicate-id", namespace: "course", id: "89-110", at: "courses[1]", first: "courses[0]" },
    {
      kind: "duplicate-id",
      namespace: "equivalence",
      id: "89-109",
      at: "equivalences[1]",
      first: "equivalences[0]",
    },
    { kind: "duplicate-id", namespace: "track", id: "t", at: "tracks[1]", first: "tracks[0]" },
  ]);
  expect(result.file?.pools).toEqual([{ id: "x", kind: "prefix", prefix: "89-" }]);
  expect(result.file?.courseSets).toEqual([{ id: "s", courses: ["89-110"] }]);
  expect(result.file?.tracks).toEqual([{ id: "t", name: { he: "1" }, requirements: [] }]);
  expect(result.file?.courses).toEqual([{ number: "89-110", credits: 5 }]);
  expect(result.file?.equivalences).toEqual([{ from: "89-109", to: "89-110" }]);
});

it("reports a reference to a Pool or a Course set that is not defined, and keeps the node", () => {
  const file = minimalFile({
    requirements: [
      { id: "electives", kind: "credits", min: 12, pool: "advanced" },
      { id: "core", kind: "allOf", of: [{ id: "cap", kind: "cap", max: 4, pool: "seminars" }] },
    ],
    courses: [
      {
        number: "89-210",
        credits: 4,
        prerequisites: { kind: "anyOf", of: [{ kind: "set", set: "first-year" }] },
      },
    ],
    doubleCounting: { within: [{ requirements: ["electives", "core"], pool: "nowhere" }] },
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    { kind: "unknown-pool", at: "requirements[0]", pool: "advanced" },
    { kind: "unknown-pool", at: "requirements[1].of[0]", pool: "seminars" },
    { kind: "unknown-course-set", at: "courses[0].prerequisites.of[0]", set: "first-year" },
    { kind: "unknown-pool", at: "doubleCounting.within[0]", pool: "nowhere" },
  ]);
  expect(result.file?.requirements[0]).toEqual({
    id: "electives",
    kind: "credits",
    min: 12,
    pool: "advanced",
  });
  expect(result.file?.courses[0]?.prerequisites).toEqual({
    kind: "anyOf",
    of: [{ kind: "set", set: "first-year" }],
  });
});

it("names a dangling reference where it was read, even after an earlier entry was dropped", () => {
  const file = minimalFile({
    requirements: [
      { id: "broken", kind: "credits" },
      { id: "core", kind: "allOf", of: [{ kind: "manual" }, { id: "c", kind: "cap", max: 4, pool: "x" }] },
    ],
    courses: [
      { credits: 4 },
      { number: "89-210", credits: 4, prerequisites: { kind: "set", set: "first-year" } },
    ],
    doubleCounting: { within: [{ requirements: [] }, { requirements: ["core", "ghost"] }] },
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual(
    expect.arrayContaining([
      { kind: "unknown-pool", at: "requirements[1].of[1]", pool: "x" },
      { kind: "unknown-course-set", at: "courses[1].prerequisites", set: "first-year" },
      { kind: "unknown-requirement", at: "doubleCounting.within[1]", id: "ghost" },
    ]),
  );
});

it("reports Equivalences that loop, once per loop, and keeps them", () => {
  const file = minimalFile({
    equivalences: [
      { from: "89-100", to: "89-101" },
      { from: "89-110", to: "89-111" },
      { from: "89-111", to: "89-110" },
      { from: "89-101", to: "89-102" },
    ],
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    { kind: "equivalence-loop", at: "equivalences[1]", course: "89-110" },
  ]);
  expect(result.file?.equivalences).toHaveLength(4);
});

it("reports a double-counting permission naming a Requirement that does not exist", () => {
  const file = minimalFile({
    requirements: [{ id: "a", kind: "manual", text: { he: "x" } }],
    doubleCounting: { within: [{ requirements: ["a", "ghost"] }] },
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    { kind: "unknown-requirement", at: "doubleCounting.within[0]", id: "ghost" },
  ]);
  expect(result.file?.doubleCounting.within).toEqual([{ requirements: ["a", "ghost"] }]);
});

it("reports a Course with no credits and keeps it", () => {
  const file = minimalFile({ courses: [{ number: "89-110", offeringPattern: "fall" }] });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    { kind: "course-credits-missing", at: "courses[0]", course: "89-110" },
  ]);
  expect(result.file?.courses).toEqual([{ number: "89-110", offeringPattern: "fall" }]);
});

it("drops an unreadable Prerequisite and keeps the Course that carries it", () => {
  const file = minimalFile({
    courses: [
      {
        number: "89-210",
        credits: 4,
        prerequisites: {
          kind: "allOf",
          of: [
            { kind: "passed", course: "89-110", minGrade: "seventy" },
            { kind: "passed", course: "89-111" },
          ],
        },
      },
      { number: "89-211", credits: 4, prerequisites: { kind: "eventually" } },
    ],
  });

  const result = parseRequirementsFile(onDisk(file));

  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "courses[0].prerequisites.of[0]", field: "minGrade" },
    { kind: "entry-dropped", at: "courses[1].prerequisites", field: "kind" },
  ]);
  expect(result.file?.courses).toEqual([
    {
      number: "89-210",
      credits: 4,
      prerequisites: { kind: "allOf", of: [{ kind: "passed", course: "89-111" }] },
    },
    { number: "89-211", credits: 4 },
  ]);
});

it("reads the policies one at a time, so one bad policy keeps its default alone", () => {
  const result = parseRequirementsFile(
    onDisk(minimalFile({ policies: { passingGrade: "sixty", gradeAttempt: "latest" } })),
  );

  expect(result.warnings).toEqual([
    { kind: "section-unreadable", at: "policies", field: "passingGrade" },
  ]);
  expect(result.file?.policies).toEqual({ passingGrade: 60, gradeAttempt: "latest" });
});

it("reads a policies or double-counting section that is not an object as its defaults", () => {
  const result = parseRequirementsFile(
    onDisk(minimalFile({ policies: [], doubleCounting: "always" })),
  );

  expect(result.warnings).toEqual([
    { kind: "section-unreadable", at: "policies" },
    { kind: "section-unreadable", at: "doubleCounting" },
  ]);
  expect(result.file?.policies).toEqual({ passingGrade: 60, gradeAttempt: "best" });
  expect(result.file?.doubleCounting).toEqual({ within: [] });
});

it("drops an unreadable double-counting permission and keeps the rest of the section", () => {
  const result = parseRequirementsFile(
    onDisk(
      minimalFile({
        requirements: [
          { id: "a", kind: "manual", text: { he: "x" } },
          { id: "b", kind: "manual", text: { he: "y" } },
        ],
        doubleCounting: {
          within: [{ requirements: ["a"] }, { requirements: ["a", "b"] }],
          acrossPrograms: { pool: 7 },
        },
      }),
    ),
  );

  expect(result.warnings).toEqual([
    { kind: "entry-dropped", at: "doubleCounting.within[0]", field: "requirements" },
    { kind: "section-unreadable", at: "doubleCounting", field: "acrossPrograms" },
  ]);
  expect(result.file?.doubleCounting).toEqual({ within: [{ requirements: ["a", "b"] }] });
});

it("stops reading a tree nested deeper than any real rule, and does not overflow the stack", () => {
  let node: Record<string, unknown> = { id: "leaf", kind: "manual", text: { he: "x" } };
  for (let depth = 0; depth < 20_000; depth++) node = { id: `n${depth}`, kind: "allOf", of: [node] };
  let prerequisite: Record<string, unknown> = { kind: "passed", course: "89-110" };
  for (let depth = 0; depth < 20_000; depth++) prerequisite = { kind: "anyOf", of: [prerequisite] };

  const result = parseRequirementsFile(
    minimalFile({ requirements: [node], courses: [{ number: "89-1", credits: 1, prerequisites: prerequisite }] }),
  );

  expect(result.warnings.map((w) => w.kind)).toEqual(["nested-too-deep", "nested-too-deep"]);
  expect(result.file?.requirements[0]?.id).toBe("n19999");
});

it("keeps a tree exactly as deep as the limit allows", () => {
  let node: Record<string, unknown> = { id: "leaf", kind: "manual", text: { he: "x" } };
  // 31 levels of allOf above the leaf: the leaf sits at depth 32, the deepest that is read.
  for (let depth = 0; depth < 31; depth++) node = { id: `n${depth}`, kind: "allOf", of: [node] };

  const kept = parseRequirementsFile(minimalFile({ requirements: [node] }));
  const deeper = parseRequirementsFile(
    minimalFile({ requirements: [{ id: "top", kind: "allOf", of: [node] }] }),
  );

  expect(kept.warnings).toEqual([]);
  expect(deeper.warnings.map((w) => w.kind)).toEqual(["nested-too-deep"]);
});

// --- JSON Schema --------------------------------------------------------------------------

/**
 * Enough of JSON Schema to check what `z.toJSONSchema` emits for this file: the keywords below
 * are every keyword it produced for the Requirements File schema, measured, and an unknown
 * keyword fails the test rather than being skipped, so a schema change that brings a new one in
 * is noticed instead of silently validated as anything.
 */
type JsonSchema = Record<string, unknown>;

const KNOWN_KEYWORDS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "type",
  "properties",
  "required",
  "items",
  "minItems",
  "minLength",
  "minimum",
  "maximum",
  "enum",
  "const",
  "oneOf",
  "default",
]);

function validates(root: JsonSchema, schema: JsonSchema, value: unknown): boolean {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) throw new Error(`unhandled JSON Schema keyword ${keyword}`);
  }
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/$defs/", "");
    return validates(root, (root.$defs as Record<string, JsonSchema>)[name]!, value);
  }
  if (Array.isArray(schema.oneOf)) {
    return (schema.oneOf as JsonSchema[]).filter((s) => validates(root, s, value)).length === 1;
  }
  if ("const" in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      for (const key of (schema.required as string[] | undefined) ?? []) {
        if (!(key in record)) return false;
      }
      const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
      return Object.entries(properties).every(
        ([key, sub]) => record[key] === undefined || validates(root, sub, record[key]),
      );
    }
    case "array":
      if (!Array.isArray(value)) return false;
      if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
      return value.every((item) => validates(root, schema.items as JsonSchema, item));
    case "string":
      if (typeof value !== "string") return false;
      return typeof schema.minLength !== "number" || value.length >= schema.minLength;
    case "integer":
    case "number":
      if (typeof value !== "number") return false;
      if (schema.type === "integer" && !Number.isInteger(value)) return false;
      if (typeof schema.minimum === "number" && value < schema.minimum) return false;
      return typeof schema.maximum !== "number" || value <= schema.maximum;
    case "boolean":
      return typeof value === "boolean";
    case undefined:
      return true;
    default:
      throw new Error(`unhandled JSON Schema type ${String(schema.type)}`);
  }
}

it("exports JSON Schema, so a hand-written Requirements File gets editor support", () => {
  const schema = requirementsJsonSchema();

  expect(schema).toMatchObject({
    type: "object",
    properties: { schemaVersion: { type: "number" }, program: { type: "object" } },
  });
  // Only the head is required: everything else has a default, and an editor should not flag
  // a file that leaves it out.
  expect(schema.required).toEqual(["schemaVersion", "program"]);
});

it("the JSON Schema accepts and rejects exactly what the Zod schema does", () => {
  const schema = requirementsJsonSchema();
  const fixtures: unknown[] = [
    fullFile(),
    minimalFile(),
    withPart("requirements", [{ id: "a", kind: "nOf", n: 1.5, of: [] }]),
    withPart("requirements", [{ id: "", kind: "course", course: "89-110" }]),
    withPart("requirements", [{ id: "a", kind: "allOf", of: [{ id: "b", kind: "credits", min: -1, pool: "advanced" }] }]),
    withPart("requirements", [{ id: "a", kind: "exclusive", courses: ["89-110"] }]),
    withPart("requirements", [{ id: "a", kind: "someOf", of: [] }]),
    withPart("pools", [{ id: "x", kind: "range", department: "89", from: "300", to: 399 }]),
    withPart("pools", [{ id: "x", kind: "prefix", prefix: "" }]),
    withPart("courses", [{ number: "89-1", prerequisites: { kind: "anyOf", of: [{ kind: "set" }] } }]),
    withPart("courses", [{ number: "89-1", offeringPattern: "summer" }]),
    withPart("policies", { gradeAttempt: "first" }),
    withPart("doubleCounting", { within: [{ requirements: ["one"] }] }),
    withPart("suggestedLayout", [{ studyYear: 0, semester: "fall", courses: [] }]),
    withPart("program", { id: "p", name: { en: "no Hebrew" } }),
    { program: { id: "p", name: { he: "x" } } },
  ];

  const verdicts = fixtures.map((fixture) => ({
    zod: requirementsFileSchema.safeParse(fixture).success,
    json: validates(schema, schema, onDisk(fixture)),
  }));

  expect(verdicts.map((v) => v.json)).toEqual(verdicts.map((v) => v.zod));
  // The fixtures exercise both answers, so agreeing is not agreeing to accept everything.
  expect(verdicts.map((v) => v.zod)).toEqual([true, true, ...fixtures.slice(2).map(() => false)]);
});
