import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { unauthorizedSaid, type ScreenDefinition, type ScreenProps } from "../AppShell.tsx";
import { LANGUAGES, t, type Language, type StringKey } from "../i18n/strings.ts";
import { academicYearOf, academicYearSpan, semesterOf } from "../timetable/calendar.ts";
import { columnCredits, gradeOf, planYears, retakeSemester } from "./columns.ts";
import {
  addAttempt,
  fetchChoices,
  fetchCourses,
  fetchPlan,
  moveAttempt,
  planFromSuggestedLayout,
  removeAttempt,
  updateAttempt,
  type Attempt,
  type AttemptWarning,
  type Choices,
  type CourseFacts,
  type Grade,
  type LayoutSummary,
  type LayoutUnavailable,
  type PlanRefusal,
  type PlanResult,
  type PlanWarning,
  type Semester,
  type SemesterAt,
  type StateWarning,
  type Status,
} from "./plan.ts";

/**
 * The Plan screen (#292, `docs/design.md` "Screens"): the student's Attempts laid out across
 * Semesters (ADR-0009), a column per Semester grouped by Academic Year, from their Cohort onward.
 * Summer is collapsed unless it holds an Attempt or the student opens it. Each Attempt is a card —
 * its Course's number, name and credits, its status and grade — that drags to another column, or
 * moves by its own "Move to" for a student without a pointer. A card's status and grade are changed
 * on it, a failed one offers a retake, and any one can be removed; a Course is added to a Semester
 * by number or name. And New Plan from Suggested Layout (#293), offered always: it only adds the
 * Courses the student does not have, so running it on a filled Plan is harmless, and its summary
 * says what it did. A double major chooses which Program's layout it follows, the first by default
 * (#352).
 *
 * **Every change is one request, one guarded save and one undo step**, and the screen shows the
 * Plan the server answers with — never one it worked out itself. That includes a column's credit
 * total, which is the server's too (#352): the number the credit-load check judges, so a column and
 * its Warning cannot disagree (`columnCredits`). **Warnings are drawn where they
 * point** — on the card of the Attempt, on the column of the Semester, above the columns for a
 * Program — and none blocks a drag or an edit (CLAUDE.md).
 *
 * It reaches the domain only through the typed client (`./plan.ts`): the Plan, the Cohort the
 * columns start at, and the Course names and credits, which come from the Requirements Files and
 * the most recent Catalog (`GET /api/courses`) — never from a file this page reads.
 */

type PlanState = { kind: "loading" } | PlanResult;

/** Why the API would not serve or edit the Plan, in words the student can act on. */
const REFUSAL_STRING = {
  "workspace-not-ready": "workspaceNotReady",
  "state-file-unreadable": "planFileUnreadable",
  "state-file-changed": "planStale",
  "workspace-refused": "planFileUnreadable",
  "backup-refused": "planBackupRefused",
  "save-revision-unreadable": "saveUnconfirmed",
} as const satisfies Record<NonNullable<PlanRefusal>, StringKey>;

/** What New Plan from Suggested Layout needs, said rather than guessed (#293). */
const UNAVAILABLE_STRING = {
  "cohort-not-chosen": "planLayoutCohortNotChosen",
  "program-not-chosen": "planLayoutProgramNotChosen",
  "requirements-file-unavailable": "planLayoutFileUnavailable",
  "no-suggested-layout": "planLayoutNone",
} as const satisfies Record<LayoutUnavailable, StringKey>;

const STATUS_STRING = {
  planned: "planStatusPlanned",
  registered: "planStatusRegistered",
  passed: "planStatusPassed",
  failed: "planStatusFailed",
  exempt: "planStatusExempt",
  credited: "planStatusCredited",
} as const satisfies Record<Status, StringKey>;
const STATUSES = Object.keys(STATUS_STRING) as Status[];

/** Each status's hue, from the tokens the dark scheme redefines: written out so Tailwind sees them. */
const STATUS_STRIPE = {
  planned: "border-s-status-planned",
  registered: "border-s-status-registered",
  passed: "border-s-status-passed",
  failed: "border-s-status-failed",
  exempt: "border-s-status-exempt",
  credited: "border-s-status-credited",
} as const satisfies Record<Status, string>;
const STATUS_TEXT = {
  planned: "text-status-planned",
  registered: "text-status-registered",
  passed: "text-status-passed",
  failed: "text-status-failed",
  exempt: "text-status-exempt",
  credited: "text-status-credited",
} as const satisfies Record<Status, string>;

