export { importRawCrawl } from "./shoham/import.ts";
export type {
  GroupChange,
  GroupMove,
  ImportChanges,
  ImportSummary,
  OfferingChange,
  RawCrawl,
  RawCrawlRow,
  Warning,
} from "./shoham/import.ts";
export { parseSemesters, parseGroupMeetings } from "./shoham/dialect.ts";
export { meetingsOccupyingNoTime, overlappingMeetings } from "./shoham/overlaps.ts";
export type {
  EmptyRangeShape,
  MeetingOccupyingNoTime,
  MeetingOverlap,
} from "./shoham/overlaps.ts";
export { rawCrawlSchema, rawDetailSchema, rawCrawlRowSchema } from "./shoham/raw-crawl.ts";
export { parseCatalogFile, catalogJsonSchema } from "./catalog/file.ts";
export type { CatalogFileWarning } from "./catalog/file.ts";
export {
  CURRENT_CATALOG_SCHEMA_VERSION,
  catalogSchema,
  offeringSchema,
  semesterSchema,
} from "./catalog/schema.ts";
export type {
  Catalog,
  Provenance,
  Day,
  Exam,
  Group,
  Meeting,
  Offering,
  Semester,
} from "./catalog/schema.ts";
export { checkExams, DEFAULT_EXAM_SPACING_DAYS } from "./timetable/exams.ts";
export type {
  ExamCheck,
  ExamCheckOptions,
  ExamSitting,
  ExamSource,
  ExamWarning,
  RailSitting,
} from "./timetable/exams.ts";
export { findMeetingClashes } from "./timetable/clashes.ts";
export type { GroupRef, MeetingClash, PickedGroup, WeeklySpan } from "./timetable/clashes.ts";
export {
  parseStateFile,
  StateFileUnwritableError,
  stateJsonSchema,
  writeStateFile,
} from "./state/file.ts";
export type {
  StateFileRead,
  StateFileSave,
  StateFileVersion,
  StateFileWarning,
} from "./state/file.ts";
export {
  clashesIn,
  DEFAULT_VARIANT_NAME,
  recordPick,
  removePick,
  variantAt,
} from "./state/picks.ts";
export type { PickSlot, TimetableClash, VariantRef } from "./state/picks.ts";
export { timetableAt } from "./state/timetable.ts";
export type { TimetableAt } from "./state/timetable.ts";
export {
  createVariant,
  deleteVariant,
  duplicateVariant,
  freeVariantName,
  renameVariant,
  resolveVariantName,
  setPrimaryVariant,
  variantWarnings,
} from "./state/variants.ts";
export type { VariantWarning } from "./state/variants.ts";
export { addToTray, removeFromTray, trayEntries } from "./state/tray.ts";
export type { TrayChip, TrayEntry, TrayOffering, TrayOrigin } from "./state/tray.ts";
export {
  addBlockedTime,
  blockedTimeWarnings,
  copyBlockedTimes,
  removeBlockedTime,
  replaceBlockedTime,
  splitBlockedRange,
} from "./state/blocked.ts";
export type { BlockedRange, BlockedTimeWarning } from "./state/blocked.ts";
export { effectiveFile, programWarnings, setCohort, setPrograms } from "./state/programs.ts";
export { pinCourse, tickManual, unpinCourse, untickManual } from "./state/pins.ts";
export {
  addAttempt,
  attemptWarnings,
  moveAttempt,
  removeAttempt,
  updateAttempt,
} from "./state/attempts.ts";
export type { AttemptChange, AttemptTarget, AttemptWarning } from "./state/attempts.ts";
export { fromSuggestedLayout, suggestedLayoutOf } from "./state/suggested-layout.ts";
export type { LayoutCreated, LayoutSkipped, LayoutSummary } from "./state/suggested-layout.ts";
export { semesterIndex, studyPointAt } from "./state/semester-order.ts";
export type { SemesterAt, StudyPoint } from "./state/semester-order.ts";
export type { PinRef, RequirementRef } from "./state/pins.ts";
export type { ListedRequirementsFile, ProgramWarning } from "./state/programs.ts";
export {
  attemptIdSchema,
  attemptSchema,
  blockedTimeSchema,
  CURRENT_STATE_SCHEMA_VERSION,
  DEFAULT_CREDIT_LOAD_LIMIT,
  gradeSchema,
  groupPickSchema,
  manualTickSchema,
  pinSchema,
  programSchema,
  settingsSchema,
  stateSchema,
  statusSchema,
  studentCohortSchema,
} from "./state/schema.ts";
export type {
  Attempt,
  AttemptFacts,
  AttemptId,
  BlockedTime,
  Grade,
  GroupPick,
  ManualTick,
  Pin,
  Program,
  Settings,
  State,
  Status,
  StudentCohort,
  Timetable,
  Variant,
} from "./state/schema.ts";
export {
  CURRENT_REQUIREMENTS_SCHEMA_VERSION,
  requirementsFileSchema,
} from "./requirements/schema.ts";
export type {
  Cohort,
  CourseSet,
  Deadline,
  DoubleCounting,
  Equivalence,
  LayoutEntry,
  LocalizedText,
  OfferingPattern,
  Policies,
  Pool,
  Prerequisite,
  Requirement,
  RequirementsCourse,
  RequirementsFile,
  Track,
} from "./requirements/schema.ts";
export { parseRequirementsFile, requirementsJsonSchema } from "./requirements/file.ts";
export type {
  IdNamespace,
  RequirementsFileRead,
  RequirementsFileWarning,
} from "./requirements/file.ts";
export { evaluateProgress, firstFitAssignment } from "./requirements/evaluate.ts";
export type {
  Assignment,
  EvaluatedRequirement,
  Lens,
  LensEvaluation,
  Lenses,
  Placement,
  Progress,
  ProgressInput,
  ProgressWarning,
  RequirementStatus,
} from "./requirements/evaluate.ts";
export { DEFAULT_SOLVE_LIMITS, solveAssignment } from "./requirements/solve.ts";
export type {
  Solution,
  SolveInput,
  SolveLimits,
  SolvePin,
  SolverWarning,
} from "./requirements/solve.ts";
export { requirementsAccepting } from "./requirements/candidates.ts";
export { checkPlan } from "./plan/checks.ts";
export type {
  PlanCheckInput,
  PlanProgram,
  PlanTarget,
  PlanWarning,
  ProgramTarget,
  SemesterTarget,
} from "./plan/checks.ts";
