import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { unauthorizedSaid, type ScreenDefinition, type ScreenProps } from "../AppShell.tsx";
import { t, type Language, type StringKey } from "../i18n/strings.ts";
import {
  choosePrograms,
  fetchProgress,
  fetchRequirementsFiles,
  pinCourse,
  tickManual,
  unpinCourse,
  untickManual,
  type EngineWarning,
  type EvaluatedProgram,
  type EvaluatedRequirement,
  type ListedRequirements,
  type PinWarning,
  type ProgramsWarning,
  type ProgressRefusal,
  type ProgressResult,
  type SolverWarning,
  type StateWarning,
} from "./progress.ts";

/**
 * The Progress screen (#288, `docs/design.md` "Screens"): each chosen Program's Requirement tree,
 * every node with its status in the lens the student picks — what is completed, or what the Plan
 * would complete — its numbers and the Courses counting toward it; Pinning a Course to another
 * Requirement it can count toward, unpinning it; ticking a Manual Requirement. Every edit is one
 * request, one guarded save and one undo step, and the screen shows what the server answers.
 *
 * It reaches the domain only through the typed client (`./progress.ts`), and it invents no Pin
 * candidate: the Requirements a Course is offered are the ones the engine says it can count toward.
 */

type Lens = "completed" | "projected";
type ProgressState = { kind: "loading" } | ProgressResult;

const STATUS_STRING = {
  satisfied: "progressSatisfied",
  partial: "progressPartial",
  missing: "progressMissing",
} as const satisfies Record<EvaluatedRequirement["completed"]["status"], StringKey>;

/** Why the API would not serve or edit Progress, in words the student can act on. */
const REFUSAL_STRING = {
  "workspace-not-ready": "workspaceNotReady",
  "state-file-unreadable": "progressFileUnreadable",
  "state-file-changed": "progressStale",
  "workspace-refused": "progressFileUnreadable",
  "backup-refused": "progressBackupRefused",
  "save-revision-unreadable": "saveUnconfirmed",
} as const satisfies Record<NonNullable<ProgressRefusal>, StringKey>;

/**
 * Every Warning the screen can be served, by kind. A `Map` because a newer server may send a kind
 * this build has no sentence for, and `progressWarningOther` is what is true of every one of them.
 */
const WARNING_STRING = new Map<string, StringKey>([
  ["track-unknown", "progressWarnTrackUnknown"],
  ["course-unknown", "progressWarnCourseUnknown"],
  ["credits-unknown", "progressWarnCreditsUnknown"],
  ["assignment-requirement-unknown", "progressWarnPinIneffective"],
  ["assignment-not-accepted", "progressWarnPinIneffective"],
  ["assignment-double-count", "progressWarnPinIneffective"],
  ["pin-requirement-unknown", "progressWarnPinRequirementUnknown"],
  ["pin-not-accepted", "progressWarnPinNotAccepted"],
  ["pin-conflict", "progressWarnPinConflict"],
  ["program-file-missing", "progressWarnFileMissing"],
  ["program-file-unreadable", "progressWarnFileUnreadable"],
  ["program-track-unknown", "progressWarnTrackUnknown"],
  ["requirements-unlisted", "progressWarnUnlisted"],
  ["pin-file-not-chosen", "progressWarnPinFileNotChosen"],
  ["tick-file-not-chosen", "progressWarnTickFileNotChosen"],
  // the State File's own, so a Program, Pin or tick the reader had to leave out is not lost unseen
  ["entry-dropped", "progressWarnEntryDropped"],
  ["cohort-unreadable", "progressWarnCohortUnreadable"],
]);

type AnyWarning = EngineWarning | SolverWarning | ProgramsWarning | PinWarning | StateWarning;

/** One Warning in words, its values filled in from the fields the kind carries. */
function warningSaid(language: Language, warning: AnyWarning): string {
  const fields = warning as Record<string, unknown>;
  const text = (key: string): string => (typeof fields[key] === "string" ? (fields[key] as string) : "");
  return t(language, WARNING_STRING.get(warning.kind) ?? "progressWarningOther", {
    course: text("courseNumber"),
    requirement: text("requirementId"),
    file: text("requirementsFile"),
    track: text("track"),
    at: text("at"),
  });
}

/** Text a Requirements File carries: Hebrew always, English when the maintainer wrote it. */
const localized = (language: Language, text: { he: string; en?: string | undefined } | undefined): string | undefined =>
  text === undefined ? undefined : language === "en" ? (text.en ?? text.he) : text.he;