const SEMESTER_STRING = {
  fall: "semesterFall",
  spring: "semesterSpring",
  summer: "semesterSummer",
} as const satisfies Record<Semester, StringKey>;

/** The State File's own Warnings this screen has words for; the rest are the Progress screen's. */
const STATE_WARNING_STRING = new Map<string, StringKey>([
  ["entry-dropped", "progressWarnEntryDropped"],
  ["cohort-unreadable", "progressWarnCohortUnreadable"],
]);

/** A sentence the screen owes the student, kept as its key so a language switch re-says it. */
type Said = { key: StringKey; values?: Record<string, string | number> };

type AnyWarning = AttemptWarning | PlanWarning;

const keyOf = (at: SemesterAt): string => `${at.academicYear}-${at.semester}`;

/** Text a Requirements File or a Catalog carries: Hebrew always, English when it has one. */
const localized = (language: Language, text: { he: string; en?: string | undefined } | undefined): string | undefined =>
  text === undefined ? undefined : language === "en" ? (text.en ?? text.he) : text.he;

function semesterSaid(language: Language, at: SemesterAt): string {
  return t(language, "planSemesterSaid", {
    semester: t(language, SEMESTER_STRING[at.semester]),
    year: t(language, "academicYear", academicYearSpan(at.academicYear)),
  });
}

function gradeSaid(language: Language, grade: Grade | undefined): string {
  if (grade === undefined) return "";
  if (grade.kind === "numeric") return String(grade.value);
  return t(language, grade.passed ? "planGradePass" : "planGradeFail");
}

/** The words a pass and a fail are typed as, in every language, so either is understood. */
const GRADE_WORDS = {
  pass: LANGUAGES.map((language) => t(language, "planGradePass")),
  fail: LANGUAGES.map((language) => t(language, "planGradeFail")),
};

/** One Warning in words, its values filled from the fields its kind carries. */
function warningSaid(language: Language, warning: AnyWarning, attempts: ReadonlyMap<string, Attempt>): string {
  const list = (items: readonly string[]): string => items.join(t(language, "progressListSeparator"));
  const assuming = (reliesOn: readonly string[]): string => {
    const courses = reliesOn.flatMap((id) => {
      const attempt = attempts.get(id);
      return attempt === undefined ? [] : [attempt.courseNumber];
    });
    return courses.length === 0 ? "" : ` ${t(language, "planWarnAssuming", { courses: list(courses) })}`;
  };
  switch (warning.kind) {
    case "prerequisite-unmet":
      return t(language, "planWarnPrerequisite", { courses: list(warning.missing) }) + assuming(warning.reliesOn);
    case "prerequisite-grade-below":
      return (
        t(language, "planWarnPrerequisiteGrade", {
          course: warning.prerequisite,
          grade: warning.grade,
          minGrade: warning.minGrade,
        }) + assuming(warning.reliesOn)
      );
    case "prerequisite-manual":
      return t(language, "planWarnPrerequisiteManual", { text: localized(language, warning.text) ?? "" });
    case "offering-pattern":
      return t(language, "planWarnOfferingPattern");
    case "year-long-split":
      return t(language, "planWarnYearLongSplit");
    case "credit-load":
      return t(language, "planWarnCreditLoad", { credits: warning.credits, limit: warning.limit });
    case "requirements-missing":
      return t(language, "planWarnRequirementsMissing", {
        file: warning.target.requirementsFile,
        requirements: list(warning.requirementIds),
      });
    case "deadline-missed":
      return (
        t(language, "planWarnDeadline", {
          name: localized(language, warning.name) ?? t(language, "planWarnDeadlineUnnamed"),
          courses: list(warning.missing),
        }) + assuming(warning.reliesOn)
      );
    case "attempt-duplicate":
      return t(language, "planWarnDuplicate", { course: warning.courseNumber });
    case "grade-out-of-range":
      return t(language, "planWarnGradeRange", { value: warning.value });
    case "grade-not-completed":
      return t(language, "planWarnGradeNotCompleted");
    case "attempt-before-cohort":
      return t(language, "planWarnBeforeCohort");
    default:
      // a kind a newer server sends that this build has no sentence for
      return t(language, "planWarnOther");
  }
}

