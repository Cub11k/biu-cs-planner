import { t, type Language, type StringKey } from "../i18n/strings.ts";
import { unauthorizedSaid } from "../AppShell.tsx";
import { courseName, type Offering } from "./catalog.ts";
import { lessonTypeName } from "./lessonType.ts";
import type { Clash, StateRefusal, TimetableResult, VariantWarning } from "./picks.ts";

/** What the screen holds of the Timetable: nothing read yet, or the API's latest answer. */
export type TimetableState = { kind: "loading" } | TimetableResult;

/**
 * Why the API would not touch the State File, in words the student can act on. Exhaustive
 * against the contract, so a reason added to the API is a compile error here rather than a
 * sentence about an unreadable file shown for something else entirely.
 */
export const REFUSAL_STRING = {
  "workspace-not-ready": "workspaceNotReady",
  "state-file-unreadable": "picksUnreadable",
  "state-file-changed": "picksStale",
  "workspace-refused": "picksUnreadable",
  // The State File read fine and the backup could not be made, so not `picksUnreadable` (#229).
  "backup-refused": "picksBackupRefused",
  // The save was made and its revision could not be read (#326): not `picksUnreadable`, which
  // says nothing changed. `settle` keeps the week and re-reads on it.
  "save-revision-unreadable": "saveUnconfirmed",
} as const satisfies Record<NonNullable<StateRefusal>, StringKey>;

/**
 * The hint line above the week: what to do next, and in one live region every account the screen
 * owes the student — a click held, dropped or refused, the shell's own notices, the Clashes and the
 * Variant Warnings — with the legend at its end.
 */
export function TimetableNotices({
  language,
  tokenHeld,
  chosen,
  timetable,
  heldWaiting,
  heldEditCount,
  heldLost,
  staleSave,
  planDiffStale,
  unknownSave,
  readsKept,
  notices,
  clashes,
  variantWarnings,
  nameOf,
}: {
  language: Language;
  tokenHeld: boolean;
  /** The Course whose Groups the week shows, if one is chosen. */
  chosen: Offering | undefined;
  timetable: TimetableState;
  /** That clicks are held for the first Timetable answer. */
  heldWaiting: boolean;
  heldEditCount: number;
  heldLost: boolean;
  staleSave: boolean;
  planDiffStale: boolean;
  unknownSave: StringKey | undefined;
  readsKept: number;
  notices: React.ReactNode;
  clashes: readonly Clash[];
  variantWarnings: readonly VariantWarning[];
  nameOf: (courseNumber: string) => string;
}): React.JSX.Element {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule bg-hint px-4 py-2 text-sm text-ink-soft">
      {chosen === undefined
        ? t(language, "hintChoose")
        : t(language, "hintShowing", { course: courseName(chosen, language) })}
      {/* A live region, because every sentence in it is an account of something the
          student cannot otherwise tell happened: a click held, a click dropped, a click
          refused, a Clash found. Nothing moves focus and a `mixed` tile does not change
          state when clicked, so without this a screen-reader user's click is silently
          dropped — which is the failure #111 is about, for them. */}
      <span role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {picksNotice(language, timetable, tokenHeld) === undefined ? null : (
          <span>{picksNotice(language, timetable, tokenHeld)}</span>
        )}
        {/* only while it is true: once the answer is served the click is being saved
            rather than waiting, and the ink it produces is its own account */}
        {heldWaiting && timetable.kind !== "served" && (
          <span>{t(language, "picksHeld")}</span>
        )}
        {/* an edit waiting for the re-read a refusal asked for (#334) */}
        {heldEditCount > 0 && <span>{t(language, "picksHeldForReread")}</span>}
        {heldLost && <span>{t(language, "picksHeldLost")}</span>}
        {staleSave && <span>{t(language, "picksStale")}</span>}
        {planDiffStale && <span>{t(language, "planDiffStale")}</span>}
        {unknownSave !== undefined && <span>{t(language, unknownSave)}</span>}
        {/* the week is the last one read, kept over an answer nobody could read (#218) */}
        {readsKept > 0 && timetable.kind === "served" && (
          <span>{t(language, "picksReadStale")}</span>
        )}
        {/* the shell's own: the last press of undo or redo, the last preference */}
        {notices}
        {clashes.length > 0 && <span>{clashesSaid(language, clashes.length)}</span>}
        {/* the Clashes strip names what a Pick Clashes with when it is a Blocked Time: its
            own label is what a student can act on (#282) */}
        {blockedClashes(clashes).map((said) => (
          <span key={said.key}>
            {t(language, "clashWithBlocked", {
              group: `${nameOf(said.courseNumber)} ${lessonTypeName(said.lessonType, language)} ${said.number}`,
              label: said.label || t(language, "blockedUnlabelled"),
            })}
          </span>
        ))}
        {/* a Warning about the Variants and never a refusal: the edit that made it went
            through, and the tabs above show it */}
        {variantWarnings.map((warning) => (
          <span key={`${warning.kind}:${"name" in warning ? warning.name : ""}`}>
            {variantWarningSaid(language, warning)}
          </span>
        ))}
      </span>
      <span className="ms-auto flex items-center gap-2 text-xs text-pencil">
        <span className="legend-swatch inline-block h-3 w-4 rounded-xs" />
        {t(language, "legendPencil")}
        <span className="legend-swatch is-picked inline-block h-3 w-4 rounded-xs" />
        {t(language, "legendInk")}
        {/* also `is-picked`: on the week a Clash is always a Pick */}
        <span className="legend-swatch is-picked is-clashing inline-block h-3 w-4 rounded-xs" />
        {t(language, "legendClash")}
        <span className="legend-swatch is-hatched inline-block h-3 w-4 rounded-xs" />
        {t(language, "legendHatched")}
      </span>
    </p>
  );
}

