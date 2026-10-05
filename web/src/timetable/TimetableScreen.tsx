import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { t, type Language, type StringKey } from "../i18n/strings.ts";
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
  type Clash,
  type TimetableResult,
  type VariantWarning,
} from "./picks.ts";
import {
  createVariant,
  deleteVariant,
  duplicateVariant,
  renameVariant,
  setPrimaryVariant,
} from "./variants.ts";
import { clashingGroups, isPicked, weekGroups, type WeekGroup } from "./week.ts";
import {
  AppShell,
  unauthorizedSaid,
  type AppShellProps,
  type ScreenDefinition,
  type ScreenProps,
} from "../AppShell.tsx";
import { CoursePicker } from "./CoursePicker.tsx";
import { addToTray, removeFromTray } from "./tray.ts";
import { TrayColumn } from "./TrayColumn.tsx";
import { BlockedTimesEditor, type FormAnswer } from "./BlockedTimesEditor.tsx";
import {
  addBlockedTime,
  copyBlockedTimes,
  removeBlockedTime,
  replaceBlockedTime,
} from "./blockedTimes.ts";
import { lessonTypeName } from "./lessonType.ts";
import { shownTabIndex, VariantTabs, variantTabId } from "./VariantTabs.tsx";
import { keepVariantInUrl, variantInUrl, type VariantUrlBrowser } from "./variantUrl.ts";
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

/** A served Timetable answer: what an edit can be sent on. */
type Served = Extract<TimetableResult, { kind: "served" }>;

/**
 * An edit made while a `state-file-changed` re-read is in flight (#334): sent on the answer that
 * re-read brings, or dropped and said so when it brings none. `variant` is the Variant on screen
 * when it was made, because an edit is about the week it was made on or about none.
 */
type HeldEdit = {
  variant: string;
  send: (on: Served) => Promise<TimetableResult | undefined>;
  drop: () => void;
};

/** The tab a student chose: a Variant's name, and its position for when two share it (#322). */
type VariantWanted = { name: string; position: number | undefined };

/** The page's own URL, where the open tab is kept across a reload (#325); none outside a browser. */
const pageUrl = (): VariantUrlBrowser | undefined => (typeof window === "undefined" ? undefined : window);

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
 * An edit the screen sends on the view on screen: given the week it was made on — its Semester
 * and the Variant shown — and that view's revision, it asks the API and answers with the
 * Timetable afterwards.
 */
type TimetableEdit = (query: TimetableQuery, basedOn: StateFileVersion) => Promise<TimetableResult>;

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

/**
 * The Timetable as the app opens it: the screen inside the app shell (`../AppShell.tsx`), which
 * holds the header — undo and redo, the scheme and the language — that this screen used to carry
 * itself (#294). It is the shell with this one screen, so whatever renders the Timetable alone
 * still gets the whole of what a student sees on it; `../App.tsx` renders the shell with every
 * screen that is built.
 */
export type TimetableScreenProps = Omit<AppShellProps, "screens">;

export function TimetableScreen(props: TimetableScreenProps): React.JSX.Element {
  return <AppShell screens={TIMETABLE_SCREENS} {...props} />;
}

/** The Timetable's entry in the screen registry: the landing screen, at the root path. */
export const TIMETABLE_SCREEN: ScreenDefinition = {
  path: "/",
  label: "timetable",
  // one spelling of the year on the whole screen, the header's and the sidebar's alike
  subtitle: (language, today) =>
    `${t(language, SEMESTER_STRING[semesterOf(today)])} · ${t(language, "academicYear", academicYearSpan(academicYearOf(today)))}`,
  render: (props) => <TimetablePane {...props} />,
};

const TIMETABLE_SCREENS: readonly ScreenDefinition[] = [TIMETABLE_SCREEN];

