import { useCallback, useState } from "react";
import { HistoryControls } from "./HistoryControls.tsx";
import { useHistory, type Direction, type HistoryRefusal, type HistoryStep } from "./history.ts";
import { DIRECTION, t, type Language, type StringKey } from "./i18n/strings.ts";
import { screenFor, useLocationPath, type LocationBrowser } from "./route.ts";
import { SchemeControl } from "./SchemeControl.tsx";
import type {
  SettingsNotice,
  SettingsRefusal,
  SettingsUnread,
  SettingsWarning,
} from "./settings.ts";

/**
 * The app shell (#294): the parts every screen shares, and the screen that is open.
 *
 * `docs/design.md` lists five screens, and until this the root component handed the language and
 * the Workspace watcher straight to the Timetable, so the shared things — the language switch, the
 * scheme control, undo and redo, the token notice — lived inside one screen. They live here now,
 * in one header over whichever screen is open, and behave as they did: undo is still one stack per
 * State File (ADR-0013), asked of the server, and a press is still based on the revision the open
 * screen is showing.
 *
 * **Screens are a list of what is built**, handed in rather than imported here, so a screen that
 * is not built yet is absent rather than shown empty — nothing here knows any screen by name — and
 * the shell can be tested with screens of a test's own. `./screens.tsx` is the registry the app
 * opens with; `./timetable/TimetableScreen.tsx` hands the shell the Timetable alone.
 *
 * **The open screen is the URL's path** (`./route.ts`, which says why not the fragment: that is the
 * Launch Token's). The first screen in the list is the landing screen, which is the Timetable.
 */

/** What a screen reports as the revision it is showing, so the shell can step from it. */
export type ScreenRevision = {
  /** The State File revision the screen's answer carried: what an undo is based on. */
  version: string;
  /**
   * The answer itself, held by identity, so the shell can wait for a *newer* answer after a step
   * rather than for a different revision string — a file reverted to the revision it had is still
   * news, and waiting for a different string would wait for ever.
   */
  answer: object;
};

/** What the shell hands every screen. */
export type ScreenProps = {
  language: Language;
  tokenHeld: boolean;
  today: Date;
  /** The Workspace change count, which moves when the folder does: the screen re-reads on it. */
  workspaceChanges: number;
  /**
   * How many times an undo or redo has asked the open screen to re-read: a step's answer carries
   * the new revision but not what the screen draws, so the screen goes and looks.
   */
  stepRereads: number;
  /** How many presses of undo or redo there have been: a screen retires its own notices on one. */
  steps: number;
  /**
   * The screen wrote the State File, or may have: the shell re-asks whether there is anything to
   * undo, and tells whatever else holds a revision — the language switch — to go and look.
   */
  onEdited: () => void;
  /** The student did something on the screen, which retires the shell's account of the last step. */
  onActed: () => void;
  /** The revision the screen is showing, or `undefined` while there is none a step may be based on. */
  onRevision: (revision: ScreenRevision | undefined) => void;
  /**
   * The shell's own notices — the last step, the last preference — for the screen to say in its
   * live region beside its own, so a student finds every account of what just happened in one
   * place whichever screen they are on.
   */
  notices: React.ReactNode;
};

/** One screen that is built: where it lives, what the navigation calls it, and the screen. */
export type ScreenDefinition = {
  /** Its path, which is what a bookmark holds. The first screen's is the landing path. */
  path: string;
  /** Its name in the navigation, as a key into the translation files. */
  label: StringKey;
  /** A line beside the navigation that only this screen has, such as the Semester it shows. */
  subtitle?: (language: Language, today: Date) => string;
  render: (props: ScreenProps) => React.JSX.Element;
};

