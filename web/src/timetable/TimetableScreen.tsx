import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { DIRECTION, t, type Language, type StringKey } from "../i18n/strings.ts";
import { academicYearOf, academicYearSpan, semesterOf } from "./calendar.ts";
import { courseName, type Semester } from "./catalog.ts";
import { fetchOfferings, type CatalogWarning, type OfferingsResult } from "./offerings.ts";
import {
  fetchTimetable,
  recordPick,
  removePick,
  type GroupPick,
  type StateRefusal,
  type TimetableResult,
} from "./picks.ts";
import { clashingGroups, weekGroups, type WeekGroup } from "./week.ts";
import { CoursePicker } from "./CoursePicker.tsx";
import { WeekGrid } from "./WeekGrid.tsx";

const SEMESTER_STRING = {
  fall: "semesterFall",
  spring: "semesterSpring",
  summer: "semesterSummer",
} as const satisfies Record<Semester, StringKey>;

type CatalogState = { kind: "loading" } | OfferingsResult;
type TimetableState = { kind: "loading" } | TimetableResult;

/**
 * Why the API served no Catalog, said in words the student can act on. A Warning nobody
 * can read is not a Warning, and the four reasons ask for four different things.
 */
const WARNING_STRING = new Map<CatalogWarning["kind"], StringKey>([
  ["file-unreadable", "warningFileUnreadable"],
  ["schema-version-too-new", "warningSchemaTooNew"],
  ["schema-version-unsupported", "warningSchemaUnsupported"],
  ["workspace-refused", "warningWorkspaceRefused"],
]);

/**
 * Why the API would not touch the State File, in words the student can act on. Exhaustive
 * against the contract, so a reason added to the API is a compile error here rather than a
 * sentence about an unreadable file shown for something else entirely.
 */
const REFUSAL_STRING = {
  "workspace-not-ready": "picksNotSaved",
  "state-file-unreadable": "picksUnreadable",
  "state-file-changed": "picksStale",
  "workspace-refused": "picksUnreadable",
} as const satisfies Record<NonNullable<StateRefusal>, StringKey>;

/** Absence is not a fault: the year simply has no Catalog yet, and one can be imported. */
const isAbsence = (warnings: readonly CatalogWarning[]): boolean =>
  warnings.length === 0 || warnings.every((warning) => warning.kind === "no-catalog-for-year");

/**
 * Asks the API again whenever the Workspace changes, **without blanking what is on screen**.
 *
 * Every save moves the Workspace's change count — the watcher watches the root and filters
 * no filenames — so from the moment a Pick can be saved, the page that made it re-reads on
 * every edit. That reload is made idempotent rather than suppressed (#88): the answer
 * already on screen stays until the new one arrives, and only a first load, or a switch to
 * another Semester, shows `loading`, because then there is genuinely nothing to show.
 *
 * `load` is the question: memoise it on what it asks for, and a change to it is a change of
 * question rather than news about the folder.
 */
function useReloading<T>(
  load: () => Promise<T>,
  workspaceChanges: number,
): [{ kind: "loading" } | T, (answer: T) => void] {
  const [answer, setAnswer] = useState<{ kind: "loading" } | T>({ kind: "loading" });
  const shownFor = useRef<typeof load | undefined>(undefined);
  /**
   * Which answer the screen is showing. It has to be counted rather than flagged, because
   * a save is itself what moves the change count: the re-read it triggers can be sent
   * before the file is written and answer after the edit's own answer has already been
   * shown, and a bare "is this effect still current" flag would let that stale Variant
   * overwrite the new one. An answer older than what is on screen is dropped.
   */
  const shown = useRef(0);

  /** An answer from outside the effect — an edit's own — is the newest by definition. */
  const showAnswer = useCallback((fresh: T): void => {
    shown.current += 1;
    setAnswer(fresh);
  }, []);

  useEffect(() => {
    const mine = (shown.current += 1);
    if (shownFor.current !== load) setAnswer({ kind: "loading" });

    // `load` resolves rather than rejects for every answer the API can give, which is why
    // there is no `catch` here: a rejection would be a bug in the client, not an answer.
    void load().then((fresh) => {
      if (shown.current !== mine) return;
      shownFor.current = load;
      setAnswer(fresh);
    });

    return () => {
      // whatever this run asked for is no longer what the screen is waiting on
      shown.current += 1;
    };
  }, [load, workspaceChanges]);

  return [answer, showAnswer];
}

