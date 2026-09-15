import { expect, it } from "vitest";
import { memoryWorkspace } from "./workspace.memory.ts";
import { createWorkspace, workspaceStatus } from "./setup.ts";

it("reports a folder that is not a Workspace yet, without writing anything", async () => {
  const workspace = memoryWorkspace();

  const status = await workspaceStatus(workspace);

  expect(status).toEqual({ ready: false, missing: ["catalogs", "requirements", "backups"] });
  // nothing is written until the student accepts
  expect(workspace.written()).toEqual([]);
});