export type AppShellProps = {
  screens: readonly ScreenDefinition[];
  language: Language;
  /**
   * How the language switch is honoured, or `undefined` for *not now* — the settings have not been
   * read, or a change is already in flight (`./settings.ts`). The switch is then disabled.
   */
  onLanguage: ((language: Language) => void) | undefined;
  /** What the last change to a preference did, when it did nothing (#115). */
  settingsNotice?: SettingsNotice | undefined;
  /** The Warnings the settings were read with; `settings-unreadable` is the one shown. */
  settingsWarnings?: readonly SettingsWarning[];
  /** That the page has no word on the preferences, and which of three things that means (#207). */
  settingsUnread?: SettingsUnread | undefined;
  /** Called when a screen has written the State File, or may have (#206, #231). */
  onEdited?: (() => void) | undefined;
  /** Whether this page holds a launch token at all, which tells a retired one from none (#126). */
  tokenHeld?: boolean;
  /** Taken as an argument so the app can be opened on any date, and tested. */
  today?: Date;
  /** The Workspace change count, asked for once by `App` (`./changes.ts`). */
  workspaceChanges?: number;
  /** The window whose path is the open screen; a test may hand a stand-in. */
  browser?: LocationBrowser;
};

/**
 * Why an undo or a redo did nothing, in words the student can act on. Exhaustive against the
 * contract, so a reason added to `server/src/history.ts` is a compile error here rather than a
 * refusal the student never hears about.
 *
 * Five of the nine are the edit refusals an undo inherits by going through the same save path
 * (ADR-0013), and four of those five get their own sentence rather than the Pick's: `picksStale`
 * is an account of a click that was not saved, and a student who pressed Undo did not click a
 * Group. `workspace-not-ready` is the exception — "this folder is not a workspace yet, so nothing
 * can be saved in it" is the whole truth for either.
 */
const HISTORY_REFUSAL_STRING = {
  "nothing-to-undo": "historyNothingToUndo",
  "nothing-to-redo": "historyNothingToRedo",
  "state-file-missing": "historyFileMissing",
  "history-invalidated": "historyInvalidated",
  "state-file-changed": "historyStale",
  "state-file-unreadable": "historyUnreadable",
  "workspace-refused": "historyUnreadable",
  "workspace-not-ready": "workspaceNotReady",
  "backup-refused": "historyBackupRefused",
} as const satisfies Record<NonNullable<HistoryRefusal>, StringKey>;

/**
 * Why a change to a preference did nothing. `state-file-changed` gets its own sentence rather than
 * `picksStale`'s, because a student who used the language switch clicked no Group (#111).
 */
const SETTINGS_REFUSAL_STRING = {
  "workspace-not-ready": "workspaceNotReady",
  "state-file-unreadable": "settingsFileUnreadable",
  "state-file-changed": "settingsStale",
  "workspace-refused": "settingsFileRefused",
  "backup-refused": "settingsBackupRefused",
} as const satisfies Record<NonNullable<SettingsRefusal>, StringKey>;

/** What the shell says when a read brought no preferences, and which of the three it was. */
const SETTINGS_UNREAD_STRING = {
  never: "settingsUnread",
  again: "settingsUnreread",
  "answer-unreadable": "settingsReadAnswerUnreadable",
} as const satisfies Record<SettingsUnread, StringKey>;

/** One `settings-unreadable` Warning, derived from the contract rather than written out. */
type UnreadableSetting = Extract<SettingsWarning, { kind: "settings-unreadable" }>;

/**
 * The name of a preference, for the `settings-unreadable` Warning to say which one it lost. A `Map`
 * and not a record, because `field` is a `string` on the wire.
 */
const SETTING_NAME_STRING = new Map<string, StringKey>([
  ["language", "settingLanguage"],
  ["examSpacingDays", "settingExamSpacing"],
]);

/**
 * The name of an edit, from the label the API answers with. A `Map` and not a record, because the
 * contract types `label` as a `string`: a newer server may send a label this build has no name
 * for, and `editUnknown` is what is true of every one of them.
 */
