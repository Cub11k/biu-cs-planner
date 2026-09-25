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
  type StateFileVersion,
  type StateRefusal,
  type TimetableQuery,
  type TimetableResult,
} from "./picks.ts";
import { clashingGroups, isPicked, weekGroups, type WeekGroup } from "./week.ts";
import { SchemeControl } from "../SchemeControl.tsx";
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
 * A click waiting for the first Timetable answer, and the week it was made on.
 *
 * The query travels with it because the screen can be asked a different question while the
 * click waits — another Semester is what `useReloading` shows `loading` for — and one State
 * File holds every Semester, so its revision would happily accept a Pick saved into the
 * wrong one. A click is answered by the week it was made on or not at all.
 */
type HeldClick = { group: WeekGroup; query: TimetableQuery };

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
   * That a click was refused because the file had changed, and how many times this screen
   * has had to re-read for that reason.
   *
   * The notice stays until the next click is *made* rather than until the fresh week
   * arrives: it is the only account the student gets of a click that did nothing, and the
   * re-read it triggers lands in milliseconds.
   *
   * Cleared by the click and not by a later success, because more than one save can be in
   * flight at once — a held click draining while the student makes another — and a success
   * that cleared this would swallow the refusal of the click beside it, leaving a refused
   * click with no account at all. Whose refusal it was is not distinguished; that is
   * #104's question, and one sentence for "a click was refused" is the honest floor.
   */
  const [staleSave, setStaleSave] = useState(false);
  const [rereads, setRereads] = useState(0);
  /**
   * Clicks made before the first Timetable answer arrived, in the order they were made.
   *
   * The Catalog and the Picks are asked for in parallel, so the week is clickable while the
   * State File has not been read. A click made then cannot be sent: it has no revision to
   * be based on, and `undefined` there is the claim that there is no State File at all —
   * which #90's guard refuses, leaving the student told a file changed that never did.
   *
   * So it is held. Of the three shapes #111 weighs this is the one that keeps the click:
   * the alternatives either drop it silently or spend a sentence saying it was dropped, and
   * a click on a Group is a small thing to have to make twice.
   */
  const [held, setHeld] = useState<readonly HeldClick[]>([]);
  /** That held clicks had to be dropped, because the file could not be read at all. */
  const [heldLost, setHeldLost] = useState(false);
  /** That a held click is in flight, so the drain below sends one at a time. */
  const sending = useRef(false);
  /**
   * The answer a save was just refused on, held by identity.
   *
   * A stale refusal leaves the week on screen alone — deliberately, so the student keeps a
   * week they can still read — and triggers a re-read. Until that re-read lands, the answer
   * on screen carries a revision the file has already moved past, and firing the next held
   * click at it would be sending a request that cannot succeed. So the drain waits for *any*
   * newer answer: by identity and not by revision, because a file reverted to the revision it
   * had is still news, and waiting for a different string would wait for ever.
   */
  const refusedOn = useRef<TimetableState | undefined>(undefined);

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
  /**
   * The Picks, or `undefined` for *not read yet* — which is not the same as a Variant with
   * no Picks in it. The week draws the difference and a click depends on it: an `[]` here
   * would draw a Pick as a pencil option and let a click remove it by trying to record it
   * (#111).
   */
  const picks = timetable.kind === "served" ? timetable.picks : undefined;
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
   *
   * `basedOn` and `query` are parameters rather than read from this render: a held click is
   * sent on the revision the *arriving* answer carries, and it belongs to the week it was
   * made on rather than the week now on screen (`HeldClick`). The week and the revision a
   * save claims still come from one read — that is the rule (docs/design.md, "External
   * edits") — it is just no longer always the read on screen at the moment of the click.
   *
   * The answer comes back as well as being shown, because the drain has to know whether this
   * revision was refused before it sends the next held click at the same one.
   */
  const save = useCallback(
    (
      group: WeekGroup,
      remove: boolean,
      basedOn: StateFileVersion,
      query: TimetableQuery,
    ): Promise<TimetableResult> => {
      const slot = { courseNumber: group.courseNumber, lessonType: group.lessonType };
      const done = remove
        ? removePick(api, query, slot, basedOn)
        : // the snapshot is taken from the Meetings the page was showing: a Pick carries the
          // Group's Meetings as they stood when it was made (CONTEXT.md, "Pick")
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

      return done.then((answer): TimetableResult => {
        // The file is not what this page was showing, so the click was refused rather than
        // allowed to destroy whoever else's edit (#90). The week on screen is kept and
        // re-read: replacing it with the refusal would blank a week the student can still
        // see, and would throw away the revision the next click needs.
        if (answer.kind === "refused" && answer.reason === "state-file-changed") {
          setStaleSave(true);
          setRereads((count) => count + 1);
          return answer;
        }
        setTimetable(answer);
        return answer;
      });
    },
    [setTimetable],
  );

  const onPick = (group: WeekGroup): void => {
    // whatever became of the last click, this one is the account the student is owed now
    setHeldLost(false);
    setStaleSave(false);
    const query = { academicYear, semester };

    if (timetable.kind !== "served") {
      setHeld((waiting) => [...waiting, { group, query }]);
      return;
    }
    // Only a served answer knows this, and `picked` is a `boolean` once it does. A click on
    // ink removes the Pick; a click on pencil records one.
    void save(group, group.picked === true, timetable.version, query);
  };

  /**
   * The held clicks, sent once there is an answer to send them on.
   *
   * One per run rather than a loop: each send answers with the revision the next one has to
   * be based on, and each is its own call and so its own undo entry (ADR-0013). The answer
   * moves both `held` and `timetable`, which is what runs this effect again for the next.
   */
  useEffect(() => {
    const next = held[0];
    if (next === undefined || sending.current) return;
    // this revision has already been refused once; the re-read it triggered is what to wait for
    if (refusedOn.current === timetable) return;

    // The screen is being asked about another week now, so the answer this click is waiting
    // for is never coming. It is dropped rather than sent on this week's revision, which one
    // State File would accept for a Pick in a Semester the student has left.
    if (next.query.academicYear !== academicYear || next.query.semester !== semester) {
      setHeld([]);
      setHeldLost(true);
      return;
    }

    // the first read is still in flight, which is what the click is waiting for
    if (timetable.kind === "loading") return;

    // The file cannot be read, so there is no revision to save on and no week to reconcile
    // against — and a click held for a file that may never arrive is worse than one lost.
    // It is dropped, and said so: a click that vanishes without a word is the failure this
    // ticket is about, and silence would only move it.
    if (timetable.kind !== "served") {
      setHeld([]);
      setHeldLost(true);
      return;
    }

    // This click was made on a tile that showed neither ink nor pencil, because the page had
    // not read the file — so it asked for the Group to *be* a Pick, which is what a
    // `mixed` toggle offers and what clicking one means. If the file already holds exactly
    // this Pick then that is already so: there is nothing to send, and sending it anyway
    // would write a Pick over itself and spend an undo entry doing it.
    //
    // This is where reconciling stops and #104 begins: nothing here re-applies an edit the
    // server answered. A held click was never sent, and it goes out on the revision the
    // first answer carries, so the guard has nothing to refuse it for.
    if (isPicked(timetable.picks, next.group)) {
      setHeld((waiting) => waiting.slice(1));
      return;
    }

    sending.current = true;
    const sentOn = timetable;
    void save(next.group, false, timetable.version, next.query).then((answer) => {
      sending.current = false;
      // This click is spent either way. A refused one is not re-sent — that is #104 — but the
      // rest of the queue must not be fired at the revision that refused it.
      if (answer.kind === "refused" && answer.reason === "state-file-changed") {
        refusedOn.current = sentOn;
      }
      setHeld((waiting) => waiting.slice(1));
    });
  }, [held, timetable, save, academicYear, semester]);

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
        {/*
          The two preferences the header carries, at the end side of the row — `ms-auto` on
          the first of them, so the pair sits at the right in English and at the left in
          Hebrew without a second rule (CLAUDE.md: direction-neutral classes only).
        */}
        <SchemeControl language={language} />
        <button
          type="button"
          onClick={() => onLanguage(language === "en" ? "he" : "en")}
          className="rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft"
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
              // an unread file shows no picked line, which is what it showed before #111;
              // saying "this Course has nothing picked" while the file is unread is the
              // same class of untruth as `picksNone`, and is its own ticket
              picks={picks ?? []}
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
            {/* A live region, because every sentence in it is an account of something the
                student cannot otherwise tell happened: a click held, a click dropped, a click
                refused, a Clash found. Nothing moves focus and a `mixed` tile does not change
                state when clicked, so without this a screen-reader user's click is silently
                dropped — which is the failure #111 is about, for them. */}
            <span role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {picksNotice(language, timetable) === undefined ? null : (
                <span>{picksNotice(language, timetable)}</span>
              )}
              {/* only while it is true: once the answer is served the click is being saved
                  rather than waiting, and the ink it produces is its own account */}
              {held.length > 0 && timetable.kind !== "served" && (
                <span>{t(language, "picksHeld")}</span>
              )}
              {heldLost && <span>{t(language, "picksHeldLost")}</span>}
              {staleSave && <span>{t(language, "picksStale")}</span>}
              {clashes.length > 0 && <span>{clashesSaid(language, clashes.length)}</span>}
            </span>
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
