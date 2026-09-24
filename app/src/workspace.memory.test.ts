import { expect, it } from "vitest";
import { memoryWorkspace } from "./workspace.memory.ts";
import { StateFileChangedError, WorkspaceRefusedError } from "./workspace.ts";

/** A save based on no file, which is the claim that the file is not there yet. */
const firstSave = (data: unknown) => ({ json: data as Record<string, unknown>, basedOn: undefined });

/**
 * The double stands in for the real adapter in every use-case test, so what it refuses and
 * what it lists have to match `server/src/workspace.fs.ts`. Where they differ, a use-case
 * test proves the double's behaviour and the app breaks on a disk.
 */

const CATALOG = { schemaVersion: 1, academicYear: 2027, sources: [], offerings: [] };
const STATE = { schemaVersion: 1 };

it("lists what it holds, by kind, and keeps the two kinds apart", async () => {
  const workspace = memoryWorkspace({ created: true });

  await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);
  workspace.seed({ kind: "catalog", academicYear: 2026 }, CATALOG);
  await workspace.saveStateFile({ kind: "state", name: "bob" }, firstSave(STATE));
  workspace.seed({ kind: "state", name: "alice" }, STATE);

  expect(await workspace.list("catalog")).toEqual([
    { kind: "catalog", academicYear: 2026 },
    { kind: "catalog", academicYear: 2027 },
  ]);
  expect(await workspace.list("state")).toEqual([
    { kind: "state", name: "alice" },
    { kind: "state", name: "bob" },
  ]);
});

it("forgets a file that was taken away from outside", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed({ kind: "state", name: "alice" }, STATE);

  workspace.remove({ kind: "state", name: "alice" });

  expect(await workspace.list("state")).toEqual([]);
  expect(await workspace.readStateFile({ kind: "state", name: "alice" })).toBeUndefined();
});

/** The same refusal the real adapter makes, so a use case cannot pass here and fail there. */
it("refuses a State File whose name is a path rather than a name", async () => {
  const workspace = memoryWorkspace({ created: true });

  for (const name of ["../escaped", "sub/alice", "", ".hidden"]) {
    await expect(workspace.readStateFile({ kind: "state", name })).rejects.toThrow(
      WorkspaceRefusedError,
    );
    await expect(workspace.saveStateFile({ kind: "state", name }, firstSave(STATE))).rejects.toThrow(
      WorkspaceRefusedError,
    );
  }
  expect(workspace.written()).toEqual([]);
});

/**
 * A file holds JSON, whoever the adapter is. The double stores what JSON can express and
 * hands back a copy, so a use case cannot pass here by writing a value a disk would refuse,
 * or by mutating a "file" after writing it.
 */
it("refuses a value JSON cannot express, as a disk does", async () => {
  const workspace = memoryWorkspace({ created: true });

  await expect(
    workspace.saveStateFile({ kind: "state", name: "alice" }, firstSave({ schemaVersion: 1n })),
  ).rejects.toThrow();

  expect(await workspace.readStateFile({ kind: "state", name: "alice" })).toBeUndefined();
});

it("hands back a copy, so what was written cannot change afterwards", async () => {
  const workspace = memoryWorkspace({ created: true });
  const state = { schemaVersion: 1, pins: [] as string[] };

  await workspace.saveStateFile({ kind: "state", name: "alice" }, firstSave(state));
  state.pins.push("added after the save");

  expect((await workspace.readStateFile({ kind: "state", name: "alice" }))?.data).toEqual({
    schemaVersion: 1,
    pins: [],
  });
});

/**
 * #113, in the double, because a use case that reached `write` with a State File has to fail
 * here as it fails on a disk. The narrowing to a `CatalogRef` is type-only and both adapters
 * can still name a State File, so both make the refusal at runtime — through the one function
 * in the port, so both make it in the same words (`server/src/workspace.fs.test.ts` asserts
 * the same message).
 */
it("refuses a whole-file write of a State File, cast past the narrowing", async () => {
  const workspace = memoryWorkspace({ created: true });
  const alice = { kind: "state", name: "alice" } as const;
  workspace.seed(alice, STATE);

  const write = workspace.write as unknown as (ref: unknown, data: unknown) => Promise<void>;
  await expect(write(alice, { schemaVersion: 2 })).rejects.toThrow(
    /refusing the State File "alice" here/,
  );

  // nothing written, and what the file held is untouched
  expect(workspace.written()).toEqual([]);
  expect((await workspace.readStateFile(alice))?.data).toEqual(STATE);
});

/**
 * Refused because of the ref and not because of the folder, which is the order the real adapter
 * asks in: a double that answered this with the layout error would send a caller looking at the
 * wrong thing, and a double that answered it with a conflict worse still.
 */
