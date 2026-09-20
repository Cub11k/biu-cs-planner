import { expect, it } from "vitest";
import { memoryWorkspace } from "./workspace.memory.ts";
import { WorkspaceRefusedError } from "./workspace.ts";

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
  await workspace.write({ kind: "state", name: "bob" }, STATE);
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
  expect(await workspace.read({ kind: "state", name: "alice" })).toBeUndefined();
});

/** The same refusal the real adapter makes, so a use case cannot pass here and fail there. */
it("refuses a State File whose name is a path rather than a name", async () => {
  const workspace = memoryWorkspace({ created: true });

  for (const name of ["../escaped", "sub/alice", "", ".hidden"]) {
    await expect(workspace.read({ kind: "state", name })).rejects.toThrow(WorkspaceRefusedError);
    await expect(workspace.write({ kind: "state", name }, STATE)).rejects.toThrow(
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
    workspace.write({ kind: "state", name: "alice" }, { schemaVersion: 1n }),
  ).rejects.toThrow();

  expect(await workspace.read({ kind: "state", name: "alice" })).toBeUndefined();
});

it("hands back a copy, so what was written cannot change afterwards", async () => {
  const workspace = memoryWorkspace({ created: true });
  const state = { schemaVersion: 1, pins: [] as string[] };

  await workspace.write({ kind: "state", name: "alice" }, state);
  state.pins.push("added after the save");

  expect(await workspace.read({ kind: "state", name: "alice" })).toEqual({
    schemaVersion: 1,
    pins: [],
  });
});

/** The real adapter refuses this, and a double that did not would prove a save that fails. */
it("refuses a write before the layout exists", async () => {
  const workspace = memoryWorkspace();

  await expect(workspace.write({ kind: "state", name: "alice" }, STATE)).rejects.toThrow(
    /layout does not exist/,
  );
  expect(workspace.written()).toEqual([]);
});
