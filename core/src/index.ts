export { importRawCrawl } from "./shoham/import.ts";
export type { ImportSummary, RawCrawl, RawCrawlRow, Warning } from "./shoham/import.ts";
export { parseSemesters, parseGroupMeetings } from "./shoham/dialect.ts";
export { overlappingMeetings } from "./shoham/overlaps.ts";
export type { MeetingOverlap } from "./shoham/overlaps.ts";
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
export { parseStateFile, stateJsonSchema } from "./state/file.ts";
export type { StateFileRead, StateFileWarning } from "./state/file.ts";
export { CURRENT_STATE_SCHEMA_VERSION, stateSchema } from "./state/schema.ts";
export type {
  Attempt,
  BlockedTime,
  Grade,
  GroupPick,
  Pin,
  Settings,
  State,
  Status,
  Timetable,
  Variant,
} from "./state/schema.ts";
