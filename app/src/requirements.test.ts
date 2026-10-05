import { expect, it } from "vitest";
import {
  importRequirementsFile,
  listRequirementsFiles,
  loadRequirementsFiles,
} from "./requirements.ts";
import { memoryWorkspace } from "./workspace.memory.ts";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

/**
 * Requirements Files as a Workspace content type (#287), against the in-memory Workspace: listed
 * with what tells them apart, one with problems still listed with its Warnings, one that is not a
 * Requirements File reported by name, and imported the way a Raw Crawl is.
 *
 * The Programs and Tracks are invented; no Requirements File is committed to this repo (ADR-0006).
 */
const CS = {
  schemaVersion: 1,
  program: { id: "cs", name: { he: "מדעי המחשב", en: "Computer Science" } },
  cohorts: [{ academicYear: 2027, semester: "fall" }],
  courses: [{ number: "89-110", credits: 5 }],
  requirements: [{ id: "intro", kind: "course", course: "89-110" }],
  tracks: [{ id: "ai", name: { he: "בינה מלאכותית", en: "AI" }, requirements: [] }],
};

it("lists each Requirements File with its Program, Cohorts and Tracks", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "requirements", name: "cs-2027" }, CS);

  expect(await listRequirementsFiles(workspace)).toEqual({
    kind: "served",
    files: [
      {
        name: "cs-2027",
        status: "read",
        program: { id: "cs", name: { he: "מדעי המחשב", en: "Computer Science" } },
        cohorts: [{ academicYear: 2027, semester: "fall" }],
        tracks: [{ id: "ai", name: { he: "בינה מלאכותית", en: "AI" } }],
        warnings: [],
      },
    ],
  });
});

it("lists a file with problems, with its Warnings, rather than hiding it", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed(
    { kind: "requirements", name: "cs-2027" },
    { ...CS, requirements: [...CS.requirements, { id: "broken", kind: "credits" }] },
  );

  const listed = await listRequirementsFiles(workspace);

  expect(listed.kind === "served" && listed.files[0]).toMatchObject({
    name: "cs-2027",
    status: "read",
    warnings: [{ kind: "entry-dropped", at: "requirements[1]" }],
  });
});

it("reports a file that is not a Requirements File by name, saying why", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "requirements", name: "notes" }, { shopping: ["milk"] });
  workspace.seed({ kind: "requirements", name: "too-new" }, { ...CS, schemaVersion: 99 });

  expect(await listRequirementsFiles(workspace)).toEqual({
    kind: "served",
    files: [
      { name: "notes", status: "not-requirements", warnings: [{ kind: "file-unreadable" }] },
      {
        name: "too-new",
        status: "not-requirements",
        warnings: [{ kind: "schema-version-too-new", found: 99 }],
      },
    ],
  });
});

it("lists nothing for a Workspace with no Requirements Files", async () => {
  expect(await listRequirementsFiles(memoryWorkspace())).toEqual({ kind: "served", files: [] });
});

/** A Workspace whose port refuses in the ways the memory double cannot, injected per test. */
const refusing = (base: Workspace, refuse: { list?: boolean; read?: boolean }): Workspace => ({
  ...base,
  list: async (kind) => {
    if (refuse.list) {
      throw new WorkspaceRefusedError(
        { reason: "not-a-folder", subject: { kind: "folder", folder: "requirements" } },
        "refusing to list requirements/ at /home/someone/plans/requirements",
      );
    }
    return base.list(kind);
  },
  read: async (ref) => {
    if (refuse.read) {
      throw new WorkspaceRefusedError(
        { reason: "unreadable", subject: ref },
        "cannot read /home/someone/plans/requirements/cs-2027.json",
      );
    }
    return base.read(ref);
  },
});

it("answers a requirements/ that cannot be listed as a refusal, never as no files", async () => {
  const workspace = refusing(memoryWorkspace({ created: true }), { list: true });

  expect(await listRequirementsFiles(workspace)).toEqual({
    kind: "refused",
    reason: "workspace-refused",
  });
});

it("lists a file it may not read with app's own sentence, and no path", async () => {
  const base = memoryWorkspace({ created: true });
  base.seed({ kind: "requirements", name: "cs-2027" }, CS);

  const listed = await listRequirementsFiles(refusing(base, { read: true }));

  expect(listed).toEqual({
    kind: "served",
    files: [
      {
        name: "cs-2027",
        status: "refused",
        reason: 'refusing the Requirements File "cs-2027": it is there and cannot be read',
      },
    ],
  });
  expect(JSON.stringify(listed)).not.toContain("/home/someone");
});

it("hands back the parsed rules beside each readable file, for Progress to evaluate", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "requirements", name: "cs-2027" }, CS);

  const loaded = await loadRequirementsFiles(workspace);

  expect(loaded.kind === "served" && loaded.files[0]?.file?.program.id).toBe("cs");
});

it("imports a Requirements File under its name, as given, and lists it", async () => {
  const workspace = memoryWorkspace({ created: true });
  const given = { ...CS, maintainerNote: "kept as written" };

  const result = await importRequirementsFile(workspace, "cs-2027", given);

  expect(result).toMatchObject({ stored: true, replaced: false, listed: { name: "cs-2027" } });
  // stored as it was given, not as this build read it
  expect(await workspace.read({ kind: "requirements", name: "cs-2027" })).toEqual(given);
  expect(await listRequirementsFiles(workspace)).toMatchObject({
    files: [{ name: "cs-2027", status: "read" }],
  });
});

it("replaces a file of the same name, and says so", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "requirements", name: "cs-2027" }, CS);

  const reissued = { ...CS, tracks: [] };
  const result = await importRequirementsFile(workspace, "cs-2027", reissued);

  expect(result).toMatchObject({ stored: true, replaced: true });
  expect(await workspace.read({ kind: "requirements", name: "cs-2027" })).toEqual(reissued);
});

it("refuses to import a file that is not a Requirements File, and stores nothing", async () => {
  const workspace = memoryWorkspace({ created: true });

  const result = await importRequirementsFile(workspace, "notes", { shopping: [] });

  expect(result).toEqual({
    stored: false,
    reason: "not-requirements",
    warnings: [{ kind: "file-unreadable" }],
  });
  expect(workspace.written()).toEqual([]);
});

it("refuses to import into a folder that is not a Workspace yet", async () => {
  const workspace = memoryWorkspace();

  expect(await importRequirementsFile(workspace, "cs-2027", CS)).toEqual({
    stored: false,
    reason: "workspace-not-ready",
  });
  expect(workspace.written()).toEqual([]);
});

it("answers a name that is a path as the Workspace's refusal, and stores nothing", async () => {
  const workspace = memoryWorkspace({ created: true });

  expect(await importRequirementsFile(workspace, "../alice.state", CS)).toEqual({
    stored: false,
    reason: "workspace-refused",
  });
  expect(workspace.written()).toEqual([]);
});