/** Re-asks whenever the Workspace changes or a re-read is owed, keeping the last answer on screen. */
function usePlan(changes: number): [PlanState, (answer: PlanResult) => void] {
  const [answer, setAnswer] = useState<PlanState>({ kind: "loading" });
  const shown = useRef(0);
  const show = useCallback((fresh: PlanResult): void => {
    shown.current += 1;
    setAnswer(fresh);
  }, []);
  useEffect(() => {
    const mine = (shown.current += 1);
    void fetchPlan(api).then((fresh) => {
      // an answer older than what is on screen — an edit's own, say — is dropped
      if (shown.current === mine) setAnswer(fresh);
    });
    return () => {
      shown.current += 1;
    };
  }, [changes]);
  return [answer, show];
}

/** One read the screen draws with and never edits through, re-asked as the Plan is. */
function useRead<T>(changes: number, read: () => Promise<T>, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    let current = true;
    void read().then((fresh) => {
      if (current) setValue(fresh);
    });
    return () => {
      current = false;
    };
    // `read` is a module function per call site, so the change count is the whole question
  }, [changes]);
  return value;
}

const readChoices = (): Promise<Choices | undefined> => fetchChoices(api);
const readCourses = (): Promise<CourseFacts[]> => fetchCourses(api);

export function PlanScreen({
  language,
  tokenHeld,
  today,
  workspaceChanges,
  stepRereads,
  steps,
  onEdited,
  onActed,
  onRevision,
  notices,
}: ScreenProps): React.JSX.Element {
  const [rereads, setRereads] = useState(0);
  const changes = workspaceChanges + stepRereads + rereads;
  const [plan, setPlan] = usePlan(changes);
  const choices = useRead(changes, readChoices, undefined);
  const cohort = choices?.cohort;
  const programs = choices?.programs ?? [];
  /** Whose Suggested Layout the action follows when the student has two Programs (#352); page state. */
  const [layoutProgram, setLayoutProgram] = useState<string | undefined>(undefined);
  // the first Program until the student picks another, and again if the one picked is gone
  const layoutFrom = layoutProgram !== undefined && programs.includes(layoutProgram) ? layoutProgram : programs[0];
  const courseList = useRead(changes, readCourses, []);
  const courses = new Map(courseList.map((course) => [course.courseNumber, course]));

  /** That the last edit did nothing, or was not a thing to send; retired by the next one or a step. */
  const [refused, setRefused] = useState<Said | undefined>(undefined);
  /** New Plan from Suggested Layout's account of what it just did (#293). */
  const [summary, setSummary] = useState<LayoutSummary | undefined>(undefined);
  /** An edit is in flight: the controls wait for its answer, which carries the next revision. */
  const [sending, setSending] = useState(false);
  /** The empty Summers the student opened, by Academic Year: page state, never stored. */
  const [openSummers, setOpenSummers] = useState<ReadonlySet<number>>(new Set());
  const [extraYears, setExtraYears] = useState(0);

  useEffect(() => {
    if (steps > 0) {
      setRefused(undefined);
      setSummary(undefined);
    }
  }, [steps]);

  // the revision a press of undo is based on, heard before the browser paints (`TimetablePane`)
  useLayoutEffect(() => {
    onRevision(
      plan.kind === "served" && plan.version !== undefined && !sending ? { version: plan.version, answer: plan } : undefined,
    );
  }, [plan, sending, onRevision]);

  /** One edit on the Plan on screen, answered with the Plan as it stands afterwards. */
  const send = (edit: (basedOn: string | undefined) => Promise<PlanResult>): void => {
    if (plan.kind !== "served" || sending) return;
    onActed();
    setRefused(undefined);
    setSummary(undefined);
    setSending(true);
    void edit(plan.version).then((answer) => {
      setSending(false);
      switch (answer.kind) {
        case "served":
          setPlan(answer);
          if (answer.summary !== undefined) setSummary(answer.summary);
          onEdited();
          return;
        case "unavailable":
          setRefused({ key: UNAVAILABLE_STRING[answer.reason] });
          return;
        case "refused":
          setRefused({ key: answer.reason === undefined ? "planNotDone" : REFUSAL_STRING[answer.reason] });
          // the file is not what the screen shows: keep it on screen and go and look
          if (answer.reason === "state-file-changed") setRereads((count) => count + 1);
          // the save was made and its revision could not be read, so it may have moved (#326)
          if (answer.reason === "save-revision-unreadable") {
            setRereads((count) => count + 1);
            onEdited();
          }
          return;
        case "unreadable-answer":
          // not the claim that nothing was written: everything holding a revision goes and looks
          setRefused({ key: "planAnswerUnreadable" });
          setRereads((count) => count + 1);
          onEdited();
          return;
        case "unauthorized":
          setRefused({ key: tokenHeld ? "tokenRetired" : "tokenMissing" });
          return;
        case "unreachable":
          setRefused({ key: "apiUnreachable" });
          return;
      }
    });
  };

  const said = statusSaid(language, plan, tokenHeld);
  const served = plan.kind === "served" ? plan : undefined;
  const attempts = served?.attempts ?? [];
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const warnings: AnyWarning[] = served === undefined ? [] : [...served.attemptWarnings, ...served.planWarnings];
  const onCard = (id: string) => warnings.filter((warning) => warning.target.kind === "attempt" && warning.target.id === id);
  const onColumn = (at: SemesterAt) =>
    warnings.filter(
      (warning) =>
        warning.target.kind === "semester" &&
        warning.target.academicYear === at.academicYear &&
        warning.target.semester === at.semester,
    );

  const years = planYears({ cohort, attempts, thisYear: academicYearOf(today), extraYears });
  const shown: SemesterAt[] = years.flatMap(({ academicYear, semesters }) =>
    semesters.map((semester) => ({ academicYear, semester })),
  );
  const shownKeys = new Set(shown.map(keyOf));
  /**
   * What has nowhere else to be drawn: a Program's Warnings, and one about an Attempt or a Semester
   * no column shows — a deadline at the end of a Semester past the last column — so none is lost.
   */
  const above = warnings.filter(
    (warning) =>
      warning.target.kind === "program" ||
      (warning.target.kind === "attempt" && !byId.has(warning.target.id)) ||
      (warning.target.kind === "semester" && !shownKeys.has(keyOf(warning.target))),
  );
  const now = { academicYear: academicYearOf(today), semester: semesterOf(today) };
  const addDefault = shown.some((at) => keyOf(at) === keyOf(now)) ? now : shown[0]!;

  const move = (id: string, to: SemesterAt): void => {
    const attempt = byId.get(id);
    if (attempt === undefined || keyOf(attempt) === keyOf(to)) return;
    send((basedOn) => moveAttempt(api, id, to, basedOn));
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-rule bg-hint px-4 py-2 text-sm text-ink-soft">
        <AddCourse
          language={language}
          courses={courseList}
          semesters={shown}
          initial={addDefault}
          disabled={served === undefined || sending}
          onAdd={(courseNumber, at) =>
            send((basedOn) => addAttempt(api, { courseNumber, ...at, status: "planned" }, basedOn))
          }
        />
        {programs.length < 2 ? null : (
          <label className="flex items-center gap-2">
            <span>{t(language, "planLayoutProgram")}</span>
            <select
              data-plan-layout-program
              value={layoutFrom}
              disabled={served === undefined || sending}
              onChange={(event) => setLayoutProgram(event.target.value)}
              className="rounded-sm border border-rule bg-paper px-2 py-1 text-ink"
            >
              {programs.map((program) => (
                <option key={program} value={program}>
                  {program}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          data-plan-layout
          disabled={served === undefined || sending}
          onClick={() =>
            // one Program needs no naming: the route follows the first when none is named
            send((basedOn) => planFromSuggestedLayout(api, basedOn, programs.length < 2 ? undefined : layoutFrom))
          }
          className="rounded-sm border border-rule bg-paper px-3 py-1 text-ink-soft disabled:opacity-50"
        >
          {t(language, "planLayoutAction")}
        </button>
        {/* every account of what just happened, the shell's and this screen's */}
        <span role="status" className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1">
          {said === undefined ? null : <span>{said}</span>}
          {refused === undefined ? null : <span data-plan-refused>{t(language, refused.key, refused.values)}</span>}
          {summary === undefined ? null : <SummarySaid language={language} summary={summary} />}
          {notices}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {served !== undefined && (
          <>
            <ul data-plan-warnings className="mb-3 list-disc space-y-1 ps-5 text-sm text-ink-soft empty:hidden">
              {served.programWarnings.some((warning) => warning.kind === "requirements-unlisted") ? (
                <li data-plan-unlisted>{t(language, "planWarnUnlisted")}</li>
              ) : null}
              {served.stateWarnings
                .filter((warning: StateWarning) => STATE_WARNING_STRING.has(warning.kind))
                .map((warning, index) => (
                  <li key={`state:${index}`}>
                    {t(language, STATE_WARNING_STRING.get(warning.kind)!, {
                      at: typeof (warning as { at?: unknown }).at === "string" ? (warning as { at: string }).at : "",
                    })}
                  </li>
                ))}
              {above.map((warning, index) => (
                <li key={`plan:${index}`}>{warningSaid(language, warning, byId)}</li>
              ))}
            </ul>
            {cohort === null && <p className="mb-3 text-sm text-pencil">{t(language, "planNoCohort")}</p>}
            {attempts.length === 0 && <p className="mb-3 text-sm text-pencil">{t(language, "planEmpty")}</p>}

            <div className="flex items-start gap-4 overflow-x-auto pb-2">
              {years.map(({ academicYear, semesters }) => (
                <section
                  key={academicYear}
                  data-year={academicYear}
                  aria-label={t(language, "academicYear", academicYearSpan(academicYear))}
                  className="shrink-0 rounded-sm border border-rule bg-paper p-2"
                >
                  <h2 className="mb-2 text-sm font-semibold">
                    {t(language, "academicYear", academicYearSpan(academicYear))}
                  </h2>
                  <div className="flex items-start gap-2">
                    {semesters.map((semester) => {
                      const at = { academicYear, semester };
                      const held = attempts.filter((attempt) => keyOf(attempt) === keyOf(at));
                      // a Summer holding an Attempt or a Warning about it is open, so neither is hidden
                      const collapsible = semester === "summer" && held.length === 0 && onColumn(at).length === 0;
                      if (collapsible && !openSummers.has(academicYear)) {
                        return (
                          <button
                            key={semester}
                            type="button"
                            data-summer-toggle={academicYear}
                            aria-expanded={false}
                            aria-label={t(language, "planSummerShowOf", { semester: semesterSaid(language, at) })}
                            onClick={() => setOpenSummers(new Set([...openSummers, academicYear]))}
                            className="self-stretch rounded-sm border border-dashed border-rule px-1 text-xs text-pencil [writing-mode:vertical-rl]"
                          >
                            {t(language, "semesterSummer")}
                          </button>
                        );
                      }
                      return (
                        <Column
                          key={semester}
                          language={language}
                          at={at}
                          total={columnCredits(served.semesterCredits, at)}
                          warnings={onColumn(at)}
                          byId={byId}
                          onCollapse={
                            collapsible
                              ? () => setOpenSummers(new Set([...openSummers].filter((year) => year !== academicYear)))
                              : undefined
                          }
                          onDrop={(id) => move(id, at)}
                        >
                          {held.map((attempt) => (
                            <Card
                              key={attempt.id}
                              language={language}
                              attempt={attempt}
                              course={courses.get(attempt.courseNumber)}
                              warnings={onCard(attempt.id)}
                              byId={byId}
                              semesters={shown}
                              disabled={sending}
                              onStatus={(status) => send((basedOn) => updateAttempt(api, attempt.id, { status }, basedOn))}
                              onGrade={(text) => {
                                const grade = gradeOf(text, GRADE_WORDS);
                                if (grade === undefined) {
                                  onActed();
                                  setSummary(undefined);
                                  setRefused({
                                    key: "planGradeNotAGrade",
                                    values: {
                                      text,
                                      pass: t(language, "planGradePass"),
                                      fail: t(language, "planGradeFail"),
                                    },
                                  });
                                  return;
                                }
                                send((basedOn) => updateAttempt(api, attempt.id, { grade }, basedOn));
                              }}
                              onMove={(to) => move(attempt.id, to)}
                              onRetake={() =>
                                send((basedOn) =>
                                  addAttempt(
                                    api,
                                    { courseNumber: attempt.courseNumber, ...retakeSemester(attempt), status: "planned" },
                                    basedOn,
                                  ),
                                )
                              }
                              onRemove={() => send((basedOn) => removeAttempt(api, attempt.id, basedOn))}
                            />
                          ))}
                        </Column>
                      );
                    })}
                  </div>
                </section>
              ))}
              <button
                type="button"
                data-plan-add-year
                onClick={() => setExtraYears((count) => count + 1)}
                className="shrink-0 self-center rounded-sm border border-dashed border-rule bg-paper px-3 py-1 text-sm text-ink-soft"
              >
                {t(language, "planAddYear")}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/** What the screen says about the read itself, and nothing once it is served. */
function statusSaid(language: Language, plan: PlanState, tokenHeld: boolean): string | undefined {
  switch (plan.kind) {
    case "loading":
      return t(language, "planLoading");
    case "served":
    case "unavailable":
      return undefined;
    case "refused":
      return t(language, plan.reason === undefined ? "planFileUnreadable" : REFUSAL_STRING[plan.reason]);
    case "unauthorized":
      return unauthorizedSaid(language, tokenHeld);
    case "unreadable-answer":
      return t(language, "planAnswerUnreadable");
    case "unreachable":
      return t(language, "apiUnreachable");
  }
}

/** New Plan from Suggested Layout's summary: how many it created, and each Course it skipped and why. */
function SummarySaid({ language, summary }: { language: Language; summary: LayoutSummary }): React.JSX.Element {
  return (
    <span data-plan-summary className="flex flex-wrap items-center gap-x-2">
      <span>
        {summary.created.length === 0
          ? t(language, "planLayoutNothing")
          : t(language, "planLayoutCreated", { count: summary.created.length })}
      </span>
      {summary.skipped.length === 0 ? null : (
        <span>
          {t(language, "planLayoutSkipped")}{" "}
          {summary.skipped.map((skipped, index) => (
            <span key={`${skipped.courseNumber}:${index}`} data-plan-skipped={skipped.courseNumber}>
              {index === 0 ? "" : t(language, "progressListSeparator")}
              {t(language, skipped.reason === "attempted" ? "planLayoutSkippedAttempted" : "planLayoutSkippedTwice", {
                course: skipped.courseNumber,
              })}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** The media type a dragged card carries: an Attempt's id, and nothing a drop elsewhere would read. */
const DRAGGED = "application/x-biu-attempt";

/** One Semester: its name, its credit total, its Warnings, and the cards dropped on it. */
function Column({
  language,
  at,
  total,
  warnings,
  byId,
  onCollapse,
  onDrop,
  children,
}: {
  language: Language;
  at: SemesterAt;
  /** What the column adds up to, as the Plan answer serves it. */
  total: { credits: number; unknown: number };
  warnings: readonly AnyWarning[];
  /** Every Attempt by id, so a deadline's "assuming you pass" can name the Courses it relies on. */
  byId: ReadonlyMap<string, Attempt>;
  /** How an empty Summer the student opened is closed again; absent for every other column. */
  onCollapse: (() => void) | undefined;
  onDrop: (id: string) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const [over, setOver] = useState(false);
  const { credits, unknown } = total;
  return (
    <section
      data-semester={keyOf(at)}
      aria-label={semesterSaid(language, at)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAGGED)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const id = event.dataTransfer.getData(DRAGGED);
        if (id === "") return;
        event.preventDefault();
        onDrop(id);
      }}
      className={`flex min-h-40 w-56 flex-col gap-2 rounded-sm border p-2 ${over ? "border-ink bg-hint" : "border-rule-soft bg-desk"}`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h3 className="text-sm font-semibold">{t(language, SEMESTER_STRING[at.semester])}</h3>
        <span data-column-credits className="text-xs text-pencil">
          {t(language, "planColumnCredits", { credits })}
          {unknown === 0 ? "" : `${t(language, "planColumnJoin")}${t(language, "planColumnUnknown", { count: unknown })}`}
        </span>
        {onCollapse === undefined ? null : (
          <button
            type="button"
            data-summer-toggle={at.academicYear}
            aria-expanded
            onClick={onCollapse}
            className="text-xs text-ink-soft underline"
          >
            {t(language, "planSummerHide")}
          </button>
        )}
      </header>
      {warnings.length === 0 ? null : (
        <ul data-column-warnings className="list-disc space-y-1 ps-4 text-xs text-ink-soft">
          {warnings.map((warning, index) => (
            <li key={`${warning.kind}:${index}`}>{warningSaid(language, warning, byId)}</li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

/** One Attempt: what it is, its Warnings, and every edit that can be made to it. */
function Card({
  language,
  attempt,
  course,
  warnings,
  byId,
  semesters,
  disabled,
  onStatus,
  onGrade,
  onMove,
  onRetake,
  onRemove,
}: {
  language: Language;
  attempt: Attempt;
  course: CourseFacts | undefined;
  warnings: readonly AnyWarning[];
  byId: ReadonlyMap<string, Attempt>;
  semesters: readonly SemesterAt[];
  disabled: boolean;
  onStatus: (status: Status) => void;
  onGrade: (text: string) => void;
  onMove: (to: SemesterAt) => void;
  onRetake: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const ids = useId();
  // reset when the grade the file holds says something else, not on every re-read's new object, so a
  // re-read prompted by another tab does not wipe a grade half typed on this card
  const held = gradeSaid(language, attempt.grade);
  const [grade, setGrade] = useState(held);
  useEffect(() => setGrade(held), [held]);
  const name = localized(language, course?.name);
  const here = keyOf(attempt);
  return (
    <article
      data-attempt={attempt.id}
      data-status={attempt.status}
      aria-labelledby={`${ids}-title`}
      draggable={!disabled}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAGGED, attempt.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      className={`rounded-sm border border-rule border-s-4 bg-paper p-2 text-sm ${STATUS_STRIPE[attempt.status]}`}
    >
      <h4 id={`${ids}-title`} className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs">{attempt.courseNumber}</span>
        {name === undefined ? null : <span data-course-name className="font-semibold">{name}</span>}
      </h4>
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-pencil">
        <span data-card-credits>
          {course?.credits === undefined
            ? t(language, "planCardNoCredits")
            : t(language, "planCardCredits", { credits: course.credits })}
        </span>
        <span data-status-badge className={`font-semibold ${STATUS_TEXT[attempt.status]}`}>
          {t(language, STATUS_STRING[attempt.status])}
        </span>
        {attempt.grade === undefined ? null : <span data-card-grade>{gradeSaid(language, attempt.grade)}</span>}
      </p>
      {warnings.length === 0 ? null : (
        <ul data-card-warnings className="mt-1 list-disc space-y-1 ps-4 text-xs text-ink-soft">
          {warnings.map((warning, index) => (
            <li key={`${warning.kind}:${index}`}>{warningSaid(language, warning, byId)}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col">
          {t(language, "planStatus")}
          <select
            data-attempt-status={attempt.id}
            value={attempt.status}
            disabled={disabled}
            onChange={(event) => onStatus(event.target.value as Status)}
            className="rounded-sm border border-rule bg-paper px-1 py-0.5"
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(language, STATUS_STRING[status])}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex items-end gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            onGrade(grade);
          }}
        >
          <label className="flex flex-col">
            {t(language, "planGrade")}
            <input
              data-attempt-grade={attempt.id}
              value={grade}
              disabled={disabled}
              size={5}
              onChange={(event) => setGrade(event.target.value)}
              className="rounded-sm border border-rule bg-paper px-1 py-0.5"
            />
          </label>
          <button
            type="submit"
            data-attempt-grade-set={attempt.id}
            disabled={disabled}
            className="rounded-sm border border-rule bg-paper px-2 py-0.5 text-ink-soft disabled:opacity-50"
          >
            {t(language, "planGradeSet")}
          </button>
        </form>
        {/* the keyboard's drag: every column a card could be dropped on, this one selected */}
        <label className="flex flex-col">
          {t(language, "planMoveTo")}
          <select
            data-attempt-move={attempt.id}
            value={here}
            disabled={disabled}
            onChange={(event) => {
              const to = semesters.find((at) => keyOf(at) === event.target.value);
              if (to !== undefined) onMove(to);
            }}
            className="rounded-sm border border-rule bg-paper px-1 py-0.5"
          >
            {semesters.map((at) => (
              <option key={keyOf(at)} value={keyOf(at)}>
                {semesterSaid(language, at)}
              </option>
            ))}
          </select>
        </label>
        {attempt.status !== "failed" ? null : (
          <button
            type="button"
            data-attempt-retake={attempt.id}
            disabled={disabled}
            onClick={onRetake}
            className="rounded-sm border border-rule bg-paper px-2 py-0.5 text-ink-soft disabled:opacity-50"
          >
            {t(language, "planRetake")}
          </button>
        )}
        <button
          type="button"
          data-attempt-remove={attempt.id}
          disabled={disabled}
          onClick={onRemove}
          className="rounded-sm border border-rule bg-paper px-2 py-0.5 text-ink-soft disabled:opacity-50"
        >
          {t(language, "planRemove")}
        </button>
      </div>
    </article>
  );
}

/**
 * Adding a Course to a Semester, by its number or its name: what is typed is matched against the
 * Courses the Workspace knows — a number, a name in either language, or an offered entry — and
 * anything else is taken as the course number it was typed as, since a Course no file knows yet is
 * still a Course the student may plan.
 */
function AddCourse({
  language,
  courses,
  semesters,
  initial,
  disabled,
  onAdd,
}: {
  language: Language;
  courses: readonly CourseFacts[];
  semesters: readonly SemesterAt[];
  initial: SemesterAt;
  disabled: boolean;
  onAdd: (courseNumber: string, at: SemesterAt) => void;
}): React.JSX.Element {
  const ids = useId();
  const [text, setText] = useState("");
  const [where, setWhere] = useState<string | undefined>(undefined);
  const chosen = semesters.find((at) => keyOf(at) === where) ?? initial;
  const offered = (course: CourseFacts): string => {
    const name = localized(language, course.name);
    return name === undefined ? course.courseNumber : `${course.courseNumber} ${name}`;
  };
  const resolve = (typed: string): string => {
    const folded = typed.toLocaleLowerCase();
    const match = courses.find(
      (course) =>
        course.courseNumber === typed ||
        offered(course).toLocaleLowerCase() === folded ||
        course.name?.he.toLocaleLowerCase() === folded ||
        course.name?.en?.toLocaleLowerCase() === folded,
    );
    return match?.courseNumber ?? typed;
  };
  return (
    <form
      data-plan-add
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const typed = text.trim();
        if (typed === "") return;
        onAdd(resolve(typed), chosen);
        setText("");
      }}
    >
      <label className="flex flex-col">
        {t(language, "planAddCourse")}
        <input
          data-plan-add-course
          list={`${ids}-courses`}
          value={text}
          placeholder={t(language, "planAddCourseHint")}
          onChange={(event) => setText(event.target.value)}
          className="w-64 rounded-sm border border-rule bg-paper px-2 py-1"
        />
        <datalist id={`${ids}-courses`}>
          {courses.map((course) => (
            <option key={course.courseNumber} value={offered(course)} />
          ))}
        </datalist>
      </label>
      <label className="flex flex-col">
        {t(language, "planAddTo")}
        <select
          data-plan-add-semester
          value={keyOf(chosen)}
          onChange={(event) => setWhere(event.target.value)}
          className="rounded-sm border border-rule bg-paper px-2 py-1"
        >
          {semesters.map((at) => (
            <option key={keyOf(at)} value={keyOf(at)}>
              {semesterSaid(language, at)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        data-plan-add-submit
        disabled={disabled || text.trim() === ""}
        className="rounded-sm border border-rule bg-paper px-3 py-1 text-ink-soft disabled:opacity-50"
      >
        {t(language, "planAddSubmit")}
      </button>
    </form>
  );
}

/** The Plan screen's entry in the registry: after the Timetable, at `/plan`. */
export const PLAN_SCREEN: ScreenDefinition = {
  path: "/plan",
  label: "plan",
  render: (props) => <PlanScreen {...props} />,
};
