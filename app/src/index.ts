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
  editStateFile,
  readStateFile,
  restoring,
  snapshotOf,
  type EditHistory,
  type EditOptions,
  type EditOutcome,
  type EditRefusal,
  type StateEdit,
  type StateEditing,
  type StateFileLoad,
  type StateSnapshot,
} from "./edit.ts";
// `choosing` is the pure edit and stays off the package surface: nothing outside `app` applies it,
// and `./settings.ts` is where its own tests and `./edit.test.ts` import it from.
export {
  readSettings,
  setSettings,
  type SettingsChange,
  type SettingsOptions,
  type SettingsResult,
} from "./settings.ts";
export {
  DEFAULT_STATE_FILE,
  pickGroup,
  readTimetable,
  removeGroupPick,
  type PickOptions,
  type TimetableRef,
  type TimetableResult,
  type TimetableView,
} from "./picks.ts";
export {
  watchWorkspace,
  DEFAULT_SETTLE_MS,
  type Schedule,
  type WorkspaceChanges,
  type WorkspaceChangesOptions,
} from "./changes.ts";
export {
  isStateFileName,
  NotAWorkspaceError,
  requireCatalogRef,
  requireStateFileName,
  StateFileChangedError,
  WORKSPACE_LAYOUT,
  WorkspaceRefusedError,
  type CatalogRef,
  type StateFileContents,
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
