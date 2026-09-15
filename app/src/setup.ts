import type { Workspace, WorkspaceStatus } from "./workspace.ts";

/**
 * What the app knows about the folder before it touches it. Reading the status never
 * writes: on first run the student is offered the layout and nothing is created until
 * they accept (docs/design.md, "Storage").
 */
export async function workspaceStatus(workspace: Workspace): Promise<WorkspaceStatus> {
  return workspace.status();
}

export async function createWorkspace(workspace: Workspace): Promise<WorkspaceStatus> {
  await workspace.create();
  return workspace.status();
}