it("refuses a cast whole-file write of a State File before it looks at the layout", async () => {
  const workspace = memoryWorkspace();

  const write = workspace.write as unknown as (ref: unknown, data: unknown) => Promise<void>;
  await expect(write({ kind: "state", name: "alice" }, STATE)).rejects.toThrow(
    /refusing the State File "alice" here/,
  );
  expect(workspace.written()).toEqual([]);
});

/** And the read, in the same words: content with no revision is content nothing can save. */
it("refuses a whole-file read of a State File", async () => {
  const workspace = memoryWorkspace({ created: true });
  const alice = { kind: "state", name: "alice" } as const;
  workspace.seed(alice, STATE);

  const read = workspace.read as unknown as (ref: unknown) => Promise<unknown>;
  await expect(read(alice)).rejects.toThrow(WorkspaceRefusedError);
  await expect(read(alice)).rejects.toThrow(/refusing the State File "alice" here/);
});

/** The real adapter refuses this, and a double that did not would prove a save that fails. */
it("refuses a write before the layout exists", async () => {
  const workspace = memoryWorkspace();

  await expect(
    workspace.saveStateFile({ kind: "state", name: "alice" }, firstSave(STATE)),
  ).rejects.toThrow(/layout does not exist/);
  expect(workspace.written()).toEqual([]);
});

/**
 * The half of the external-edit guard the double has to stand in for. Everything below is
 * `server/src/workspace.fs.test.ts` said again without a disk, on purpose: the use-case
 * tests run against this double, so a guard it did not make would be a guard the app looks
 * like it has and does not (#90).
 */
it("hands a revision back with what a State File holds, and takes it back on the save", async () => {
  const workspace = memoryWorkspace({ created: true });
  const alice = { kind: "state", name: "alice" } as const;

  const written = await workspace.saveStateFile(alice, firstSave(STATE));

  const held = await workspace.readStateFile(alice);
  expect(held?.data).toEqual(STATE);
  expect(held?.version).toBe(written);
  // and saving on the strength of that revision goes through
  await expect(
    workspace.saveStateFile(alice, { json: { schemaVersion: 1, pins: [] }, basedOn: held!.version }),
  ).resolves.toEqual(expect.any(String));
});

it("refuses a save based on a revision the file no longer holds", async () => {
  const workspace = memoryWorkspace({ created: true });
  const alice = { kind: "state", name: "alice" } as const;
  await workspace.saveStateFile(alice, firstSave(STATE));
  const stale = (await workspace.readStateFile(alice))!.version;
  // somebody else writes the file: Dropbox, git, an editor, or the other tab
  workspace.seed(alice, { schemaVersion: 1, pins: ["from outside"] });

  const refused = workspace.saveStateFile(alice, { json: { schemaVersion: 1 }, basedOn: stale });

  await expect(refused).rejects.toThrow(StateFileChangedError);
  // and the other writer's file is still there, whole
  expect((await workspace.readStateFile(alice))?.data).toEqual({
    schemaVersion: 1,
    pins: ["from outside"],
  });
  expect(workspace.written()).toEqual([alice]);
});

/**
 * `basedOn: undefined` is the claim that there is no file, so it is guarded like any other
 * revision rather than being the one argument that skips the guard (#80 shipped passing it
 * because nothing could produce anything else).
 */
it("refuses a save based on no file when a file is already there", async () => {
  const workspace = memoryWorkspace({ created: true });
  const alice = { kind: "state", name: "alice" } as const;
  workspace.seed(alice, STATE);

  await expect(workspace.saveStateFile(alice, firstSave({ schemaVersion: 1 }))).rejects.toThrow(
    StateFileChangedError,
  );
});

/**
 * The property the choice of a content revision buys, said in the double as well as in the
 * adapter: what identifies a revision is the content, so a writer that rewrote the file with
 * the same content refuses nothing.
 */
it("does not refuse when the file was rewritten with identical content", async () => {
  const workspace = memoryWorkspace({ created: true });
  const alice = { kind: "state", name: "alice" } as const;
  await workspace.saveStateFile(alice, firstSave(STATE));
  const version = (await workspace.readStateFile(alice))!.version;

  workspace.seed(alice, { ...STATE });

  await expect(
    workspace.saveStateFile(alice, { json: { schemaVersion: 1 }, basedOn: version }),
  ).resolves.toEqual(expect.any(String));
});

/** A conflict is not a target the Workspace will not touch, and must not read as one. */
it("keeps a conflict apart from a refusal about the target itself", async () => {
  const workspace = memoryWorkspace({ created: true });
  const alice = { kind: "state", name: "alice" } as const;
  workspace.seed(alice, STATE);

  const error = await workspace
    .saveStateFile(alice, firstSave({ schemaVersion: 1 }))
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(StateFileChangedError);
  expect(error).not.toBeInstanceOf(WorkspaceRefusedError);
  expect((error as StateFileChangedError).basedOn).toBeUndefined();
  expect((error as StateFileChangedError).found).toEqual(expect.any(String));
});
