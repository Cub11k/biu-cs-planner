import { describe, expect, it } from "vitest";
import { degradingReads, strictReads } from "./reads.ts";
import { memoryWorkspace } from "./workspace.memory.ts";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

/**
 * The two adapters for the reads a view makes (#374). Strict answers the Workspace's refusal and
 * lets anything else propagate; degrading never throws, because it answers an edit that landed.
 */
const refusal = () =>
  new WorkspaceRefusedError({ reason: "not-a-folder", subject: { kind: "folder", folder: "requirements" } }, "no");

/** A Workspace whose Catalog read and `requirements/` listing both throw `error()`. */
const throwing = (error: () => Error): Workspace => ({
  ...memoryWorkspace({ created: true }),
  read: async () => {
    throw error();
  },
  list: async () => {
    throw error();
  },
});

describe("the strict reads", () => {
  it("let an error that is not the Workspace's refusal propagate", async () => {
    const reads = strictReads(throwing(() => new Error("the disk is failing")));

    await expect(reads.requirementsFiles()).rejects.toThrow("the disk is failing");
    await expect(reads.yearOfferings(2027)).rejects.toThrow("the disk is failing");
  });

  it("answer the Workspace's refusal as an unlisted folder and no Catalog", async () => {
    const reads = strictReads(throwing(refusal));

    expect(await reads.requirementsFiles()).toEqual({ kind: "refused", reason: "workspace-refused" });
    expect(await reads.yearOfferings(2027)).toBeUndefined();
  });
});

describe("the degrading reads", () => {
  it("answer a throwing Catalog read and a throwing listing without throwing", async () => {
    const reads = degradingReads(throwing(() => new Error("the disk is failing")));

    expect(await reads.requirementsFiles()).toEqual({ kind: "refused", reason: "workspace-refused" });
    expect(await reads.yearOfferings(2027)).toBeUndefined();
  });

  it("read what is there as the strict reads do", async () => {
    const reads = degradingReads(memoryWorkspace({ created: true }));

    expect(await reads.requirementsFiles()).toEqual({ kind: "served", files: [] });
    expect(await reads.yearOfferings(2027)).toBeUndefined();
  });
});
