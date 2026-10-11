import { expect, it } from "vitest";
import { workspaceContract } from "./workspace.contract.ts";
import { memoryWorkspace } from "./workspace.memory.ts";

/**
 * The double stands in for the real adapter in every use-case test, so what it refuses and
 * what it lists have to match `server/src/workspace.fs.ts`. Where they differ, a use-case
 * test proves the double's behaviour and the app breaks on a disk. So the port's interface is
 * one suite both adapters run (#384), and what is left below is only what needs the double's
 * own hands: a file taken away from outside, and a count of watcher events exact enough to say
 * a snapshot was not one of them.
 */
workspaceContract("memoryWorkspace", ({ created, now }) => ({
  workspace: memoryWorkspace({ created, now }),
}));

const STATE = { schemaVersion: 1 };
const ALICE = { kind: "state", name: "alice" } as const;

/** A save based on no file, which is the claim that the file is not there yet. */
const firstSave = (data: unknown) => ({ json: data as Record<string, unknown>, basedOn: undefined });

it("forgets a file that was taken away from outside", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed(ALICE, STATE);

  workspace.remove(ALICE);

  expect(await workspace.list("state")).toEqual([]);
  expect(await workspace.readStateFile(ALICE)).toBeUndefined();
});

/**
 * A snapshot moves no change count, which binds #67 to the watcher ruling (#88): `.backups/`
 * is the one folder the real adapter does not watch, because nothing in it is ever shown, so
 * once autosave lands its snapshots would otherwise be a page reload each. The *save* is
 * reported, exactly as it always was — one event and not two. The contract asserts the save is
 * heard; only this double counts its events exactly, so the "not two" is said here.
 */
it("reports the save and not the snapshot it took", async () => {
  let at = Date.UTC(2026, 9, 7, 12, 0, 0, 0);
  const workspace = memoryWorkspace({ created: true, now: () => at });
  const first = await workspace.saveStateFile(ALICE, firstSave(STATE));

  let heard = 0;
  await workspace.watch(() => void heard++);
  at += 1000;
  await workspace.saveStateFile(ALICE, { json: { schemaVersion: 1, pins: [] }, basedOn: first });

  expect(await workspace.listBackups(ALICE)).toHaveLength(1);
  expect(heard).toBe(1);
});