export type TimetableScreenProps = {
  language: Language;
  onLanguage: (language: Language) => void;
  /** Taken as an argument so the screen can be opened on any date, and tested. */
  today?: Date;
  /**
   * How many times the Workspace has changed on disk since the page loaded. The screen does
   * nothing with the number but notice that it moved, which is how "the UI reloads on
   * external changes" (docs/design.md, "Storage") reaches a React effect. It arrives as a
   * prop rather than being watched here because the folder is the whole app's business, not
   * this screen's: `App` asks for it, `web/src/changes.ts` is where the asking happens.
   */
  workspaceChanges?: number;
};

/**
 * The landing screen: the week of one Semester of the current Academic Year, the Catalog to
 * choose a Course from, and the Picks the student has already made. Choosing a Course puts
 * its Groups on the week as options; clicking one Picks it, and clicking a Pick removes it.
 *
 * It reaches the domain only through the typed client in ../api.ts, which is the only
 * thing on this side that knows the API contract (docs/design.md, "Architecture").
 */
export function TimetableScreen({
  language,
  onLanguage,
  today = new Date(),
  workspaceChanges = 0,
}: TimetableScreenProps): React.JSX.Element {
  const academicYear = academicYearOf(today);
  const semester = semesterOf(today);

  const [selected, setSelected] = useState<string | undefined>(undefined);
  /**
   * That the last click was refused because the file had changed, and how many times this
   * screen has had to re-read for that reason.
   *
   * The notice stays until the next click goes through rather than until the fresh week
   * arrives: it is the only account the student gets of a click that did nothing, and the
   * re-read it triggers lands in milliseconds.
   */
  const [staleSave, setStaleSave] = useState(false);
  const [rereads, setRereads] = useState(0);

  const askCatalog = useCallback(
    () => fetchOfferings(api, { academicYear, semester }),
    [academicYear, semester],
  );
  const askTimetable = useCallback(
    () => fetchTimetable(api, { academicYear, semester }),
    [academicYear, semester],
  );

  const [catalog]: [CatalogState, unknown] = useReloading(askCatalog, workspaceChanges);
  const [timetable, setTimetable]: [TimetableState, (answer: TimetableResult) => void] =
    useReloading(askTimetable, workspaceChanges + rereads);

  const offerings = catalog.kind === "served" ? catalog.offerings : [];
  const picks = timetable.kind === "served" ? timetable.picks : [];
  const clashes = timetable.kind === "served" ? timetable.clashes : [];
  const chosen = offerings.find((offering) => offering.courseNumber === selected);

  /** A picked Course the Catalog no longer names shows its number, which it always has. */
  const nameOf = (courseNumber: string): string => {
    const known = offerings.find((offering) => offering.courseNumber === courseNumber);
    return known === undefined ? courseNumber : courseName(known, language);
  };

  /**
   * Picking, and un-picking. One call per click, which is what ADR-0013 makes one undo
   * entry, and the answer carries the Variant as it stands afterwards — so the screen shows
   * what the file holds rather than what it hoped the file would hold.
   */
  const onPick = (group: WeekGroup): void => {
    const query = { academicYear, semester };
    const slot = { courseNumber: group.courseNumber, lessonType: group.lessonType };
    // Which revision of the State File this click was made on, taken from the answer the
    // screen is showing rather than remembered separately: the week and the revision it is
    // have to be the same read, or a save could claim a view nobody was looking at
    // (docs/design.md, "External edits").
    const basedOn = timetable.kind === "served" ? timetable.version : undefined;
    const done = group.picked
      ? removePick(api, query, slot, basedOn)
      : // the snapshot is taken here, off the Meetings the page is showing: a Pick carries
        // the Group's Meetings as they stood when it was made (CONTEXT.md, "Pick")
        recordPick(
          api,
          query,
          {
            ...slot,
            groupNumber: group.number,
            meetings: [...group.meetings],
          } as GroupPick,
          basedOn,
        );

    void done.then((answer) => {
      // The file is not what this page was showing, so the click was refused rather than
      // allowed to destroy whoever else's edit (#90). The week on screen is kept and
      // re-read: replacing it with the refusal would blank a week the student can still
      // see, and would throw away the revision the next click needs.
      if (answer.kind === "refused" && answer.reason === "state-file-changed") {
        setStaleSave(true);
        setRereads((count) => count + 1);
        return;
      }
      setStaleSave(false);
      setTimetable(answer);
    });
  };

  // one spelling of the year on the whole screen: the header and the sidebar disagreeing
  // about 2026-27 and 2027 reads as if a different year were the one missing
  const yearLabel = t(language, "academicYear", academicYearSpan(academicYear));

  return (
    <div dir={DIRECTION[language]} className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-4 border-b border-rule bg-paper px-4 py-2">
        <h1 className="text-lg font-semibold">{t(language, "timetable")}</h1>
        <span className="text-sm text-pencil">
          {t(language, SEMESTER_STRING[semester])} · {yearLabel}
        </span>
        <button
          type="button"
          onClick={() => onLanguage(language === "en" ? "he" : "en")}
          className="ms-auto rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft"
        >
          {t(language, "otherLanguage")}
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="overflow-auto border-e border-rule bg-desk p-4">
          {catalog.kind === "loading" ? (
            <p className="text-sm text-pencil">{t(language, "catalogLoading")}</p>
          ) : catalog.kind === "unreachable" ? (
            <p className="text-sm text-pencil">{t(language, "apiUnreachable")}</p>
          ) : catalog.kind === "unauthorized" ? (
            <p className="text-sm text-pencil">{t(language, "catalogUnauthorized")}</p>
          ) : catalog.kind === "refused" ? (
            <CatalogNotice
              language={language}
              academicYear={yearLabel}
              warnings={catalog.warnings}
            />
          ) : (
            <CoursePicker
              language={language}
              offerings={offerings}
              picks={picks}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </aside>

        <section className="flex min-w-0 flex-col">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule bg-hint px-4 py-2 text-sm text-ink-soft">
            {chosen === undefined
              ? t(language, "hintChoose")
              : t(language, "hintShowing", { course: courseName(chosen, language) })}
            {picksNotice(language, timetable) === undefined ? null : (
              <span>{picksNotice(language, timetable)}</span>
            )}
            {staleSave && <span>{t(language, "picksStale")}</span>}
            {clashes.length > 0 && <span>{clashesSaid(language, clashes.length)}</span>}
            <span className="ms-auto flex items-center gap-2 text-xs text-pencil">
              <span className="legend-swatch inline-block h-3 w-4 rounded-xs" />
              {t(language, "legendPencil")}
              <span className="legend-swatch is-picked inline-block h-3 w-4 rounded-xs" />
              {t(language, "legendInk")}
              {/* also `is-picked`: on the week a Clash is always a Pick */}
              <span className="legend-swatch is-picked is-clashing inline-block h-3 w-4 rounded-xs" />
              {t(language, "legendClash")}
            </span>
          </p>

          <div className="min-h-0 flex-1 overflow-auto">
            <WeekGrid
              language={language}
              semester={semester}
              groups={weekGroups({ offering: chosen, picks, nameOf })}
              clashing={clashingGroups(clashes)}
              onPick={onPick}
            />
          </div>
        </section>
      </div>
    </div>
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
function picksNotice(language: Language, timetable: TimetableState): string | undefined {
  switch (timetable.kind) {
    // the first read is in flight and there is nothing honest to say yet
    case "loading":
      return undefined;
    case "unreachable":
      return t(language, "apiUnreachable");
    case "unauthorized":
      return t(language, "catalogUnauthorized");
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

/** A Clash is a Warning: it is counted and shown, and it refuses nothing. */
function clashesSaid(language: Language, count: number): string {
  return count === 1
    ? t(language, "clashesCountOne")
    : t(language, "clashesCount", { count });
}

/**
 * What the screen says when the API served no Catalog. Absence asks the student to import
 * a crawl; a file that is there but unreadable asks for something else entirely, so the
 * Warnings the API sent decide which it is and are shown rather than swallowed.
 */
export function CatalogNotice({
  language,
  academicYear,
  warnings,
}: {
  language: Language;
  /** Spelled as the header spells it, so the screen names one year once. */
  academicYear: string;
  warnings: readonly CatalogWarning[];
}): React.JSX.Element {
  return (
    <div className="text-sm text-pencil">
      <p>
        {isAbsence(warnings)
          ? t(language, "catalogMissing", { year: academicYear })
          : t(language, "catalogUnreadable", { year: academicYear })}
      </p>
      <ul className="mt-2 list-disc space-y-1 ps-5">
        {warnings.map((warning) => {
          const key = WARNING_STRING.get(warning.kind);
          return key === undefined ? null : <li key={warning.kind}>{t(language, key)}</li>;
        })}
      </ul>
    </div>
  );
}