/** A Requirement's name: its own, or for an unnamed one what it is about, or its id. */
function nameOf(language: Language, requirement: EvaluatedRequirement): string {
  return localized(language, requirement.name) ?? requirement.id;
}

/** Every node of a tree, in order, with its depth. */
function walk(
  nodes: readonly EvaluatedRequirement[],
  level = 1,
): Array<{ node: EvaluatedRequirement; level: number }> {
  return nodes.flatMap((node) => [{ node, level }, ...walk(node.children, level + 1)]);
}

/** Re-asks whenever the question or the Workspace changes, keeping the last answer on screen. */
function useProgress(changes: number): [ProgressState, (answer: ProgressResult) => void] {
  const [answer, setAnswer] = useState<ProgressState>({ kind: "loading" });
  const shown = useRef(0);
  const show = useCallback((fresh: ProgressResult): void => {
    shown.current += 1;
    setAnswer(fresh);
  }, []);
  useEffect(() => {
    const mine = (shown.current += 1);
    void fetchProgress(api).then((fresh) => {
      // an answer older than what is on screen — an edit's own, say — is dropped
      if (shown.current === mine) setAnswer(fresh);
    });
    return () => {
      shown.current += 1;
    };
  }, [changes]);
  return [answer, show];
}

export function ProgressScreen({
  language,
  tokenHeld,
  workspaceChanges,
  stepRereads,
  steps,
  onEdited,
  onActed,
  onRevision,
  notices,
}: ScreenProps): React.JSX.Element {
  const [rereads, setRereads] = useState(0);
  const [progress, setProgress] = useProgress(workspaceChanges + stepRereads + rereads);
  const [lens, setLens] = useState<Lens>("completed");
  /** That the last edit was refused, and why; retired by the next edit or a step. */
  const [editRefused, setEditRefused] = useState<StringKey | undefined>(undefined);
  /** An edit is in flight: the controls wait for its answer, which carries the next revision. */
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (steps > 0) setEditRefused(undefined);
  }, [steps]);

  // the revision a press of undo is based on, heard before the browser paints (`TimetablePane`)
  useLayoutEffect(() => {
    onRevision(
      progress.kind === "served" && progress.version !== undefined && !sending
        ? { version: progress.version, answer: progress }
        : undefined,
    );
  }, [progress, sending, onRevision]);

  /** One edit on the view on screen, answered with Progress as it stands afterwards. */
  const send = (edit: (basedOn: string | undefined) => Promise<ProgressResult>): void => {
    if (progress.kind !== "served" || sending) return;
    onActed();
    setEditRefused(undefined);
    setSending(true);
    void edit(progress.version).then((answer) => {
      setSending(false);
      if (answer.kind === "served") {
        setProgress(answer);
        onEdited();
        return;
      }
      if (answer.kind === "refused") {
        setEditRefused(answer.reason === undefined ? "progressNotDone" : REFUSAL_STRING[answer.reason]);
        // the file is not what the screen shows: keep it on screen and go and look
        if (answer.reason === "state-file-changed") setRereads((count) => count + 1);
        return;
      }
      if (answer.kind === "unreadable-answer") {
        // not the claim that nothing was written: everything holding a revision goes and looks
        setEditRefused("progressAnswerUnreadable");
        setRereads((count) => count + 1);
        onEdited();
        return;
      }
      setEditRefused(answer.kind === "unreachable" ? "apiUnreachable" : undefined);
      if (answer.kind === "unauthorized") setEditRefused(tokenHeld ? "tokenRetired" : "tokenMissing");
    });
  };

  const said = statusSaid(language, progress, tokenHeld);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule bg-hint px-4 py-2 text-sm text-ink-soft">
        {/* the lens: two buttons, the pressed one is the lens shown */}
        <span role="group" aria-label={t(language, "progressLens")} className="flex items-center gap-1">
          {(["completed", "projected"] as const).map((which) => (
            <button
              key={which}
              type="button"
              data-lens={which}
              aria-pressed={lens === which}
              onClick={() => setLens(which)}
              className={
                lens === which
                  ? "rounded-sm border border-ink bg-paper px-3 py-1 text-sm font-semibold text-ink"
                  : "rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft"
              }
            >
              {t(language, which === "completed" ? "progressLensCompleted" : "progressLensProjected")}
            </button>
          ))}
        </span>
        {/* every account of what just happened, the shell's and this screen's */}
        <span role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {said === undefined ? null : <span>{said}</span>}
          {editRefused === undefined ? null : <span>{t(language, editRefused)}</span>}
          {progress.kind === "served" && progress.stoppedEarly && (
            <span>{t(language, "progressStoppedEarly")}</span>
          )}
          {notices}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {progress.kind === "served" && (
          <>
            <Warnings
              language={language}
              warnings={[
                ...progress.stateWarnings.filter((warning) => WARNING_STRING.has(warning.kind)),
                ...progress.programWarnings,
                ...progress.solverWarnings,
                ...progress.pinWarnings,
              ]}
            />
            {progress.programs.length === 0 ? (
              <ProgramChooser
                language={language}
                workspaceChanges={workspaceChanges}
                disabled={sending}
                onChoose={(programs) =>
                  send(async (basedOn) => {
                    const chosen = await choosePrograms(api, programs, basedOn);
                    if (chosen.kind !== "saved") {
                      return chosen.kind === "refused"
                        ? { kind: "refused", reason: chosen.reason }
                        : chosen;
                    }
                    return fetchProgress(api);
                  })
                }
              />
            ) : (
              progress.programs.map((program, index) =>
                program.status === "evaluated" ? (
                  <ProgramTree
                    key={`${program.requirementsFile}:${index}`}
                    language={language}
                    program={program}
                    lens={lens}
                    disabled={sending}
                    onPin={(courseNumber, requirementId) =>
                      send((basedOn) =>
                        pinCourse(api, { courseNumber, requirementsFile: program.requirementsFile, requirementId }, basedOn),
                      )
                    }
                    onUnpin={(courseNumber, requirementId) =>
                      send((basedOn) =>
                        unpinCourse(api, { courseNumber, requirementsFile: program.requirementsFile, requirementId }, basedOn),
                      )
                    }
                    onTick={(requirementId, ticked) =>
                      send((basedOn) =>
                        (ticked ? tickManual : untickManual)(
                          api,
                          { requirementsFile: program.requirementsFile, requirementId },
                          basedOn,
                        ),
                      )
                    }
                  />
                ) : (
                  <section key={`${program.requirementsFile}:${index}`} className="mb-6">
                    <h2 className="text-base font-semibold">{program.requirementsFile}</h2>
                    <p className="text-sm text-pencil">
                      {t(
                        language,
                        program.status === "missing"
                          ? "progressProgramMissing"
                          : program.status === "refused"
                            ? "progressProgramRefused"
                            : "progressProgramUnreadable",
                        { file: program.requirementsFile },
                      )}
                    </p>
                  </section>
                ),
              )
            )}
          </>
        )}
      </div>
    </main>
  );
}

