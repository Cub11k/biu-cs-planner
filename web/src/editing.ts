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
 * `save-revision-unreadable`, `unreadable-answer`, `unreachable` — until that re-read's answer is on
 * screen, served or not, `send` sends nothing. Nor does it while an edit is in flight. The gate is
 * held in refs rather than read off the render (#394), so two `send`s in one batch send one edit.
 *
 * `load` is the question: memoise it. `keep` decides that a fresh answer is **not** put on screen,
 * the one on screen kept instead (#218); by default a read that never arrived keeps a served answer,
 * which the screen labels stale (#184, #406). A kept re-read leaves the gate shut: the revision on
 * screen is still the spent one, and the changes poll asks again once the server answers. `onEdited`
 * is told when an edit wrote the file, or may have.
 */
export function useEditing<T extends { kind: string }>(
  load: () => Promise<T>,
  changes: number,
  onEdited: () => void,
  keep: (fresh: T, onScreen: Loading | T) => boolean = keepOverUnreachable,
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
  /** The gate as it stands now, not as last rendered: `sending` and `spent` are its render copies. */
  const gate = useRef({ sending: false, spent: false });
  const setGate = (to: Partial<typeof gate.current>): void => {
    gate.current = { ...gate.current, ...to };
    if (to.sending !== undefined) setSending(to.sending);
    if (to.spent !== undefined) setSpent(to.spent);
  };

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
      if (keepRef.current(fresh, onScreen.current)) {
        setKept((count) => count + 1);
        return;
      }
      // whatever this read brings, it is what the file says now
      setGate({ spent: false });
      put(fresh);
    });
    return () => {
      shown.current += 1;
    };
  }, [load, changes, rereads]);

  const send: Editing<T>["send"] = (edit, settle) => {
    // the revision is the rendered one: a handler builds its edit from what the student saw
    if (answer.kind !== "served" || gate.current.sending || gate.current.spent) return false;
    setGate({ sending: true });
    void edit((answer as unknown as { version: RevisionOf<T> }).version).then((settled) => {
      setGate({ sending: false });
      const reason = settled.kind === "refused" ? (settled as { reason?: unknown }).reason : undefined;
      if (settled.kind === "served") {
        shown.current += 1;
        put(settled);
        onEdited();
      } else if (
        reason === "state-file-changed" ||
        reason === "save-revision-unreadable" ||
        settled.kind === "unreadable-answer" ||
        // the request may have reached the server and written before the connection failed (#397)
        settled.kind === "unreachable"
      ) {
        // a read already in flight was asked before the file moved, so only the re-read releases
        shown.current += 1;
        setGate({ spent: true });
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

/** The default `keep`: an answer that never arrived says nothing about the file a served answer showed. */
const keepOverUnreachable = (fresh: { kind: string }, onScreen: { kind: string }): boolean =>
  fresh.kind === "unreachable" && onScreen.kind === "served";