/**
 * What the hint line says about the Picks — and what it does **not** say.
 *
 * Only a served answer knows how many Picks there are. Falling back to an empty list and
 * counting that would put "Nothing picked yet" on screen for a server that is not
 * answering, which is an affirmative false statement about a student's own data: their
 * Picks are on disk and this page simply cannot see them. Each of the other four answers
 * says what it actually is, as the Catalog half of this screen already does.
 */
function picksNotice(
  language: Language,
  timetable: TimetableState,
  tokenHeld: boolean,
): string | undefined {
  switch (timetable.kind) {
    // the first read is in flight and there is nothing honest to say yet
    case "loading":
      return undefined;
    case "unreachable":
      return t(language, "apiUnreachable");
    case "unauthorized":
      return unauthorizedSaid(language, tokenHeld);
    // An answer that arrived and could not be read. Not `picksUnreadable`: that sentence says
    // the saved Picks could not be read, and nothing about an unparseable body says the State
    // File was reached at all (#171).
    case "unreadable-answer":
      return t(language, "picksAnswerUnreadable");
    case "refused":
      return t(
        language,
        timetable.reason === undefined ? "picksUnreadable" : REFUSAL_STRING[timetable.reason],
      );
    case "served":
      return picksSaid(language, timetable.picks.length);
  }
}

/** One Pick is not "1 groups picked", and Hebrew's singular is a different word again. */
function picksSaid(language: Language, count: number): string {
  if (count === 0) return t(language, "picksNone");
  return count === 1 ? t(language, "picksCountOne") : t(language, "picksCount", { count });
}

/** What a Variant Warning says. The name is the student's own text and is shown as written. */
function variantWarningSaid(language: Language, warning: VariantWarning): string {
  switch (warning.kind) {
    case "variant-name-not-unique":
      return t(language, "variantNameNotUnique", { name: warning.name });
    case "primary-variant-not-unique":
      return t(language, "variantPrimaryNotUnique");
    // only a hand-edited file holds two (#297): marking one clears the others
    case "registered-variant-not-unique":
      return t(language, "variantRegisteredNotUnique");
  }
}

/**
 * The Clashes with a Blocked Time, one per Group and Blocked Time — a Group that meets twice over
 * one shift is one sentence, not two.
 */
function blockedClashes(clashes: readonly Clash[]): Array<{
  key: string;
  courseNumber: string;
  lessonType: string;
  number: string;
  label: string;
}> {
  const said = new Map<string, { courseNumber: string; lessonType: string; number: string; label: string }>();
  for (const clash of clashes) {
    if (clash.kind !== "meeting-blocked-time") continue;
    const key = `${clash.group.courseNumber}|${clash.group.lessonType}|${clash.group.number}|${clash.blockedTimeIndex}`;
    if (!said.has(key)) said.set(key, { ...clash.group, label: clash.blockedTime.label });
  }
  return [...said].map(([key, value]) => ({ key, ...value }));
}

/** A Clash is a Warning: it is counted and shown, and it refuses nothing. */
function clashesSaid(language: Language, count: number): string {
  return count === 1
    ? t(language, "clashesCountOne")
    : t(language, "clashesCount", { count });
}