const EDIT_LABEL_STRING = new Map<string, StringKey>([
  ["pick-group", "editPickGroup"],
  ["remove-pick", "editRemovePick"],
  ["create-variant", "editCreateVariant"],
  ["duplicate-variant", "editDuplicateVariant"],
  ["rename-variant", "editRenameVariant"],
  ["delete-variant", "editDeleteVariant"],
  ["set-primary-variant", "editSetPrimaryVariant"],
  ["add-to-tray", "editAddToTray"],
  ["remove-from-tray", "editRemoveFromTray"],
  ["add-blocked-time", "editAddBlockedTime"],
  ["replace-blocked-time", "editReplaceBlockedTime"],
  ["remove-blocked-time", "editRemoveBlockedTime"],
  ["copy-blocked-times", "editCopyBlockedTimes"],
  ["set-cohort", "editSetCohort"],
  ["set-programs", "editSetPrograms"],
]);

export function AppShell({
  screens,
  language,
  onLanguage,
  settingsNotice,
  settingsWarnings = [],
  settingsUnread,
  onEdited,
  tokenHeld = false,
  today = new Date(),
  workspaceChanges = 0,
  browser,
}: AppShellProps): React.JSX.Element {
  const [path, go] = useLocationPath(browser);
  const open = screenFor(screens, path);

  /**
   * Whether undo and redo are available, and the steps themselves. Keyed on the change count, so
   * another tab's edit moves these buttons too: the stacks belong to the State File and live in the
   * server process, not in this page (ADR-0013).
   */
  const history = useHistory({ changes: workspaceChanges });
  const askHistory = history.ask;

  /**
   * The revision a screen reported it is showing, and which screen reported it: what a press is
   * based on while that screen is the one open. Kept with its screen, so a press is never based on
   * the screen that was open before — whose revision nothing on screen is showing any more.
   */
  const [reported, setReported] = useState<
    { from: ScreenDefinition; revision: ScreenRevision | undefined } | undefined
  >(undefined);
  const revision = reported !== undefined && reported.from === open ? reported.revision : undefined;
  const reportRevision = useCallback(
    (from: ScreenDefinition | undefined, next: ScreenRevision | undefined): void => {
      if (from !== undefined) setReported({ from, revision: next });
    },
    [],
  );
  const onRevision = useCallback(
    (next: ScreenRevision | undefined): void => reportRevision(open, next),
    [reportRevision, open],
  );
  /**
   * The answer a step was sent on, while that step's own re-read is still in flight: a press waits
   * for the screen to catch up, because the revision on screen is spent from the moment a step
   * succeeds until the re-read lands. Held by identity, for the reason `ScreenRevision.answer` is.
   */
  const [steppedOn, setSteppedOn] = useState<object | undefined>(undefined);
  /** The undo or redo this page last took, and which way it went: the answer does not say. */
  const [lastStep, setLastStep] = useState<
    { direction: Direction; answer: HistoryStep } | undefined
  >(undefined);
  const [stepRereads, setStepRereads] = useState(0);
  const [steps, setSteps] = useState(0);

  const edited = useCallback((): void => {
    askHistory();
    onEdited?.();
  }, [askHistory, onEdited]);

  const acted = useCallback((): void => setLastStep(undefined), []);

  /**
   * One press of undo or redo, on the revision the open screen is showing — an undo *is* a save
   * and goes through the same external-edit guard (ADR-0013).
   *
   * What the screen shows afterwards is a direct re-read, not the change count: the answer carries
   * the new revision but not what the screen draws, and the poll is seconds away.
   */
  const takeStep = (direction: Direction, from: ScreenRevision): void => {
    setSteps((count) => count + 1);
    setLastStep(undefined);
    // claimed before the request goes out, so a press landing before its answer is not a second one
    setSteppedOn(from.answer);

    void history.step(direction, from.version).then((answer) => {
      setLastStep({ direction, answer });
      // A move changed the file, and the two stale reasons both mean the screen is showing
      // something the file has moved past.
      const stale =
        answer.kind === "refused" &&
        (answer.reason === "state-file-changed" || answer.reason === "history-invalidated");
      // An answer this page could not read is **not** the claim that nothing was written (#206):
      // the page goes and looks rather than relying on what it is holding.
      const unknown = answer.kind === "unreadable-answer";
      if (answer.kind === "moved" || stale || unknown) {
        setStepRereads((count) => count + 1);
        // a move is a save, so it moved the revision the language switch is holding too
        if (answer.kind === "moved" || unknown) onEdited?.();
        if (unknown) askHistory();
        return;
      }
      // nothing was written, so the revision on screen is still the file's and nothing is coming
      setSteppedOn(undefined);
    });
  };

  /**
   * How a press is made, or `undefined` for *not now*: the open screen has to be showing a revision
   * to step from (`undefined` there is the claim that there is no State File, #111), and no step may
   * be in flight or waiting for its re-read.
   */
  const stepFrom =
    revision !== undefined && !history.stepping && steppedOn !== revision.answer
      ? (direction: Direction): void => takeStep(direction, revision)
      : undefined;

  const stepSaid = historyNotice(language, lastStep, tokenHeld);
  const settingsSentence = settingsSaid(language, settingsNotice, tokenHeld);
  const notices = (
    <>
      {/* what the last press of undo or redo did, or why it did nothing */}
      {stepSaid === undefined ? null : <span>{stepSaid}</span>}
      {/* why the last change to a preference did nothing, and a preference that could not be read */}
      {settingsSentence === undefined ? null : <span>{settingsSentence}</span>}
      {settingsUnread === undefined ? null : (
        <span>{t(language, SETTINGS_UNREAD_STRING[settingsUnread])}</span>
      )}
      {unreadableSettings(settingsWarnings).map((warning) => (
        <span key={warning.field ?? "all"}>{settingSaid(language, warning)}</span>
      ))}
    </>
  );

  return (
    <div dir={DIRECTION[language]} className="flex min-h-dvh flex-col">
      <header
        data-language-of={language}
        className="flex items-center gap-4 border-b border-rule bg-paper px-4 py-2"
      >
        {/*
          The screens, as a navigation landmark with the open one marked `aria-current="page"`, so
          a screen reader announces where the student is. Left out when there is one screen: a
          navigation with nowhere else to go is a dead end of its own.
        */}
        {screens.length > 1 && (
          <nav aria-label={t(language, "navScreens")} className="flex items-center gap-1">
            {screens.map((screen) => (
              <a
                key={screen.path}
                href={screen.path}
                data-screen={screen.path}
                aria-current={screen === open ? "page" : undefined}
                onClick={(event) => {
                  // an ordinary link, so a middle click or a modified one opens a new tab as usual
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  go(screen.path);
                }}
                className={
                  screen === open
                    ? "rounded-sm border border-ink bg-hint px-3 py-1 text-sm font-semibold text-ink"
                    : "rounded-sm border border-transparent px-3 py-1 text-sm text-ink-soft"
                }
              >
                {t(language, screen.label)}
              </a>
            ))}
          </nav>
        )}
        {open !== undefined && screens.length <= 1 && (
          <h1 className="text-lg font-semibold">{t(language, open.label)}</h1>
        )}
        {open?.subtitle === undefined ? null : (
          <span className="text-sm text-pencil">{open.subtitle(language, today)}</span>
        )}
        {/*
          Undo and redo, before the two preferences: they act on the document, where the scheme
          and the language are about the page. Availability is `GET /api/history`'s answer,
          conjoined with what only the open screen knows: that there is a revision to step from.
        */}
        <HistoryControls
          language={language}
          canUndo={stepFrom !== undefined && history.available?.canUndo === true}
          canRedo={stepFrom !== undefined && history.available?.canRedo === true}
          onUndo={() => stepFrom?.("undo")}
          onRedo={() => stepFrom?.("redo")}
        />
        {/* `ms-auto` on the scheme control puts the pair at the end side in either direction */}
        <SchemeControl language={language} />
        {/*
          The language switch, which writes the choice into the State File (#115, ADR-0014).
          `disabled` and not `aria-disabled`: a switch that cannot be honoured is not a thing to tab
          to and be refused by.
        */}
        <button
          type="button"
          data-language={language}
          disabled={onLanguage === undefined}
          onClick={() => onLanguage?.(language === "en" ? "he" : "en")}
          className="rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft disabled:opacity-50"
        >
          {t(language, "otherLanguage")}
        </button>
      </header>

      {open?.render({
        language,
        tokenHeld,
        today,
        workspaceChanges,
        stepRereads,
        steps,
        onEdited: edited,
        onActed: acted,
        onRevision,
        notices,
      })}
    </div>
  );
}