/** What the screen says about the read itself, and nothing once it is served. */
function statusSaid(language: Language, progress: ProgressState, tokenHeld: boolean): string | undefined {
  switch (progress.kind) {
    case "loading":
      return t(language, "progressLoading");
    case "served":
      return undefined;
    case "refused":
      return t(language, progress.reason === undefined ? "progressFileUnreadable" : REFUSAL_STRING[progress.reason]);
    case "unauthorized":
      return unauthorizedSaid(language, tokenHeld);
    case "unreadable-answer":
      return t(language, "progressAnswerUnreadable");
    case "unreachable":
      return t(language, "apiUnreachable");
  }
}

/** Warnings, shown and never blocking anything. */
function Warnings({ language, warnings }: { language: Language; warnings: readonly AnyWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul data-progress-warnings className="mb-4 list-disc space-y-1 ps-5 text-sm text-ink-soft">
      {warnings.map((warning, index) => (
        <li key={`${warning.kind}:${index}`}>{warningSaid(language, warning)}</li>
      ))}
    </ul>
  );
}

/**
 * The screen when no Program is chosen: it says so, and offers the Requirements Files in the
 * Workspace to choose one from, with its Track. Re-read when the Workspace changes, so a file
 * dropped into `requirements/` is offered without leaving the screen.
 *
 * It chooses one Program. Changing a choice, adding a double major's second Program and setting
 * the Cohort are the API's (`PUT /api/programs`, `PUT /api/cohort`) and have no control here yet.
 */