/**
 * The landing screen: the week of one Semester of the current Academic Year, the Catalog to
 * choose a Course from, and the Picks the student has already made. Choosing a Course puts
 * its Groups on the week as options; clicking one Picks it, and clicking a Pick removes it.
 *
 * It reaches the domain only through the typed client in ../api.ts, which is the only
 * thing on this side that knows the API contract (docs/design.md, "Architecture"). Undo and redo
 * are the shell's; this screen tells the shell which revision it is showing, and re-reads when a
 * step asks it to.
 */
export function TimetablePane({
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
  /**
   * That a click's answer arrived and could not be read, so whether it was saved is not known
   * (#231). Its own flag rather than the answer put on screen as the week, for the reason
   * `takeStep` gives for a step's: the arm is reached from the 200 as well as from the refusal,
   * so the click may have landed, and the page goes and looks rather than showing a blank week
   * in place of one it can re-read. The re-read would then replace an account held in
   * `timetable`, so the account is held here, and retired as `staleSave` is.
   *
   * Held as the sentence to say, because a second case shares everything else: a save refused as
   * `save-revision-unreadable` was made and its revision could not be read (#326), so it too may
   * have landed, and the page re-reads rather than replacing the week with a refusal.
   */
  const [unknownSave, setUnknownSave] = useState<StringKey | undefined>(undefined);
  const [rereads, setRereads] = useState(0);
  /**
   * The answer a click was sent on, while the re-read its unreadable answer asked for is still in
   * flight (#231). The click may have spent the revision on screen, so this screen tells the shell
   * it has no revision to step from until a newer answer lands — a press sent on a revision the
   * click may have spent would come back `historyStale`. Held by identity, as `refusedOn` is.
   */
  const [awaitingFrom, setAwaitingFrom] = useState<TimetableState | undefined>(undefined);
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
  /**
   * The answer a save was refused `state-file-changed` on, while the re-read that refusal asked
   * for is still in flight (#334). The revision on screen is spent until that re-read lands, so an
   * edit made now would be refused again — the second click in PR #333's capture left 28 ms after
   * the re-read was answered and before it was drawn. So an edit made while this is the answer on
   * screen is held in `heldEdits`, and sent on whatever the re-read brings: the wait undo already
   * makes after a step (`steppedOn` in `../AppShell.tsx`, ADR-0013). Held by identity, as
   * `refusedOn` is.
   */
  const [rereadingFrom, setRereadingFrom] = useState<TimetableState | undefined>(undefined);
  const heldEdits = useRef<HeldEdit[]>([]);
  /** How many edits are held, so the screen can say so while they wait. */
  const [heldEditCount, setHeldEditCount] = useState(0);

  /**
   * The Variant tab the student chose, or `undefined` for the primary — which is what a Semester
   * opens on (#281). View state and never a State File edit.
   *
   * A ref rather than state, so that choosing a tab is a **re-read** of the same question and not
   * a new question: `useReloading` blanks the screen to `loading` for a new one, and a student
   * flicking between tabs should keep a week to look at until the next one arrives. What the
   * screen *shows* is never read from here — it is `timetable.variantName`, the Variant the
   * answer on screen is about — so a click made while the next tab is on its way still names the
   * Variant the student was looking at when they clicked.
   *
   * By name **and position** (#322): two Variants may share a name, and the position is what
   * reaches the second of them. The server honours the position only while the Variant there
   * carries the name.
   */
  const variantWanted = useRef<VariantWanted | undefined>(undefined);
  /**
   * Seeded once from the URL, so a reload opens the tab that was open (#325) — the server answers
   * with the primary when it no longer exists, and the page follows that answer below.
   */
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    variantWanted.current = variantInUrl(pageUrl());
  }
  /** The week, as the panel the Variant tabs control (#324). */
  const weekPanelId = useId();

  const askCatalog = useCallback(
    () => fetchOfferings(api, { academicYear, semester }),
    [academicYear, semester],
  );
  const askTimetable = useCallback(() => {
    const asked = variantWanted.current;
    return fetchTimetable(api, {
      academicYear,
      semester,
      variant: asked?.name,
      position: asked?.position,
    }).then((answer) => {
      // The tab asked for is gone — another window deleted or renamed it — and the server has
      // answered with the primary instead. The page follows the answer rather than going on
      // asking for a Variant no file holds, so the next new Variant of that name cannot steal
      // the screen. Only if nobody has chosen another tab since this read went out.
      if (
        answer.kind === "served" &&
        asked !== undefined &&
        answer.variantName !== asked.name &&
        variantWanted.current === asked
      ) {
        variantWanted.current = undefined;
      }
      return answer;
    });
  }, [academicYear, semester]);

  const [catalog]: [CatalogState, unknown] = useReloading(askCatalog, workspaceChanges);
  const [timetable, setTimetable]: [TimetableState, (answer: TimetableResult) => void] =
    useReloading(askTimetable, workspaceChanges + rereads + stepRereads);

  const offerings = catalog.kind === "served" ? catalog.offerings : [];
  /**
   * The Picks, or `undefined` for *not read yet* — which is not the same as a Variant with
   * no Picks in it. The week draws the difference and a click depends on it: an `[]` here
   * would draw a Pick as a pencil option and let a click remove it by trying to record it
   * (#111).
   */
  const picks = timetable.kind === "served" ? timetable.picks : undefined;
  const clashes = timetable.kind === "served" ? timetable.clashes : [];
  const variantWarnings = timetable.kind === "served" ? timetable.variantWarnings : [];
  const chosen = offerings.find((offering) => offering.courseNumber === selected);
  /** Which tab is shown, by position, or -1 while there is none. */
  const shownTab =
    timetable.kind === "served"
      ? shownTabIndex(timetable.variants, { name: timetable.variantName, position: timetable.variantPosition })
      : -1;

  /** A picked Course the Catalog no longer names shows its number, which it always has. */
  const nameOf = (courseNumber: string): string => {
    const known = offerings.find((offering) => offering.courseNumber === courseNumber);
    return known === undefined ? courseNumber : courseName(known, language);
  };

  /**
   * What the screen does with the answer to any edit it sent — a Pick, and every Variant edit
   * after #281, which all answer with the Timetable and can all be refused the same ways.
   *
   * `follow` runs on a served answer only, for an edit that moves which Variant the student is
   * looking at: the one just made, renamed or made primary, and the primary after a delete.
   */
  const settle = useCallback(
    (
      answer: TimetableResult,
      sentOn: TimetableState,
      follow?: (served: Extract<TimetableResult, { kind: "served" }>) => void,
    ): TimetableResult => {
    // The file is not what this page was showing, so the click was refused rather than
    // allowed to destroy whoever else's edit (#90). The week on screen is kept and
    // re-read: replacing it with the refusal would blank a week the student can still
    // see, and would throw away the revision the next click needs.
    if (answer.kind === "refused" && answer.reason === "state-file-changed") {
      setStaleSave(true);
      // and until the re-read lands, an edit made on this answer waits for it (#334)
      setRereadingFrom(sentOn);
      setRereads((count) => count + 1);
      return answer;
    }
    // An answer nobody could read, which is **not** the claim that nothing was written: the
    // arm is reached from the 200 as well as from the refusal (#231). So everything that
    // holds a revision goes and looks, as `takeStep` does for a step whose answer could not
    // be read (#206) — the week, the two buttons, and the header's switch — and the week on
    // screen is kept until the re-read replaces it. None of the three is a claim about
    // whether the click landed; all three are ways of finding out.
    //
    // **One thing `takeStep` has that this does not**: a press waits for that re-read
    // (`steppedOn`, which this sets too), and a direct click does not. A second click made before the re-read
    // lands goes out on a revision the first may have spent, and comes back
    // `state-file-changed` if it did. Held clicks are spared by the drain's wait below;
    // routing a direct click into `held` instead would change what it means, since a held
    // click asks for a Pick and a click on ink asks for its removal. Left as an open window
    // here; the `state-file-changed` arm above closes it for its own re-read (#334).
    if (
      answer.kind === "unreadable-answer" ||
      (answer.kind === "refused" && answer.reason === "save-revision-unreadable")
    ) {
      setUnknownSave(
        answer.kind === "unreadable-answer" ? "picksSaveAnswerUnreadable" : "saveUnconfirmed",
      );
      // and the undo buttons wait for that re-read, as they do after a step: a press sent
      // on a revision this click may have spent would come back `historyStale`
      setAwaitingFrom(sentOn);
      setRereads((count) => count + 1);
      onEdited();
      return answer;
    }
    if (answer.kind === "served") follow?.(answer);
    setTimetable(answer);
    // An edit makes an undo available and empties the redo stack, and a save's answer
    // does not carry the two flags. The change count reports it a poll later, which is
    // seconds of a greyed-out button the student has already earned — so it is asked for
    // here, and the poll's own answer is then the same one.
    //
    // `onEdited` is the same argument for the same reason: this write moved the file's
    // revision, and the header's language switch is holding its own.
    if (answer.kind === "served") onEdited();
    return answer;
    },
    [setTimetable, onEdited],
  );

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
      sentOn: TimetableState,
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

      return done.then((answer) => settle(answer, sentOn));
    },
    [settle],
  );

  /**
   * A press of undo or redo in the shell is the account owed now, so whatever this screen said
   * about the last click is retired — as a press here used to retire it before the buttons moved
   * into the shell (#294).
   */
  useEffect(() => {
    if (steps === 0) return;
    setStaleSave(false);
    setUnknownSave(undefined);
    setHeldLost(false);
  }, [steps]);

  /** The tab shown goes into the URL, so a reload or a bookmark opens it again (#325). */
  const shownName = timetable.kind === "served" ? timetable.variantName : undefined;
  const shownPosition = timetable.kind === "served" ? timetable.variantPosition : undefined;
  useEffect(() => {
    if (shownName !== undefined) keepVariantInUrl(pageUrl(), { name: shownName, position: shownPosition });
  }, [shownName, shownPosition]);

  /**
   * Which revision the shell may step from: the one on screen, once the State File has been read
   * and no re-read an unreadable answer asked for is still on its way. `undefined` otherwise — a
   * served view's revision is `string | undefined`, and `undefined` is the claim that there is no
   * State File, which the server fails closed on (#111).
   *
   * A layout effect, so the shell hears it before the browser paints: the buttons are enabled in
   * the same frame as the week that makes them pressable, as they were while this screen drew them.
   */
  useLayoutEffect(() => {
    onRevision(
      timetable.kind === "served" &&
        timetable.version !== undefined &&
        awaitingFrom !== timetable &&
        rereadingFrom !== timetable
        ? { version: timetable.version, answer: timetable }
        : undefined,
    );
  }, [timetable, awaitingFrom, rereadingFrom, onRevision]);

  /** Whatever became of the last click or press, the one being made now is the account owed. */
  const retireNotices = (): void => {
    setHeldLost(false);
    setStaleSave(false);
    setUnknownSave(undefined);
    onActed();
  };

  /**
   * Sends one edit on the view on screen, naming the Variant it shows. Not offered before the
   * State File has been read — there is no revision to base it on (#111) — which is why the
   * controls that call this are disabled until then.
   */
  const sendEdit = (
    edit: TimetableEdit,
    follow?: (served: Extract<TimetableResult, { kind: "served" }>) => void,
  ): Promise<TimetableResult | undefined> => {
    if (timetable.kind !== "served") return Promise.resolve(undefined);
    retireNotices();
    const sendOn = (on: Served): Promise<TimetableResult> => {
      const query = { academicYear, semester, variant: on.variantName, position: on.variantPosition };
      return edit(query, on.version).then((answer) => settle(answer, on, follow));
    };
    return rereadingFrom === timetable ? hold(timetable.variantName, sendOn) : sendOn(timetable);
  };

  /**
   * Holds an edit until the re-read a `state-file-changed` refusal asked for has landed (#334),
   * and answers with what became of it once it is sent — or `undefined` if it is dropped.
   */
  const hold = (
    variant: string,
    send: (on: Served) => Promise<TimetableResult | undefined>,
  ): Promise<TimetableResult | undefined> =>
    new Promise((resolve) => {
      heldEdits.current.push({
        variant,
        send: (on) => send(on).then((answer) => (resolve(answer), answer)),
        drop: () => resolve(undefined),
      });
      setHeldEditCount(heldEdits.current.length);
    });

  /**
   * The held edits, once the answer they wait for is on screen: sent one after another, each on
   * the answer the one before it brought, because each save moves the revision. One that is
   * refused, or a re-read that brought no week, ends the queue, and the rest are dropped with
   * `picksHeldLost` rather than vanishing (#334). So is one made on a Variant no longer shown.
   */
  useEffect(() => {
    if (rereadingFrom === undefined || timetable === rereadingFrom || timetable.kind === "loading") {
      return;
    }
    setRereadingFrom(undefined);
    const waiting = heldEdits.current.splice(0);
    setHeldEditCount(0);
    if (waiting.length === 0) return;

    void waiting.reduce<Promise<TimetableState | undefined>>(
      (previous, next) =>
        previous.then((on) => {
          if (on?.kind !== "served" || on.variantName !== next.variant) {
            next.drop();
            setHeldLost(true);
            return undefined;
          }
          return next.send(on);
        }),
      Promise.resolve(timetable),
    );
  }, [timetable, rereadingFrom]);

  /**
   * A form's edit, answered with whether it landed (#324): the Blocked Time form stays open, with
   * what the student typed, until the answer says the save went through, and says beside itself why
   * it did not. Anything but a served answer is not "landed" — an answer nobody could read may have
   * landed, and the form is then the student's to close.
   */
  const formEdit = (edit: TimetableEdit): Promise<FormAnswer> =>
    sendEdit(edit).then((answer) =>
      answer?.kind === "served"
        ? { landed: true }
        : { landed: false, said: answer === undefined ? undefined : notSavedSaid(language, answer, tokenHeld) },
    );

  /** Showing another tab: a re-read of the same question, never a State File edit. */
  const showVariant = (name: string, position: number): void => {
    variantWanted.current = { name, position };
    setRereads((count) => count + 1);
  };

  /** After an edit that moves the student to a Variant, the page asks about that one from now on. */
  const followAnswer = (served: Extract<TimetableResult, { kind: "served" }>): void => {
    variantWanted.current = { name: served.variantName, position: served.variantPosition };
  };

  const variantEdits =
    timetable.kind === "served"
      ? {
          create: (name: string | undefined) =>
            sendEdit((query, basedOn) => createVariant(api, query, name, basedOn), followAnswer),
          duplicate: () =>
            sendEdit((query, basedOn) => duplicateVariant(api, query, basedOn), followAnswer),
          rename: (name: string) =>
            sendEdit(
              (query, basedOn) => renameVariant(api, query, query.variant ?? "", name, basedOn),
              followAnswer,
            ),
          makePrimary: () =>
            sendEdit(
              (query, basedOn) => setPrimaryVariant(api, query, query.variant ?? "", basedOn),
              followAnswer,
            ),
          // the answer is about the primary that is left, which is what no choice means
          remove: () =>
            sendEdit(
              (query, basedOn) => deleteVariant(api, query, query.variant ?? "", basedOn),
              () => {
                variantWanted.current = undefined;
              },
            ),
        }
      : undefined;

  /** Adding a Course to the Tray, which also shows its Groups: it is there to be scheduled. */
  const onAddToTray =
    timetable.kind === "served"
      ? (courseNumber: string): void => {
          setSelected(courseNumber);
          sendEdit((query, basedOn) => addToTray(api, query, courseNumber, basedOn));
        }
      : undefined;

  /** Taking a Course out, with its Picks; its Groups leave the week with it. */
  const onRemoveFromTray =
    timetable.kind === "served"
      ? (courseNumber: string): void => {
          if (selected === courseNumber) setSelected(undefined);
          sendEdit((query, basedOn) => removeFromTray(api, query, courseNumber, basedOn));
        }
      : undefined;

  /** The Blocked Time edits (#282): the Semester's, whichever Variant is shown. */
  const blockedEdits =
    timetable.kind === "served"
      ? {
          add: (range: Parameters<typeof addBlockedTime>[2]) =>
            formEdit((query, basedOn) => addBlockedTime(api, query, range, basedOn)),
          replace: (index: number, range: Parameters<typeof addBlockedTime>[2]) =>
            formEdit((query, basedOn) => replaceBlockedTime(api, query, index, range, basedOn)),
          remove: (index: number) =>
            void sendEdit((query, basedOn) => removeBlockedTime(api, query, index, basedOn)),
          copyTo: (target: Semester) =>
            void sendEdit((query, basedOn) =>
              copyBlockedTimes(api, query, { academicYear, semester: target }, basedOn),
            ),
        }
      : undefined;

  const onPick = (group: WeekGroup): void => {
    retireNotices();
    // the Variant on screen when the click was made, or — before the first answer — the one
    // being asked for, which is the one that answer will be about
    const query =
      timetable.kind === "served"
        ? { academicYear, semester, variant: timetable.variantName, position: timetable.variantPosition }
        : {
            academicYear,
            semester,
            variant: variantWanted.current?.name,
            position: variantWanted.current?.position,
          };

    if (timetable.kind !== "served") {
      setHeld((waiting) => [...waiting, { group, query }]);
      return;
    }
    // Only a served answer knows this, and `picked` is a `boolean` once it does. A click on
    // ink removes the Pick; a click on pencil records one — decided on the week it was made on,
    // and kept if it has to wait for a re-read (#334).
    const remove = group.picked === true;
    if (rereadingFrom === timetable) {
      void hold(timetable.variantName, (on) =>
        save(group, remove, on.version, { ...query, position: on.variantPosition }, on),
      );
      return;
    }
    void save(group, remove, timetable.version, query, timetable);
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
    void save(next.group, false, timetable.version, next.query, sentOn).then((answer) => {
      sending.current = false;
      // This click is spent either way. A refused one is not re-sent — that is #104 — but the
      // rest of the queue must not be fired at the revision that refused it — nor at one an
      // unreadable answer may already have spent, which the re-read it triggered will settle.
      if (
        (answer.kind === "refused" &&
          (answer.reason === "state-file-changed" ||
            answer.reason === "save-revision-unreadable")) ||
        answer.kind === "unreadable-answer"
      ) {
        refusedOn.current = sentOn;
      }
      setHeld((waiting) => waiting.slice(1));
    });
  }, [held, timetable, save, academicYear, semester]);

  // one spelling of the year on the whole screen: the header and the sidebar disagreeing
  // about 2026-27 and 2027 reads as if a different year were the one missing
  const yearLabel = t(language, "academicYear", academicYearSpan(academicYear));

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)]">
        {/*
          The left column, Layout E: the Tray above, this Semester's Catalog below (#283). Two
          parts with two sources — the Tray is the State File's, the Catalog the Catalog's — so
          each says its own account of an answer it could not get, and neither covers the other's.
        */}
        <div className="flex min-h-0 flex-col gap-4 overflow-auto border-e border-rule bg-desk p-4">
          <TrayColumn
            language={language}
            tray={timetable.kind === "served" ? timetable.tray : undefined}
            nameOf={nameOf}
            selected={selected}
            onSelect={setSelected}
            onRemove={onRemoveFromTray}
          />
          <BlockedTimesEditor
            language={language}
            semester={semester}
            blockedTimes={timetable.kind === "served" ? timetable.blockedTimes : undefined}
            warnings={timetable.kind === "served" ? timetable.blockedTimeWarnings : []}
            edits={blockedEdits}
          />
          <aside className="flex min-h-0 flex-1 flex-col">
            {catalog.kind === "loading" ? (
              <p className="text-sm text-pencil">{t(language, "catalogLoading")}</p>
            ) : catalog.kind === "unreachable" ? (
              <p className="text-sm text-pencil">{t(language, "apiUnreachable")}</p>
            ) : catalog.kind === "unauthorized" ? (
              <p className="text-sm text-pencil">{unauthorizedSaid(language, tokenHeld)}</p>
            ) : /*
                 An answer this page could not read. Its own branch and **before** the fall-through,
                 because the fall-through is `CoursePicker` over an empty Catalog — a sidebar that
                 silently shows no Course and says nothing, which is #171's failure exactly.
               */
            catalog.kind === "unreadable-answer" ? (
              <p className="text-sm text-pencil">{t(language, "catalogAnswerUnreadable")}</p>
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
                added={
                  new Set(
                    timetable.kind === "served"
                      ? timetable.tray
                          .filter((entry) => entry.origins.includes("added"))
                          .map((entry) => entry.courseNumber)
                      : [],
                  )
                }
                onAdd={onAddToTray}
              />
            )}
          </aside>
        </div>

        <section className="flex min-w-0 flex-col">
          <VariantTabs
            language={language}
            variants={timetable.kind === "served" ? timetable.variants : []}
            shown={
              timetable.kind === "served"
                ? { name: timetable.variantName, position: timetable.variantPosition }
                : undefined
            }
            onShow={showVariant}
            panelId={weekPanelId}
            edits={variantEdits}
          />
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
              {held.length > 0 && timetable.kind !== "served" && (
                <span>{t(language, "picksHeld")}</span>
              )}
              {/* an edit waiting for the re-read a refusal asked for (#334) */}
              {heldEditCount > 0 && <span>{t(language, "picksHeldForReread")}</span>}
              {heldLost && <span>{t(language, "picksHeldLost")}</span>}
              {staleSave && <span>{t(language, "picksStale")}</span>}
              {unknownSave !== undefined && <span>{t(language, unknownSave)}</span>}
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

          {/* the panel the Variant tabs control, labelled by the tab shown — a tab pattern without
              one is incomplete (#324); only while there are tabs to control it */}
          <div
            className="min-h-0 flex-1 overflow-auto"
            id={weekPanelId}
            {...(shownTab === -1
              ? {}
              : { role: "tabpanel", "aria-labelledby": variantTabId(weekPanelId, shownTab) })}
          >
            <WeekGrid
              language={language}
              semester={semester}
              groups={weekGroups({
                offering: chosen,
                picks,
                nameOf,
                semester,
                blockedTimes: timetable.kind === "served" ? timetable.blockedTimes : [],
              })}
              blockedTimes={timetable.kind === "served" ? timetable.blockedTimes : []}
              clashing={clashingGroups(clashes)}
              onPick={onPick}
            />
          </div>
        </section>
      </div>
    </>
  );
}

/** Why a form's edit did not land, said beside the form (#324). */
function notSavedSaid(language: Language, answer: TimetableResult, tokenHeld: boolean): string | undefined {
  switch (answer.kind) {
    case "served":
      return undefined;
    case "refused":
      return t(language, answer.reason === undefined ? "picksUnreadable" : REFUSAL_STRING[answer.reason]);
    case "unreadable-answer":
      return t(language, "picksSaveAnswerUnreadable");
    case "unauthorized":
      return unauthorizedSaid(language, tokenHeld);
    case "unreachable":
      return t(language, "apiUnreachable");
  }
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
  return warning.kind === "variant-name-not-unique"
    ? t(language, "variantNameNotUnique", { name: warning.name })
    : t(language, "variantPrimaryNotUnique");
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