/**
 * Which of the two things a 401 means, said once for the whole app. The server answers a wrong
 * token and a missing one identically, so the difference comes from whether this page is holding
 * one at all (`hasLaunchToken` in `./api.ts`).
 */
export function unauthorizedSaid(language: Language, tokenHeld: boolean): string {
  return t(language, tokenHeld ? "tokenRetired" : "tokenMissing");
}

/**
 * What the shell says about the undo or redo it last took, and nothing when it has taken none.
 * The API's `label` is a key, looked up and never shown.
 */
function historyNotice(
  language: Language,
  last: { direction: Direction; answer: HistoryStep } | undefined,
  tokenHeld: boolean,
): string | undefined {
  if (last === undefined) return undefined;
  const { direction, answer } = last;

  switch (answer.kind) {
    case "moved":
      return t(language, direction === "undo" ? "undoneEdit" : "redoneEdit", {
        edit: t(language, EDIT_LABEL_STRING.get(answer.label) ?? "editUnknown"),
      });
    case "refused":
      return answer.reason === undefined
        ? t(language, "historyNotDone")
        : t(language, HISTORY_REFUSAL_STRING[answer.reason]);
    // reached from the 200 as well as the refusal, so the step may have been taken (#206)
    case "unreadable-answer":
      return t(language, "historyAnswerUnreadable");
    case "unauthorized":
      return unauthorizedSaid(language, tokenHeld);
    case "unreachable":
      return t(language, "apiUnreachable");
  }
}