function ProgramChooser({
  language,
  workspaceChanges,
  disabled,
  onChoose,
}: {
  language: Language;
  workspaceChanges: number;
  disabled: boolean;
  onChoose: (programs: { requirementsFile: string; track?: string }[]) => void;
}): React.JSX.Element {
  const [files, setFiles] = useState<ListedRequirements[] | undefined | "loading">("loading");
  const [file, setFile] = useState<string>("");
  const [track, setTrack] = useState<string>("");
  useEffect(() => {
    void fetchRequirementsFiles(api).then(setFiles);
  }, [workspaceChanges]);

  const readable = Array.isArray(files) ? files.filter((entry) => entry.status === "read") : [];
  const chosen = readable.find((entry) => entry.name === file);

  return (
    <section data-program-chooser className="max-w-xl space-y-3">
      <p>{t(language, "progressNoProgram")}</p>
      {files === "loading" ? null : readable.length === 0 ? (
        <p className="text-sm text-pencil">{t(language, "progressNoRequirementsFiles")}</p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (file === "") return;
            onChoose([track === "" ? { requirementsFile: file } : { requirementsFile: file, track }]);
          }}
        >
          <label className="flex flex-col text-sm">
            {t(language, "progressChooseProgram")}
            <select
              data-choose="file"
              value={file}
              onChange={(event) => {
                setFile(event.target.value);
                setTrack("");
              }}
              className="rounded-sm border border-rule bg-paper px-2 py-1"
            >
              <option value="">—</option>
              {readable.map((entry) =>
                entry.status === "read" ? (
                  <option key={entry.name} value={entry.name}>
                    {`${localized(language, entry.program.name) ?? entry.program.id} (${entry.name})`}
                  </option>
                ) : null,
              )}
            </select>
          </label>
          {chosen?.status === "read" && chosen.tracks.length > 0 && (
            <label className="flex flex-col text-sm">
              {t(language, "progressChooseTrack")}
              <select
                data-choose="track"
                value={track}
                onChange={(event) => setTrack(event.target.value)}
                className="rounded-sm border border-rule bg-paper px-2 py-1"
              >
                <option value="">{t(language, "progressNoTrack")}</option>
                {chosen.tracks.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {localized(language, entry.name) ?? entry.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="submit"
            data-choose="submit"
            disabled={disabled || file === ""}
            className="rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft disabled:opacity-50"
          >
            {t(language, "progressChoose")}
          </button>
        </form>
      )}
    </section>
  );
}

/** The numbers a node shows in one lens: credits of needed, k of N, or a cap's use. */
function numbersSaid(language: Language, evaluation: EvaluatedRequirement["completed"]): string | undefined {
  if (evaluation.credits !== undefined) {
    return t(language, "progressCredits", { counted: evaluation.credits.counted, needed: evaluation.credits.needed });
  }
  if (evaluation.met !== undefined) {
    return t(language, "progressMet", { count: evaluation.met.count, needed: evaluation.met.needed });
  }
  if (evaluation.capped !== undefined) {
    return t(language, "progressCapped", { counted: evaluation.capped.counted, max: evaluation.capped.max });
  }
  return undefined;
}

/**
 * One Program: its tree, navigable as a tree (`role="tree"`, one tab stop, arrow keys move between
 * nodes), and below it the student's Courses, each with where it can be pinned.
 */
function ProgramTree({
  language,
  program,
  lens,
  disabled,
  onPin,
  onUnpin,
  onTick,
}: {
  language: Language;
  program: EvaluatedProgram;
  lens: Lens;
  disabled: boolean;
  onPin: (courseNumber: string, requirementId: string) => void;
  onUnpin: (courseNumber: string, requirementId: string) => void;
  onTick: (requirementId: string, ticked: boolean) => void;
}): React.JSX.Element {
  const rows = walk(program.progress.requirements);
  const [focused, setFocused] = useState(0);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const pinned = (courseNumber: string, requirementId: string): boolean =>
    program.pins.some((pin) => pin.courseNumber === courseNumber && pin.requirementId === requirementId);
  const names = new Map(rows.map(({ node }) => [node.id, nameOf(language, node)]));
  const title = localized(language, program.program.name) ?? program.program.id;

  const move = (to: number): void => {
    const next = Math.max(0, Math.min(rows.length - 1, to));
    setFocused(next);
    items.current[next]?.focus();
  };

  return (
    <section data-program={program.requirementsFile} className="mb-8">
      <h2 className="text-base font-semibold">
        {title}
        <span className="ms-2 text-sm font-normal text-pencil">
          {t(language, STATUS_STRING[program.progress.status[lens]])} ·{" "}
          {t(language, "progressTotalCredits", { credits: program.progress.totalCredits[lens] })}
        </span>
      </h2>
      <Warnings language={language} warnings={program.progress.warnings} />
      <ul
        role="tree"
        aria-label={title}
        className="mt-2 space-y-1"
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) return;
          if (event.key === "ArrowDown") move(focused + 1);
          else if (event.key === "ArrowUp") move(focused - 1);
          else if (event.key === "Home") move(0);
          else if (event.key === "End") move(rows.length - 1);
          else return;
          event.preventDefault();
        }}
      >
        {rows.map(({ node, level }, index) => {
          const evaluation = node[lens];
          const numbers = numbersSaid(language, evaluation);
          return (
            <li
              key={node.id}
              ref={(element) => {
                items.current[index] = element;
              }}
              role="treeitem"
              aria-level={level}
              aria-selected={focused === index}
              tabIndex={focused === index ? 0 : -1}
              onFocus={() => setFocused(index)}
              data-requirement={node.id}
              data-status={evaluation.status}
              style={{ paddingInlineStart: `${(level - 1) * 1.25}rem` }}
              className="rounded-xs py-1"
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span
                  data-status-badge
                  className={
                    evaluation.status === "satisfied"
                      ? "font-semibold text-ink"
                      : evaluation.status === "partial"
                        ? "text-ink-soft"
                        : "text-pencil"
                  }
                >
                  {t(language, STATUS_STRING[evaluation.status])}
                </span>
                <span>{nameOf(language, node)}</span>
                {numbers === undefined ? null : <span className="text-sm text-pencil">{numbers}</span>}
              </span>
              {node.kind === "manual" && (
                <span className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-ink-soft">{localized(language, node.text)}</span>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      data-tick={node.id}
                      checked={node.ticked === true}
                      disabled={disabled}
                      onChange={(event) => onTick(node.id, event.target.checked)}
                    />
                    {t(language, "progressTicked")}
                  </label>
                </span>
              )}
              {evaluation.courses.length > 0 && node.children.length === 0 && (
                <span className="mt-1 flex flex-wrap gap-1 text-sm">
                  {evaluation.courses.map((course) => (
                    <span
                      key={course}
                      data-course={course}
                      data-pinned={pinned(course, node.id) ? "true" : undefined}
                      className="rounded-xs border border-rule bg-paper px-2"
                    >
                      {course}
                      {pinned(course, node.id) ? ` · ${t(language, "progressPinned")}` : ""}
                    </span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <h3 className="mt-4 text-sm font-semibold">{t(language, "progressCoursesHeading")}</h3>
      <ul className="mt-1 space-y-1 text-sm">
        {program.candidates.map(({ courseNumber, requirementIds }) => {
          const pin = program.pins.find((held) => held.courseNumber === courseNumber);
          return (
            <li key={courseNumber} data-candidates={courseNumber} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{courseNumber}</span>
              {requirementIds.length === 0 ? (
                <span className="text-pencil">{t(language, "progressNowhereToPin")}</span>
              ) : (
                <label className="flex items-center gap-1">
                  {t(language, "progressPinTo")}
                  <select
                    data-pin-course={courseNumber}
                    value={pin?.requirementId ?? ""}
                    disabled={disabled}
                    onChange={(event) => {
                      // "decided for you" is the Pin taken away, so the solver decides again
                      if (event.target.value !== "") onPin(courseNumber, event.target.value);
                      else if (pin !== undefined) onUnpin(courseNumber, pin.requirementId);
                    }}
                    className="rounded-sm border border-rule bg-paper px-2 py-0.5"
                  >
                    <option value="">{t(language, "progressSolverDecides")}</option>
                    {requirementIds.map((id) => (
                      <option key={id} value={id}>
                        {names.get(id) ?? id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {pin !== undefined && (
                <button
                  type="button"
                  data-unpin={courseNumber}
                  disabled={disabled}
                  onClick={() => onUnpin(courseNumber, pin.requirementId)}
                  className="rounded-sm border border-rule bg-paper px-2 py-0.5 text-ink-soft disabled:opacity-50"
                >
                  {t(language, "progressUnpin")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The Progress screen's entry in the registry: after the Timetable, at `/progress`. */
export const PROGRESS_SCREEN: ScreenDefinition = {
  path: "/progress",
  label: "progress",
  render: (props) => <ProgressScreen {...props} />,
};
