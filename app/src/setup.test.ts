import { expect, it } from "vitest";
import { memoryWorkspace } from "./workspace.memory.ts";
import { createWorkspace, workspaceStatus } from "./setup.ts";
import { WorkspaceRefusedError, type Workspace } from "./workspace.ts";

it("reports a folder that is not a Workspace yet, without writing anything", async () => {
  const workspace = memoryWorkspace();

  const status = await workspaceStatus(workspace);

  expect(status).toEqual({ ready: false, missing: ["catalogs", "requirements", "backups"] });
  // nothing is written until the student accepts
  expect(workspace.written()).toEqual([]);
});

it("creates the layout and says what the folder is now", async () => {
  const workspace = memoryWorkspace();

  const created = await createWorkspace(workspace);

  expect(created).toEqual({ kind: "created", status: { ready: true, missing: [] } });
});

/**
 * A Workspace whose `create` refuses, and nothing else about it changed.
 *
 * Written here rather than as a knob on `memoryWorkspace`, for the reason that double gives
 * for having none: "a knob invented for one test is a behaviour of the double rather than of
 * the port". What is under test is `createWorkspace`'s handling of one documented refusal, so
 * the refusal is supplied at the call and the double stays the thing every other test shares.
 */
const refusing = (error: unknown): Workspace => ({
  ...memoryWorkspace(),
  async create(): Promise<void> {
    throw error;
  },
});

/**
 * #141. `create` has named its refusal since #121 and this use case caught nothing, so it left
 * `server/src/api.ts`'s POST route uncaught and became a 500 with no body of the app's own —
 * the answer to the first thing a student ever does. Reachable on a real folder whenever a part
 * of the layout is a plain file: `server/src/api.test.ts` asserts that case end to end, and
 * this one pins the answer the use case itself gives.
 */
it("answers a refused create rather than throwing it at the route", async () => {
  const workspace = refusing(
    new WorkspaceRefusedError(
      "refusing to create the Workspace layout: catalogs could not be made (EEXIST)",
    ),
  );

  const created = await createWorkspace(workspace);

  expect(created).toEqual({ kind: "refused", reason: "workspace-refused" });
});

/**
 * The catch is narrow on purpose. A blanket one would answer every bug in this app with a
 * sentence about the student's folder — a refusal claiming something the app does not know
 * (#111) — and would hide the bug behind a 409 the page renders as advice.
 */
it("lets an error that is not a refusal through, rather than blaming the folder", async () => {
  const bug = new TypeError("not a refusal");
  const workspace = refusing(bug);

  await expect(createWorkspace(workspace)).rejects.toBe(bug);
});