/**
 * What the shell says about the last change to a preference, and nothing when there has been none
 * or it went through: a language that changed flips the whole document, which is its own account.
 */
function settingsSaid(
  language: Language,
  notice: SettingsNotice | undefined,
  tokenHeld: boolean,
): string | undefined {
  if (notice === undefined) return undefined;

  switch (notice.kind) {
    case "refused":
      return notice.reason === undefined
        ? t(language, "settingsNotDone")
        : t(language, SETTINGS_REFUSAL_STRING[notice.reason]);
    // reached from the served arm too, so an unparseable 200 may have written (#207)
    case "unreadable-answer":
      return t(language, "settingsAnswerUnreadable");
    case "unauthorized":
      return unauthorizedSaid(language, tokenHeld);
    case "unreachable":
      return t(language, "apiUnreachable");
  }
}

/** The preferences that could not be read, out of every Warning the settings were read with. */
function unreadableSettings(warnings: readonly SettingsWarning[]): UnreadableSetting[] {
  return warnings.filter(
    (warning): warning is UnreadableSetting => warning.kind === "settings-unreadable",
  );
}

/** One preference that could not be read, named when `core` named a field this build knows. */
function settingSaid(language: Language, warning: UnreadableSetting): string {
  const name = warning.field === undefined ? undefined : SETTING_NAME_STRING.get(warning.field);
  return name === undefined
    ? t(language, "settingsUnreadable")
    : t(language, "settingsUnreadableNamed", { setting: t(language, name) });
}
