export { createWorkspace, workspaceStatus } from "./setup.ts";
export { importCrawl, type ImportResult } from "./catalog.ts";
export {
  watchWorkspace,
  DEFAULT_SETTLE_MS,
  type Schedule,
  type WorkspaceChanges,
  type WorkspaceChangesOptions,
} from "./changes.ts";
export {
  getOffering,
  listOfferings,
  type ListResult,
  type OfferingResult,
  type QueryWarning,
} from "./queries.ts";
export {
  WORKSPACE_LAYOUT,
  WorkspaceRefusedError,
  type CatalogRef,
  type Workspace,
  type WorkspaceFolder,
  type WorkspaceChanged,
  type WorkspaceRef,
  type WorkspaceStatus,
  type WorkspaceWatcher,
} from "./workspace.ts";
// `memoryWorkspace` is a test double and stays off the package surface: tests import it
// from ./workspace.memory.ts directly.
