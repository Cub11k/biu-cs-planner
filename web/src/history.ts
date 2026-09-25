/**
 * Undo and redo, as the page reaches them: the three routes #139 built, behind the typed
 * client and nothing else (`docs/design.md`, "Architecture"; ADR-0002).
 *
 * Beside the components rather than inside one, for the same reason `timetable/picks.ts` is:
 * the requests and every answer the API can give are testable against a fake fetch, without
 * a browser. Every shape below is read off the contract with `InferResponseType` and none is
 * redeclared here, so a reason added to the API is a compile error in the component that has
 * to say it rather than a sentence that silently never shows.
 *
 * **Availability is the server's answer, never a count this page keeps.** The stacks live in
 * the server process and outlive the page, so a reloaded tab — or a second one — finds an
 * undo it never made still waiting (ADR-0013). A page that counted its own edits would be
 * wrong about that from the moment it loaded.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { ApiClient } from "./changes.ts";
import type { InferRequestType, InferResponseType } from "hono/client";

type HistoryRoutes = ApiClient["api"]["history"];
type StepRoute = HistoryRoutes["undo"]["$post"];
type StepAnswer = InferResponseType<StepRoute>;

/** Whether there is anything to undo or to redo: exactly what `GET /api/history` answers. */
export type HistoryAvailability = InferResponseType<HistoryRoutes["$get"]>;

/** The 200: what moved, and the two flags as they stand afterwards. */
type Moved = Extract<StepAnswer, { label: unknown }>;
/** The 409: why nothing moved, and the same two flags, so the buttons can correct themselves. */
type Refused = Extract<StepAnswer, { reason: unknown }>;

/** Why an undo or a redo did not happen. Eight reasons; the component names all eight. */
export type HistoryRefusal = Refused["reason"];

/** A Warning the answer carried. Reported, never a refusal in itself. */
export type HistoryWarning = Refused["warnings"][number];

/**
 * The revision the page was showing, which every step carries exactly as a save does: an
 * undo *is* a save and goes through the same external-edit guard (ADR-0013). `undefined` is
 * the claim that there is no State File, which fails closed — so a caller with no revision
 * in hand must not step at all rather than send one (#111).
 *
 * Read off the revision the answer carries rather than off the request: the routes parse their
 * body with `bodyAs` rather than a validator, so the contract types the path and not the body,
 * exactly as `timetable/picks.ts` says of its own — which is also why the request below is
 * cast. One type either way, since what a step is based on is what a step returns.
 */
export type StepBasedOn = Moved["version"];

/** Which way a step went, which the answer does not say and the sentence about it needs. */
export type Direction = "undo" | "redo";

export type HistoryStep =
  | {
      kind: "moved";
      /** The edit's own word for itself — `pick-group` — which the UI translates. */
      label: Moved["label"];
      at: Moved["at"];
      available: HistoryAvailability;
    }
  | {
      kind: "refused";
      reason: HistoryRefusal | undefined;
      warnings: HistoryWarning[];
      /**
       * Absent only for an answer the contract has but this module cannot produce: a 400 on
       * a body it does not send. Typed rather than asserted away, because the alternative is
       * a cast that would also swallow a real contract change.
       */
      available: HistoryAvailability | undefined;
    }
  /** This page has no launch token, so the server will not talk to it (ADR-0004). */
  | { kind: "unauthorized" }
  /** The request never arrived: the server is not running, or not running here. */
  | { kind: "unreachable" };

/** The guard answers before the route does, so its status is not one of the route's. */
const UNAUTHORIZED = 401;

/** A body that is neither shape the routes send. Neither flag is claimed from it. */
const unnamed = (warnings: HistoryWarning[]): HistoryStep => ({
  kind: "refused",
  reason: undefined,
  warnings,
  available: undefined,
});

/**
 * Whether undo and redo are available. `undefined` for *not answered*, which is not the same
 * as neither being available: the first is a question still in flight or a server that is
 * not there, and a page that turned it into `false` would be making the server's claim for
 * it. Both read as a disabled button, and only one of them is honest about why.
 */
export async function fetchAvailability(
  client: ApiClient,
): Promise<HistoryAvailability | undefined> {
  try {
    const answer = await client.api.history.$get();
    if (!answer.ok) return undefined;

    const body = await answer.json();
    // The contract says both are booleans; a body that is not this one is not an answer to
    // trust a button with, and `undefined` is what "nobody has said yet" already means.
    return typeof body.canUndo === "boolean" && typeof body.canRedo === "boolean"
      ? { canUndo: body.canUndo, canRedo: body.canRedo }
      : undefined;
  } catch {
    return undefined;
  }
}

