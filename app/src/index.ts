export { createWorkspace, workspaceStatus } from "./setup.ts";
export { importCrawl, type ImportResult } from "./catalog.ts";
export {
  getOffering,
  listOfferings,
  type ListResult,
  type OfferingResult,
  type QueryWarning,
} from "./queries.ts";
export {
  watchWorkspace,
  DEFAULT_SETTLE_MS,
  type Schedule,
  type WorkspaceChanges,
  type WorkspaceChangesOptions,
} from "./changes.ts";
export {
  isStateFileName,
  requireStateFileName,
  WORKSPACE_LAYOUT,
  WorkspaceRefusedError,
  type CatalogRef,
  type StateFileRef,
  type Workspace,
  type WorkspaceChanged,
  type WorkspaceFolder,
  type WorkspaceRef,
  type WorkspaceStatus,
  type WorkspaceWatcher,
} from "./workspace.ts";
// `memoryWorkspace` is a test double and stays off the package surface: tests import it
// from ./workspace.memory.ts directly.
