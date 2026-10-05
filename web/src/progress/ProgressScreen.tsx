import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { unauthorizedSaid, type ScreenDefinition, type ScreenProps } from "../AppShell.tsx";
import { t, type Language, type StringKey } from "../i18n/strings.ts";
import {
  chooseCohort,
  choosePrograms,
  fetchProgress,
  fetchRequirementsFiles,
  pinCourse,
  tickManual,
  unpinCourse,
  untickManual,
  whatIfChanges,
  type Cohort,
  type EngineWarning,
  type EvaluatedProgram,
  type EvaluatedRequirement,
  type Lens,
  type ListedRequirements,
  type PinWarning,
  type ProgramChoice,
  type ProgramProgress,
  type ProgramsChoice,
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
 * Above the trees, the student's Programs and Cohort (#331): change a Program or its Track, add or
 * remove a double major's second Program, set or clear the Cohort. Each change is the whole list or
 * the Cohort sent to the existing route (`PUT /api/programs`, `PUT /api/cohort`), one undo step, and
 * the Warning about a Program — its file missing, its Track unknown — is drawn on that Program's row,
 * beside the controls that fix it.
 *
 * And "what if I switched Track" (#289): the same Programs panel drafting a list the page keeps,
 * whose Progress the server evaluates and never saves, shown instead of the real one, marked, and
 * compared with it by Requirement id. Adopting it is the set-Programs edit above; leaving it is
 * dropping the draft.
 *
 * It reaches the domain only through the typed client (`./progress.ts`), and it invents no Pin
 * candidate: the Requirements a Course is offered are the ones the engine says it can count toward.
 */

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

/** The Requirements Files to choose from, re-read when the Workspace changes. */
function useRequirementsFiles(workspaceChanges: number): ListedRequirements[] | undefined | "loading" {
  const [files, setFiles] = useState<ListedRequirements[] | undefined | "loading">("loading");
  useEffect(() => {
    let current = true;
    void fetchRequirementsFiles(api).then((listed) => {
      if (current) setFiles(listed);
    });
    return () => {
      current = false;
    };
  }, [workspaceChanges]);
  return files;
}

/** The Programs a read was evaluated for, as the student chose them, in their order. */
const choicesOf = (programs: readonly { requirementsFile: string; track?: string | undefined }[]): ProgramChoice[] =>
  programs.map(({ requirementsFile, track }) =>
    track === undefined ? { requirementsFile } : { requirementsFile, track },
  );

/** A save answered without Progress, as the answer `send` expects: Progress read again after it. */
async function thenProgress(chosen: Promise<ProgramsChoice>): Promise<ProgressResult> {
  const answer = await chosen;
  if (answer.kind !== "saved") {
    return answer.kind === "refused" ? { kind: "refused", reason: answer.reason } : answer;
  }
  return fetchProgress(api);
}

/** Whether two lists name the same Programs with the same Tracks, in the same order. */
const sameChoices = (a: readonly ProgramChoice[], b: readonly ProgramChoice[]): boolean =>
  a.length === b.length &&
  a.every((program, index) => program.requirementsFile === b[index]!.requirementsFile && program.track === b[index]!.track);

/**
 * What the server makes of a what-if (#289), asked again whenever the what-if or the real Progress
 * it is compared with changes — an undo or a file changed under an open what-if is read again as
 * real Progress, and the comparison has to follow it. Nothing is asked while the what-if is the
 * real choice.
 */
function usePreview(whatIf: ProgramChoice[] | undefined, progress: ProgressState): ProgressState | undefined {
  const [preview, setPreview] = useState<ProgressState | undefined>(undefined);
  const real = progress.kind === "served" ? progress : undefined;
  const asked = whatIf === undefined || real === undefined || sameChoices(whatIf, choicesOf(real.programs)) ? undefined : whatIf;
  const question = asked === undefined ? undefined : JSON.stringify(asked);
  useEffect(() => {
    if (asked === undefined) {
      setPreview(undefined);
      return;
    }
    let current = true;
    setPreview({ kind: "loading" });
    void fetchProgress(api, asked).then((answer) => {
      if (current) setPreview(answer);
    });
    return () => {
      current = false;
    };
    // `question` is `asked` by value: a new array with the same Programs is not a new question
  }, [question, real]);
  return preview;
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
  const files = useRequirementsFiles(workspaceChanges);

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

  /**
   * "What if I switched Track" (#289): the Programs being tried, which are page state and nothing
   * else — not a Device Preference, not stored — and what the server makes of them. `undefined` is
   * the student's real Progress on screen.
   */
  const [whatIf, setWhatIf] = useState<ProgramChoice[] | undefined>(undefined);
  const preview = usePreview(whatIf, progress);
  const unchanged =
    whatIf !== undefined && progress.kind === "served" && sameChoices(whatIf, choicesOf(progress.programs));

  /**
   * One edit on the view on screen, answered with Progress as it stands afterwards; `then` runs
   * once it is saved and served.
   */
  const send = (edit: (basedOn: string | undefined) => Promise<ProgressResult>, then?: () => void): void => {
    if (progress.kind !== "served" || sending) return;
    onActed();
    setEditRefused(undefined);
    setSending(true);
    void edit(progress.version).then((answer) => {
      setSending(false);
      if (answer.kind === "served") {
        setProgress(answer);
        onEdited();
        then?.();
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
                // a Warning about one Program is drawn on its row, beside what fixes it
                ...progress.programWarnings.filter((warning) => !("index" in warning)),
                ...progress.solverWarnings,
                ...progress.pinWarnings,
              ]}
            />
            <CohortForm
              language={language}
              cohort={progress.cohort}
              disabled={sending}
              onCohort={(cohort) => send((basedOn) => thenProgress(chooseCohort(api, cohort, basedOn)))}
            />
            {progress.programs.length === 0 ? (
              <ProgramChooser
                language={language}
                files={files}
                disabled={sending}
                onChoose={(programs) => send((basedOn) => thenProgress(choosePrograms(api, programs, basedOn)))}
              />
            ) : whatIf === undefined ? (
              <>
                <ProgramsPanel
                  language={language}
                  programs={choicesOf(progress.programs)}
                  files={files}
                  warnings={progress.programWarnings}
                  disabled={sending}
                  onPrograms={(programs) => send((basedOn) => thenProgress(choosePrograms(api, programs, basedOn)))}
                />
                <button
                  type="button"
                  data-what-if="start"
                  onClick={() => setWhatIf(choicesOf(progress.programs))}
                  className="mb-6 rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft"
                >
                  {t(language, "progressWhatIfStart")}
                </button>
              </>
            ) : (
              <section
                data-what-if
                aria-label={t(language, "progressWhatIfHeading")}
                className="mb-6 rounded-sm border border-dashed border-ink-soft bg-hint p-3"
              >
                <p className="mb-2 text-sm">
                  <span className="font-semibold">{t(language, "progressWhatIfHeading")}</span>{" "}
                  <span className="text-ink-soft">{t(language, "progressWhatIfNote")}</span>
                </p>
                <ProgramsPanel
                  language={language}
                  programs={whatIf}
                  files={files}
                  warnings={preview?.kind === "served" ? preview.programWarnings : []}
                  disabled={sending}
                  onPrograms={setWhatIf}
                />
                <span className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-what-if="adopt"
                    disabled={sending || unchanged}
                    // adopting is the set-Programs edit #331 puts on screen: one save, one undo step
                    onClick={() =>
                      send(
                        (basedOn) => thenProgress(choosePrograms(api, whatIf, basedOn)),
                        () => setWhatIf(undefined),
                      )
                    }
                    className="rounded-sm border border-ink bg-paper px-3 py-1 text-sm font-semibold text-ink disabled:opacity-50"
                  >
                    {t(language, "progressWhatIfAdopt")}
                  </button>
                  <button
                    type="button"
                    data-what-if="leave"
                    onClick={() => setWhatIf(undefined)}
                    className="rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft"
                  >
                    {t(language, "progressWhatIfLeave")}
                  </button>
                </span>
              </section>
            )}
            {whatIf === undefined || unchanged ? (
              <>
                {unchanged && <p className="mb-4 text-sm text-pencil">{t(language, "progressWhatIfSame")}</p>}
                {progress.programs.map((program, index) =>
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
                    <Unevaluated key={`${program.requirementsFile}:${index}`} language={language} program={program} />
                  ),
                )}
              </>
            ) : (
              <WhatIfView
                language={language}
                real={progress.programs}
                preview={preview ?? { kind: "loading" }}
                lens={lens}
                tokenHeld={tokenHeld}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

/** A chosen Program that could not be evaluated, and why. */
function Unevaluated({
  language,
  program,
}: {
  language: Language;
  program: Exclude<ProgramProgress, { status: "evaluated" }>;
}): React.JSX.Element {
  return (
    <section className="mb-6">
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
  );
}

const CHANGE_STRING = {
  satisfied: "progressWhatIfSatisfied",
  missing: "progressWhatIfMissing",
  dropped: "progressWhatIfDropped",
} as const satisfies Record<"satisfied" | "missing" | "dropped", StringKey>;

/**
 * The what-if's Progress (#289), shown instead of the real one and marked as a what-if all the way
 * down: its Warnings — a Pin it would leave reaching nothing among them — and for each Program what
 * would change against the real one by Requirement id, then its tree, read-only, since a Pin or a
 * tick made in a what-if would be an edit to the real file under a view that is not of it.
 *
 * What changes is compared only against a real Program with the same Requirements File: ids are
 * unique within one file, so across two files they name unrelated Requirements.
 */
function WhatIfView({
  language,
  real,
  preview,
  lens,
  tokenHeld,
}: {
  language: Language;
  real: readonly ProgramProgress[];
  preview: ProgressState;
  lens: Lens;
  tokenHeld: boolean;
}): React.JSX.Element {
  if (preview.kind !== "served") {
    return (
      <p data-what-if-view role="status" className="text-sm text-pencil">
        {statusSaid(language, preview, tokenHeld)}
      </p>
    );
  }
  return (
    <div data-what-if-view className="rounded-sm border border-dashed border-ink-soft p-3">
      <Warnings
        language={language}
        warnings={[
          ...preview.programWarnings.filter((warning) => !("index" in warning)),
          ...preview.solverWarnings,
          ...preview.pinWarnings,
        ]}
      />
      {preview.programs.map((program, index) => {
        const key = `${program.requirementsFile}:${index}`;
        if (program.status !== "evaluated") return <Unevaluated key={key} language={language} program={program} />;
        const now = real.find(
          (held): held is Extract<ProgramProgress, { status: "evaluated" }> =>
            held.status === "evaluated" && held.requirementsFile === program.requirementsFile,
        );
        const changes = now === undefined ? undefined : whatIfChanges(now, program, lens);
        const names = new Map(
          [...walk(now?.progress.requirements ?? []), ...walk(program.progress.requirements)].map(({ node }) => [
            node.id,
            nameOf(language, node),
          ]),
        );
        return (
          <div key={key}>
            <div data-what-if-changes={program.requirementsFile} className="mb-3 text-sm">
              {changes === undefined ? (
                <p className="text-pencil">{t(language, "progressWhatIfOtherProgram", { file: program.requirementsFile })}</p>
              ) : changes.satisfied.length + changes.missing.length + changes.dropped.length === 0 ? (
                <p className="text-pencil">{t(language, "progressWhatIfNoChange")}</p>
              ) : (
                (["satisfied", "missing", "dropped"] as const).map((which) =>
                  changes[which].length === 0 ? null : (
                    <p key={which} data-what-if-change={which}>
                      <span className="font-semibold">{t(language, CHANGE_STRING[which])}</span>{" "}
                      {changes[which].map((id, at) => (
                        <span key={id} data-requirement-changed={id}>
                          {at === 0 ? "" : t(language, "progressListSeparator")}
                          {names.get(id) ?? id}
                        </span>
                      ))}
                    </p>
                  ),
                )
              )}
            </div>
            <ProgramTree
              language={language}
              program={program}
              lens={lens}
              disabled
              readOnly
              mark={t(language, "progressWhatIfHeading")}
              onPin={() => {}}
              onUnpin={() => {}}
              onTick={() => {}}
            />
          </div>
        );
      })}
    </div>
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

/** The Requirements Files a Program can be chosen from: the ones this build could read. */
const readableOf = (files: ListedRequirements[] | undefined | "loading"): ListedRequirements[] =>
  Array.isArray(files) ? files.filter((entry) => entry.status === "read") : [];

/** A Requirements File as the student picks it: its Program's name, and the file's own name. */
function fileSaid(language: Language, entry: ListedRequirements): string {
  return entry.status === "read"
    ? `${localized(language, entry.program.name) ?? entry.program.id} (${entry.name})`
    : entry.name;
}

/**
 * The screen when no Program is chosen: it says so, and offers the Requirements Files in the
 * Workspace to choose one from, with its Track. The listing is re-read when the Workspace changes,
 * so a file dropped into `requirements/` is offered without leaving the screen.
 *
 * It chooses one Program; once one is chosen, `ProgramsPanel` is where the list is changed.
 */
function ProgramChooser({
  language,
  files,
  disabled,
  onChoose,
}: {
  language: Language;
  files: ListedRequirements[] | undefined | "loading";
  disabled: boolean;
  onChoose: (programs: ProgramChoice[]) => void;
}): React.JSX.Element {
  const [file, setFile] = useState<string>("");
  const [track, setTrack] = useState<string>("");

  const readable = readableOf(files);
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
              {readable.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {fileSaid(language, entry)}
                </option>
              ))}
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

/** The Semesters a Cohort can start in, in the order of the year. */
const SEMESTERS = ["fall", "spring", "summer"] as const;
const SEMESTER_STRING = {
  fall: "semesterFall",
  spring: "semesterSpring",
  summer: "semesterSummer",
} as const satisfies Record<(typeof SEMESTERS)[number], StringKey>;

/**
 * The student's Cohort (#331): what it is, and a form to set or clear it. The year is the Academic
 * Year, named by the Gregorian year it ends in (`CONTEXT.md`), so it is typed as a number. The form
 * starts from the Cohort the server holds, and starts again whenever that changes.
 */
function CohortForm({
  language,
  cohort,
  disabled,
  onCohort,
}: {
  language: Language;
  cohort: Cohort;
  disabled: boolean;
  onCohort: (cohort: Cohort) => void;
}): React.JSX.Element {
  const [year, setYear] = useState(cohort === null ? "" : String(cohort.academicYear));
  const [semester, setSemester] = useState<(typeof SEMESTERS)[number]>(cohort?.semester ?? "fall");
  useEffect(() => {
    setYear(cohort === null ? "" : String(cohort.academicYear));
    setSemester(cohort?.semester ?? "fall");
  }, [cohort?.academicYear, cohort?.semester]);
  const typed = Number(year);
  const valid = year.trim() !== "" && Number.isInteger(typed);

  return (
    <form
      data-cohort
      aria-label={t(language, "progressCohort")}
      className="mb-4 flex flex-wrap items-end gap-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onCohort({ academicYear: typed, semester });
      }}
    >
      <span className="self-center">
        {t(language, "progressCohort")}:{" "}
        <span data-cohort-said className="font-semibold">
          {cohort === null
            ? t(language, "progressCohortNone")
            : t(language, "progressCohortSaid", {
                year: cohort.academicYear,
                semester: t(language, SEMESTER_STRING[cohort.semester]),
              })}
        </span>
      </span>
      <label className="flex flex-col">
        {t(language, "progressCohortYear")}
        <input
          type="number"
          inputMode="numeric"
          data-cohort-year
          value={year}
          onChange={(event) => setYear(event.target.value)}
          className="w-24 rounded-sm border border-rule bg-paper px-2 py-1"
        />
      </label>
      <label className="flex flex-col">
        {t(language, "progressCohortSemester")}
        <select
          data-cohort-semester
          value={semester}
          onChange={(event) => setSemester(event.target.value as (typeof SEMESTERS)[number])}
          className="rounded-sm border border-rule bg-paper px-2 py-1"
        >
          {SEMESTERS.map((which) => (
            <option key={which} value={which}>
              {t(language, SEMESTER_STRING[which])}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        data-cohort-set
        disabled={disabled || !valid}
        className="rounded-sm border border-rule bg-paper px-3 py-1 text-ink-soft disabled:opacity-50"
      >
        {t(language, "progressCohortSet")}
      </button>
      {cohort === null ? null : (
        <button
          type="button"
          data-cohort-clear
          disabled={disabled}
          onClick={() => onCohort(null)}
          className="rounded-sm border border-rule bg-paper px-3 py-1 text-ink-soft disabled:opacity-50"
        >
          {t(language, "progressCohortClear")}
        </button>
      )}
    </form>
  );
}

/** A double major is two Programs; the panel offers no third. */
const MOST_PROGRAMS = 2;

/**
 * The student's Programs, one row each (#331): its Requirements File and its Track, each a select
 * whose change is the whole list sent again with that one entry changed, and a remove. Below the
 * rows, while there is room for one, a second Program to add.
 *
 * **What the student holds is always shown, even when it cannot be offered.** A file the Workspace
 * no longer holds, or a Track its file does not define, stays the select's value as an option that
 * says so, rather than the select falling back to the first offer and showing a choice nobody made.
 * The Warning about the row is drawn in it, beside the select that fixes it and the remove.
 *
 * `onPrograms` is the only thing a row does, so the same panel drafts a what-if (#289) when its
 * caller keeps the list instead of saving it.
 */
function ProgramsPanel({
  language,
  programs,
  files,
  warnings,
  disabled,
  onPrograms,
}: {
  language: Language;
  programs: ProgramChoice[];
  files: ListedRequirements[] | undefined | "loading";
  warnings: readonly ProgramsWarning[];
  disabled: boolean;
  onPrograms: (programs: ProgramChoice[]) => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState("");
  const readable = readableOf(files);
  const replaced = (index: number, program: ProgramChoice): ProgramChoice[] =>
    programs.map((held, at) => (at === index ? program : held));

  return (
    <section data-programs className="mb-6 max-w-3xl space-y-2 text-sm">
      <h2 className="text-base font-semibold">{t(language, "progressProgramsHeading")}</h2>
      <ul className="space-y-2">
        {programs.map((program, index) => {
          const listed = readable.find((entry) => entry.name === program.requirementsFile);
          const tracks = listed?.status === "read" ? listed.tracks : [];
          const trackHeld = program.track !== undefined && !tracks.some((track) => track.id === program.track);
          const mine = warnings.filter((warning) => "index" in warning && warning.index === index);
          return (
            <li key={index} data-program-row={index} className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col">
                {t(language, "progressChooseProgram")}
                <select
                  data-program-file={index}
                  value={program.requirementsFile}
                  disabled={disabled}
                  // another file is another rule set: its Tracks are not this one's
                  onChange={(event) => onPrograms(replaced(index, { requirementsFile: event.target.value }))}
                  className="rounded-sm border border-rule bg-paper px-2 py-1"
                >
                  {listed === undefined && (
                    <option value={program.requirementsFile}>
                      {t(language, "progressFileNotOffered", { file: program.requirementsFile })}
                    </option>
                  )}
                  {readable.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {fileSaid(language, entry)}
                    </option>
                  ))}
                </select>
              </label>
              {listed !== undefined && (tracks.length > 0 || trackHeld) && (
                <label className="flex flex-col">
                  {t(language, "progressChooseTrack")}
                  <select
                    data-program-track={index}
                    value={program.track ?? ""}
                    disabled={disabled}
                    onChange={(event) =>
                      onPrograms(
                        replaced(
                          index,
                          event.target.value === ""
                            ? { requirementsFile: program.requirementsFile }
                            : { requirementsFile: program.requirementsFile, track: event.target.value },
                        ),
                      )
                    }
                    className="rounded-sm border border-rule bg-paper px-2 py-1"
                  >
                    <option value="">{t(language, "progressNoTrack")}</option>
                    {trackHeld && (
                      <option value={program.track}>
                        {t(language, "progressTrackNotOffered", { track: program.track ?? "" })}
                      </option>
                    )}
                    {tracks.map((track) => (
                      <option key={track.id} value={track.id}>
                        {localized(language, track.name) ?? track.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                data-program-remove={index}
                disabled={disabled}
                onClick={() => onPrograms(programs.filter((_, at) => at !== index))}
                className="rounded-sm border border-rule bg-paper px-3 py-1 text-ink-soft disabled:opacity-50"
              >
                {t(language, "progressRemoveProgram")}
              </button>
              {mine.length === 0 ? null : (
                <ul data-program-warnings={index} className="basis-full list-disc ps-5 text-ink-soft">
                  {mine.map((warning, at) => (
                    <li key={`${warning.kind}:${at}`}>{warningSaid(language, warning)}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {programs.length < MOST_PROGRAMS && readable.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (adding === "") return;
            onPrograms([...programs, { requirementsFile: adding }]);
            setAdding("");
          }}
        >
          <label className="flex flex-col">
            {t(language, "progressAddProgram")}
            <select
              data-program-add
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
              className="rounded-sm border border-rule bg-paper px-2 py-1"
            >
              <option value="">—</option>
              {readable.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {fileSaid(language, entry)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            data-program-add-submit
            disabled={disabled || adding === ""}
            className="rounded-sm border border-rule bg-paper px-3 py-1 text-ink-soft disabled:opacity-50"
          >
            {t(language, "progressAdd")}
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
  readOnly = false,
  mark,
  onPin,
  onUnpin,
  onTick,
}: {
  language: Language;
  program: EvaluatedProgram;
  lens: Lens;
  disabled: boolean;
  /** A what-if's tree (#289): shown, and nothing on it edits, so the Courses' Pin controls go. */
  readOnly?: boolean;
  /** What marks the heading as not the student's real Progress, when it is not. */
  mark?: string;
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
        {mark === undefined ? null : (
          <span data-what-if-mark className="me-2 rounded-xs border border-dashed border-ink-soft px-1 text-sm font-normal">
            {mark}
          </span>
        )}
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

      {readOnly ? null : (
        <>
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
        </>
      )}
    </section>
  );
}

/** The Progress screen's entry in the registry: after the Timetable, at `/progress`. */
export const PROGRESS_SCREEN: ScreenDefinition = {
  path: "/progress",
  label: "progress",
  render: (props) => <ProgressScreen {...props} />,
};
