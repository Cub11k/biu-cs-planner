import { useEffect, useRef, useState } from "react";

/** What a screen shows before its first answer arrives. */
export type Loading = { kind: "loading" };

/** The revision a served answer carries, which an edit is based on. */
type RevisionOf<T> = Extract<T, { kind: "served" }> extends { version: infer V } ? V : never;

export type Editing<T> = {
  /** The answer on screen: the last read, or an edit's own, whichever is newer. */
  answer: Loading | T;
  /**
   * One edit, based on the revision on screen. The hook takes a served answer, and starts a re-read
   * on an answer that says the file moved or may have; `settle` then hears every answer, for the
   * screen's own sentence. Returns `false`, sending nothing, while no edit may be sent.
   */
  send: (edit: (basedOn: RevisionOf<T>) => Promise<T>, settle?: (answer: T) => void) => boolean;
  /** An edit is in flight: its answer carries the next revision. */
  sending: boolean;
  /** The revision on screen is spent, and its re-read is not drawn yet (GLOSSARY "Revision"). */
  spent: boolean;
  /** How many re-reads an edit's answer has started, for the screen's other reads to follow. */
  rereads: number;
  /** How many fresh answers in a row `keep` kept off screen, `0` once one is taken. */
  kept: number;
};

/**
 * One screen's read of the State File and every edit it sends (#378): read, re-read when `changes`
 * moves, the answer on screen kept until a new one arrives. Plan and Progress read and edit through
 * it, and so is the Timetable meant to (#381).
 *
 * **An answer older than the one on screen is dropped**, an edit's own counting as the newest. It
 * is counted rather than flagged because a save is itself what moves the change count: the re-read
 * it triggers can answer after the edit's own answer is on screen.
 *
 * **The spent-revision gate** (#377): from an answer that starts a re-read — `state-file-changed`,
 * `save-revision-unreadable`, `unreadable-answer` — until that re-read's answer is on screen, served
 * or not, `send` sends nothing.
 *
 * `load` is the question: memoise it. `keep` decides that a fresh answer is **not** put on screen,
 * the one on screen kept instead (#218). `onEdited` is told when an edit wrote the file, or may have.
 */
export function useEditing<T extends { kind: string }>(
  load: () => Promise<T>,
  changes: number,
  onEdited: () => void,
  keep: (fresh: T, onScreen: Loading | T) => boolean = () => false,
): Editing<T> {
  const [answer, setAnswer] = useState<Loading | T>({ kind: "loading" });
  const [kept, setKept] = useState(0);
  const [rereads, setRereads] = useState(0);
  const [sending, setSending] = useState(false);
  const [spent, setSpent] = useState(false);
  /** What is on screen, for `keep` to compare a fresh answer with. */
  const onScreen = useRef<Loading | T>(answer);
  const keepRef = useRef(keep);
  keepRef.current = keep;
  /** Which answer the screen is waiting on: one asked before the latest is dropped. */
  const shown = useRef(0);

  const put = (next: T): void => {
    onScreen.current = next;
    setAnswer(next);
    setKept(0);
  };

  useEffect(() => {
    const mine = (shown.current += 1);
    // `load` resolves for every answer the API can give: a rejection would be a client bug
    void load().then((fresh) => {
      if (shown.current !== mine) return;
      // whatever this read brings, it is what the file says now.
      // shortcut: a re-read `keep` keeps off screen releases the gate too, leaving the spent revision
      // editable; nothing passes `keep` yet, and #381 decides this when the Timetable moves on.
      setSpent(false);
      if (keepRef.current(fresh, onScreen.current)) setKept((count) => count + 1);
      else put(fresh);
    });
    return () => {
      shown.current += 1;
    };
  }, [load, changes, rereads]);

  const send: Editing<T>["send"] = (edit, settle) => {
    if (answer.kind !== "served" || sending || spent) return false;
    setSending(true);
    void edit((answer as unknown as { version: RevisionOf<T> }).version).then((settled) => {
      setSending(false);
      const reason = settled.kind === "refused" ? (settled as { reason?: unknown }).reason : undefined;
      if (settled.kind === "served") {
        shown.current += 1;
        put(settled);
        onEdited();
      } else if (
        reason === "state-file-changed" ||
        reason === "save-revision-unreadable" ||
        settled.kind === "unreadable-answer"
      ) {
        // a read already in flight was asked before the file moved, so only the re-read releases
        shown.current += 1;
        setSpent(true);
        setRereads((count) => count + 1);
        // the save may have landed (#326): everything holding a revision goes and looks
        if (reason !== "state-file-changed") onEdited();
      }
      settle?.(settled);
    });
    return true;
  };

  return { answer, send, sending, spent, rereads, kept };
}
