import { expect, it } from "vitest";
import { wordRefusal } from "./refusal.ts";
import type {
  CatalogRef,
  WorkspaceRefusal,
  WorkspaceRefusalReason,
  WorkspaceRefusalSubject,
} from "./workspace.ts";

const CATALOG_2027: CatalogRef = { kind: "catalog", academicYear: 2027 };
const ALICE: WorkspaceRefusalSubject = { kind: "state", name: "alice" };

/**
 * The sentence for each reason, about the Catalog the query asked for. One case per reason, and
 * the count is asserted, so a reason added to the port without a case here fails rather than
 * shrinking what this covers — `BECAUSE` being total already makes it fail to compile without
 * words, and this is what pins which words.
 */
const SENTENCES: Record<WorkspaceRefusalReason, string> = {
  "outside-workspace": "it resolves outside the Workspace",
  unreadable: "it is there and cannot be read",
  "not-a-folder": "it is there and is not a folder",
  unwritable: "it could not be written",
  "not-a-workspace": "the Workspace Layout is not there to write into",
  "not-created": "it could not be made",
  "not-json": "it is not a kind of file a Workspace holds",
  "not-a-name": "a file's name in a Workspace is a name, never a path",
  "not-a-year": "an Academic Year is a whole number",
  "not-a-moment": "a snapshot's moment is a whole number of milliseconds",
  "not-a-catalog": "only a Catalog or a Requirements File is read or written whole, and this is neither",
  "mixed-snapshots": "snapshots are pruned one State File at a time",
};

it("words every reason the port has, about the Catalog it was asked for", () => {
  expect(Object.keys(SENTENCES)).toHaveLength(12);
  for (const [reason, because] of Object.entries(SENTENCES)) {
    expect(
      wordRefusal(
        { reason: reason as WorkspaceRefusalReason, subject: CATALOG_2027 },
        CATALOG_2027,
      ),
    ).toBe(`refusing the Catalog for the Academic Year 2027: ${because}`);
  }
});

/**
 * Criterion 3 of #249: the page can still say which Catalog, which Academic Year and which State
 * File a refusal was about. Every subject the port has, said in the domain's words.
 */
it("says which Catalog, State File, snapshot or folder a refusal was about", () => {
  const word = (subject: WorkspaceRefusalSubject) =>
    wordRefusal({ reason: "unreadable", subject }, subject);

  expect(word(CATALOG_2027)).toBe(
    "refusing the Catalog for the Academic Year 2027: it is there and cannot be read",
  );
  expect(word(ALICE)).toBe('refusing the State File "alice": it is there and cannot be read');
  expect(word({ kind: "backup", name: "alice", takenAt: Date.UTC(2026, 9, 5, 8, 30) })).toBe(
    'refusing the snapshot of the State File "alice" taken at 2026-10-05T08:30:00.000Z: ' +
      "it is there and cannot be read",
  );
  expect(word({ kind: "folder", folder: "catalogs" })).toBe(
    "refusing the folder holding the Workspace's Catalogs: it is there and cannot be read",
  );
  expect(word({ kind: "folder", folder: "requirements" })).toBe(
    "refusing the folder holding the Workspace's Requirements Files: it is there and cannot be read",
  );
  expect(word({ kind: "folder", folder: "backups" })).toBe(
    "refusing the folder holding the Workspace's snapshots: it is there and cannot be read",
  );
  expect(word({ kind: "workspace" })).toBe(
    "refusing the Workspace: it is there and cannot be read",
  );
});

/**
 * A refusal is very often *about* a value that is not safe to repeat: `not-a-name` is raised for a
 * name that is a path, and `not-a-year` for a year that is one. The sentence says the value only
 * once it has checked it, and describes it without the value otherwise.
 */
it("never repeats a name, year or moment it has not checked", () => {
  const path = "../../home/alice/.ssh/id_rsa";
  const name: WorkspaceRefusalSubject = { kind: "state", name: path };
  expect(wordRefusal({ reason: "not-a-name", subject: name }, name)).toBe(
    "refusing a State File whose name is not one: a file's name in a Workspace is a name, never a path",
  );

  // and a Requirements File's name the same way (#287)
  const requirements: WorkspaceRefusalSubject = { kind: "requirements", name: path };
  expect(wordRefusal({ reason: "not-a-name", subject: requirements }, requirements)).toBe(
    "refusing a Requirements File whose name is not one: a file's name in a Workspace is a name, never a path",
  );

  const year = { kind: "catalog", academicYear: path } as unknown as CatalogRef;
  expect(wordRefusal({ reason: "not-a-year", subject: year }, year)).toBe(
    "refusing a Catalog whose Academic Year is not one: an Academic Year is a whole number",
  );

  const fractional: CatalogRef = { kind: "catalog", academicYear: 2027.5 };
  expect(wordRefusal({ reason: "not-a-year", subject: fractional }, fractional)).toMatch(
    /^refusing a Catalog whose Academic Year is not one/,
  );

  for (const takenAt of [Number.NaN, 1.5, 9e15, Number.MAX_SAFE_INTEGER]) {
    const snapshot: WorkspaceRefusalSubject = { kind: "backup", name: path, takenAt };
    const sentence = wordRefusal({ reason: "not-a-moment", subject: snapshot }, snapshot);
    expect(sentence, String(takenAt)).toBe(
      "refusing the snapshot of a State File whose name is not one taken at a moment that is not " +
        "one: a snapshot's moment is a whole number of milliseconds",
    );
  }
});

