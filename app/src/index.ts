export { createWorkspace, workspaceStatus } from "./setup.ts";
export { importCrawl, type ImportResult } from "./catalog.ts";
// Requirements Files in the Workspace, and the student's Cohort and Programs (#287).
export {
  importRequirementsFile,
  listRequirementsFiles,
  loadRequirementsFiles,
  type ListedRequirements,
  type LoadedRequirements,
  type RequirementsImportResult,
  type RequirementsListing,
} from "./requirements.ts";
// Progress, Pins and ticked Manual Requirements (#288).
export {
  pinCourseTo,
  readProgress,
  tickManualRequirement,
  unpinCourseFrom,
  untickManualRequirement,
  type PinCandidates,
  type ProgramPin,
  type ProgramProgress,
  type ProgressEditOptions,
  type ProgressReadOptions,
  type ProgressResult,
  type ProgressView,
  type ProgressWarningAbout,
} from "./progress.ts";
export {
  chooseCohort,
  choosePrograms,
  programsWarnings,
  readPrograms,
  type ProgramsOptions,
  type ProgramsResult,
  type ProgramsView,
  type ProgramsWarning,
} from "./programs.ts";
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
// The exam period of one Variant, at the student's own spacing threshold (#164).
export { readExams, type ExamsResult } from "./exams.ts";
// The snapshots in `.backups/`: listing them, and putting one back (#67). Taking one is not
// here — the guarded save does it beneath the port, so `editStateFile` stays the only writer.
export {
  listBackups,
  restoreBackup,
  RESTORE_LABEL,
  type BackupSnapshot,
  type BackupsResult,
  type RestoreRefusal,
  type RestoreResult,
} from "./backups.ts";
export {
  DEFAULT_STATE_FILE,
  pickGroup,
  readTimetable,
  removeGroupPick,
  type PickOptions,
  type TimetableRef,
  type TimetableResult,
  type TimetableView,
  type VariantTab,
} from "./picks.ts";
// The Variant tabs (#281): each a `core` edit plus a label through `editStateFile`.
export {
  addVariant,
  duplicateVariantAs,
  makeVariantPrimary,
  removeVariant,
  renameVariantAs,
  type VariantNaming,
} from "./variants.ts";
// The Tray (#283): adding a Course to a Variant's Tray and removing one, with its Picks.
export { addCourseToTray, removeCourseFromTray } from "./tray.ts";
// Blocked Times (#282): add, replace, remove, and copy to another Semester.
export {
  addBlockedTimeTo,
  copyBlockedTimesTo,
  removeBlockedTimeAt,
  replaceBlockedTimeAt,
} from "./blockedTimes.ts";
export {
  watchWorkspace,
  DEFAULT_SETTLE_MS,
  type Schedule,
  type WorkspaceChanges,
  type WorkspaceChangesOptions,
} from "./changes.ts";
export {
  BACKUP_KEEP_DAYS,
  BACKUP_KEEP_SAVES,
  backupDay,
  backupsToPrune,
  isRequirementsFileName,
  isStateFileName,
  isStateFileRevision,
  BackupRefusedError,
  NotAWorkspaceError,
  requireBackupRef,
  requireCatalogRef,
  requireRequirementsFileName,
  requireStateFileName,
  requireWholeFileRef,
  StateFileChangedError,
  statusOf,
  WORKSPACE_LAYOUT,
  WorkspaceRefusedError,
  type BackupRef,
  type CatalogRef,
  type RequirementsFileRef,
  type StateFileContents,
  type StateFileRef,
  type WholeFileRef,
  type Workspace,
  type WorkspaceChanged,
  type WorkspaceFolder,
  type WorkspaceRef,
  type WorkspaceRefusal,
  type WorkspaceRefusalReason,
  type WorkspaceRefusalSubject,
  type WorkspaceStatus,
  type WorkspaceWatcher,
} from "./workspace.ts";
// `memoryWorkspace` is a test double and stays off the package surface: tests import it
// from ./workspace.memory.ts directly.