/** One step, read the way `timetable/picks.ts` reads a save: one place decides each status. */
async function read(answer: Response & { ok: boolean; status: number }): Promise<HistoryStep> {
  if (!answer.ok) {
    // widened deliberately: the launch token guard rejects before the route runs, so 401 is
    // not among the answers the contract knows about
    const status: number = answer.status;
    if (status === UNAUTHORIZED) return { kind: "unauthorized" };

    const body = (await answer.json()) as Partial<Refused>;
    const warnings = body.warnings ?? [];
    if (body.reason === undefined) return unnamed(warnings);

    return {
      kind: "refused",
      reason: body.reason,
      warnings,
      available:
        typeof body.canUndo === "boolean" && typeof body.canRedo === "boolean"
          ? { canUndo: body.canUndo, canRedo: body.canRedo }
          : undefined,
    };
  }

  const body = (await answer.json()) as Moved;
  return {
    kind: "moved",
    label: body.label,
    at: body.at,
    available: { canUndo: body.canUndo, canRedo: body.canRedo },
  };
}

/**
 * Sends one request and reads the answer **outside** the catch: only the request failing is
 * the server not being there. An answer this module cannot make sense of is a contract
 * problem, and calling it "unreachable" would send the student to look at a server that
 * answered them.
 */
async function ask(
  send: () => Promise<Response & { ok: boolean; status: number }>,
): Promise<HistoryStep> {
  let answer: Response & { ok: boolean; status: number };
  try {
    answer = await send();
  } catch {
    return { kind: "unreachable" };
  }
  return read(answer);
}

/**
 * One step in either direction. The route is the only difference, which is why this takes
 * the direction rather than being written twice — the shape of a redo cannot drift from the
 * shape of an undo, exactly as `server/src/history.ts` writes one `step` for both.
 */
export async function takeStep(
  client: ApiClient,
  direction: Direction,
  basedOn: StepBasedOn,
): Promise<HistoryStep> {
  const request = { json: { basedOn } } as InferRequestType<StepRoute>;
  return ask(() =>
    direction === "undo"
      ? client.api.history.undo.$post(request)
      : client.api.history.redo.$post(request),
  );
}

export type UseHistoryOptions = {
  client?: ApiClient;
  /**
   * How many times the Workspace has changed since the page loaded. Named among this hook's
   * dependencies for the same reason a screen names it among its own: another tab's edit, or
   * a hand-dropped file, changes what can be undone, and this page hears about it the one way
   * it hears about anything on disk (`./changes.ts`).
   */
  changes?: number;
};

export type History = {
  /** The server's last answer about the two buttons, or `undefined` until it has given one. */
  available: HistoryAvailability | undefined;
  /** Whether a step is in flight, so a second click cannot be sent on a spent revision. */
  stepping: boolean;
  /**
   * Takes one step and hands back what happened, having already applied the availability the
   * answer carried. The caller gets the answer because the sentence the student is owed, and
   * the decision to re-read, are the screen's to make and not this hook's.
   */
  step: (direction: Direction, basedOn: StepBasedOn) => Promise<HistoryStep>;
  /**
   * Ask again. Called after an edit, which makes an undo available and empties the redo
   * stack — and which the change count only reports a poll later, too late for a student
   * looking at the button they just earned.
   */
  ask: () => void;
};

/**
 * The two buttons' state, and the steps themselves.
 *
 * Answers are counted rather than flagged, the way `TimetableScreen`'s `useReloading` counts
 * them: a step's own write moves the Workspace change count, so the re-ask that triggers can
 * be sent before the step lands and answer after it, and a bare "is this effect current"
 * flag would let that older answer grey out a button the step had just lit up.
 */
export function useHistory(options: UseHistoryOptions = {}): History {
  const { client = api, changes = 0 } = options;
  const [available, setAvailable] = useState<HistoryAvailability | undefined>(undefined);
  const [stepping, setStepping] = useState(false);
  const [asks, setAsks] = useState(0);
  /** Which answer the buttons are showing. Every source of one moves it. */
  const shown = useRef(0);

  const ask = useCallback(() => setAsks((count) => count + 1), []);

  const step = useCallback(
    async (direction: Direction, basedOn: StepBasedOn): Promise<HistoryStep> => {
      setStepping(true);
      try {
        const answer = await takeStep(client, direction, basedOn);
        // The freshest word there is on the two flags: the server answered it after moving
        // the stacks. A refusal carries them too, which is how a button that was wrong
        // corrects itself without a second request.
        if (answer.kind === "moved" || (answer.kind === "refused" && answer.available)) {
          shown.current += 1;
          setAvailable(answer.available);
        }
        return answer;
      } finally {
        setStepping(false);
      }
    },
    [client],
  );

  useEffect(() => {
    const mine = (shown.current += 1);
    void fetchAvailability(client).then((answered) => {
      if (shown.current !== mine || answered === undefined) return;
      setAvailable(answered);
    });

    return () => {
      // whatever this run asked about is no longer what the buttons are waiting on
      shown.current += 1;
    };
  }, [client, changes, asks]);

  return { available, stepping, step, ask };
}