/**
 * The structural half of #249's first criterion. A name that passes `isStateFileName` is still
 * free text, so an adapter answering a Catalog read with a refusal "about" a State File it made up
 * would have a channel one sentence long. The file that is said is the one `app` asked about.
 */
it("says the file it asked about, never another file an adapter names", () => {
  const smuggled: WorkspaceRefusal = {
    reason: "unreadable",
    subject: { kind: "state", name: "this-is-whatever-the-adapter-wanted-to-say" },
  };
  expect(wordRefusal(smuggled, CATALOG_2027)).toBe(
    "refusing the Catalog for the Academic Year 2027: it is there and cannot be read",
  );

  // another year is another file, and so is a snapshot of the right name at another moment
  expect(
    wordRefusal(
      { reason: "unreadable", subject: { kind: "catalog", academicYear: 1999 } },
      CATALOG_2027,
    ),
  ).toMatch(/Academic Year 2027/);
  const held: WorkspaceRefusalSubject = { kind: "backup", name: "alice", takenAt: 0 };
  expect(
    wordRefusal(
      { reason: "unreadable", subject: { kind: "backup", name: "alice", takenAt: 1 } },
      held,
    ),
  ).toMatch(/taken at 1970-01-01T00:00:00\.000Z/);
  expect(
    wordRefusal({ reason: "unreadable", subject: { kind: "state", name: "bob" } }, ALICE),
  ).toMatch(/"alice"/);

  // a folder or the Workspace as a whole carries nothing but a member of a closed set, so it is
  // said as the adapter gave it: which folder was wrong is the news
  expect(
    wordRefusal(
      { reason: "not-a-folder", subject: { kind: "folder", folder: "catalogs" } },
      CATALOG_2027,
    ),
  ).toBe("refusing the folder holding the Workspace's Catalogs: it is there and is not a folder");
});

/**
 * What a cast, or an adapter written against an older port, can hand over. The type says none of
 * this happens, and the type is what a cast gets past — which is the hole #249 closes. Each comes
 * back as a sentence made only of this module's words.
 */
it("says only its own words whatever shape the refusal arrives in", () => {
  const path = "/home/alice/Workspace/catalogs/2027.json";
  const hostile: unknown[] = [
    undefined,
    null,
    path,
    {},
    { reason: path, subject: CATALOG_2027 },
    { reason: "constructor", subject: CATALOG_2027 },
    { reason: "toString", subject: CATALOG_2027 },
    { reason: "unreadable", subject: path },
    { reason: "unreadable", subject: { kind: path } },
    { reason: "unreadable", subject: { kind: "folder", folder: path } },
    { reason: "unreadable", subject: { kind: "folder", folder: "constructor" } },
    { reason: "unreadable", subject: null },
  ];
  for (const refusal of hostile) {
    const sentence = wordRefusal(refusal as WorkspaceRefusal, CATALOG_2027);
    expect(sentence, JSON.stringify(refusal)).not.toContain(path);
    expect(sentence, JSON.stringify(refusal)).not.toContain("function");
    expect(sentence, JSON.stringify(refusal)).toMatch(/^refusing [^:]+: [^:]+$/);
  }
  expect(wordRefusal({ reason: path, subject: CATALOG_2027 } as never, CATALOG_2027)).toBe(
    "refusing the Catalog for the Academic Year 2027: the Workspace would not touch it",
  );
  expect(
    wordRefusal(
      { reason: "unreadable", subject: { kind: "folder", folder: path } } as never,
      CATALOG_2027,
    ),
  ).toBe("refusing a folder of the Workspace: it is there and cannot be read");
});

/**
 * Found by review on PR #280: a subject with getters answered the check with one value and the
 * sentence with another, so a year read three times said a path on its third read, and a moment
 * that flipped out of range made `toISOString` throw — a 500 where a Warning belongs. Every field
 * is read once now, nothing the adapter supplies is said, and a read that throws is the fallback.
 */
it("cannot be talked into a value by a refusal whose fields change as they are read", () => {
  const path = "/home/alice/Workspace/catalogs/2027.json";
  let reads = 0;
  const flipping = {
    get kind() {
      reads += 1;
      return reads === 1 ? "catalog" : "backup";
    },
    get academicYear() {
      reads += 1;
      return reads >= 3 ? path : 2027;
    },
    name: "alice",
    get takenAt() {
      return 1e20;
    },
  };
  const sentence = wordRefusal({ reason: "unreadable", subject: flipping } as never, CATALOG_2027);
  expect(sentence).toBe(
    "refusing the Catalog for the Academic Year 2027: it is there and cannot be read",
  );

  // a refusal whose every read throws is still a sentence, not a crashed request
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error(path);
      },
    },
  );
  expect(wordRefusal(throwing as never, CATALOG_2027)).toBe(
    "refusing the Catalog for the Academic Year 2027: the Workspace would not touch it",
  );
  expect(wordRefusal({ reason: "unreadable", subject: throwing } as never, CATALOG_2027)).toBe(
    "refusing the Catalog for the Academic Year 2027: it is there and cannot be read",
  );
});
