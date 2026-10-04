import { useEffect, useState } from "react";
import { api, type createApiClient } from "./api.ts";
import { UNAUTHORIZED } from "./body.ts";

/*
 * How the page hears that the Workspace changed under it: a Catalog dropped into
 * `catalogs/` by hand, a Workspace arriving from a git clone, a file landing over Dropbox.
 * The design has said since it was agreed that "the UI reloads on external changes"
 * (docs/design.md, "Storage").
 *
 * It asks the API for one integer and reloads when that integer has moved. Nothing else:
 * `web` reaches the domain only through the HTTP API and the typed client, and a change
 * notification arriving down any other pipe would be exactly the second source of truth
 * that rule exists to prevent. `server/src/api.ts` carries the reasoning for why this is a
 * question the page asks rather than news the server pushes — an `EventSource` cannot send
 * the launch token in a header, and a websocket upgrade needs a different adapter on each
 * of the three runtimes the server has to start under.
 */

export type ApiClient = ReturnType<typeof createApiClient>;

/** Often enough that a hand-dropped Catalog appears while the student is still looking. */
export const DEFAULT_EVERY_MS = 2000;

/**
 * Repeats a poll and cancels it. Injected so a test can drive the polling itself rather
 * than waiting on a clock.
 */
export type Repeat = (poll: () => void, everyMs: number) => () => void;

const realRepeat: Repeat = (poll, everyMs) => {
  const handle = setInterval(poll, everyMs);
  return () => clearInterval(handle);
};

export type WorkspacePollOptions = {
  everyMs?: number;
  repeat?: Repeat;
};

/**
 * One ask. Reports a change only when the count differs from one it has already seen: the
 * first answer is the baseline, so a page that loads against a Workspace which has changed
 * nine times today does not reload itself the moment it opens.
 *
 * A count, never a value with meaning: the server restarts it at 0, so only the movement
 * says anything. An unanswered ask changes nothing and leaves the baseline alone — the
 * server being briefly away is not a change to the folder.
 *
 * **A refused ask is the one exception, and it is #126's whole remedy.** A poll that fails is
 * not news about the Workspace, which is why every other failure here is silent; a poll that
 * fails *with a 401* is news about **the page**, and it is the only signal there is without a
 * click. `biu-cs-planner rotate-token` replaces the launch token (ADR-0004), so a tab that
 * was open and authenticated when the app was restarted holds a retired one — and before this
 * it discarded every refused poll, kept showing what it had last read, and looked healthy
 * until a reload or the next click.
 *
 * So a refusal is reported, and the reporting is deliberately a **transition** and not an
 * answer: once per entry into refused, and once more when an ask is answered again. Reporting
 * every refused ask would re-read the whole page twice a second for as long as the token
 * stayed retired, and reporting none of the recoveries would leave a tab that *has* picked up
 * the fresh token (the same origin's store, so opening the new address in the same browser is
 * enough) still showing the sentence until something else re-rendered it.
 *
 * What it reports is still only "ask again". The sentence the student reads comes from the
 * screens' own reads, each of which says what it is about the pane it owns — one source for
 * it, rather than this module growing an opinion about the Picks.
 */
export function workspaceChangePoll(
  client: ApiClient,
  onChanged: () => void,
): () => Promise<void> {
  let seen: number | undefined;
  let asking = false;
  /** That the last answered ask was refused, so the next thing either way is worth reporting. */
  let refused = false;

  return async (): Promise<void> => {
    if (asking) return; // a slow answer must not queue a second ask behind it
    asking = true;
    try {
      const answer = await client.api.workspace.changes.$get();
      // widened deliberately: the launch token guard rejects the ask before the route runs, so
      // 401 is not among the answers the contract knows about
      const status: number = answer.status;
      if (status === UNAUTHORIZED) {
        if (refused) return;
        refused = true;
        onChanged();
        return;
      }
      // Any other refusal keeps the old silence, and leaves `refused` alone: a 500 from the
      // route says nothing about this page's token, and nothing here can act on it.
      if (!answer.ok) return;

      const { changeCount } = await answer.json();
      const moved = seen !== undefined && changeCount !== seen;
      // This page can be heard again, which is news about the page in the same way the refusal
      // was: the screens are still showing whatever they could last read.
      const heard = refused;
      refused = false;
      seen = changeCount;
      if (moved || heard) onChanged();
    } catch {
      // the server is not answering: the next ask tries again, and the page shows what it
      // has rather than an error for something the student did not do
    } finally {
      asking = false;
    }
  };
}

/**
 * Starts asking. The returned function stops, and stopping twice is a no-op.
 *
 * The first ask goes out at once rather than one interval later, because that first answer
 * is the baseline: waiting for the interval would leave a two-second window in which a file
 * that changed is read into the baseline and never reported. Asking as the page loads makes
 * that window the milliseconds between this ask and the screen's own first read.
 *
 * Stopping silences an ask that is already in flight as well as cancelling the next one. An
 * answer that arrives after the page has moved on would otherwise report a change to a
 * component that is no longer there.
 */
export function pollWorkspaceChanges(
  client: ApiClient,
  onChanged: () => void,
  options: WorkspacePollOptions = {},
): () => void {
  let stopped = false;
  const poll = workspaceChangePoll(client, () => {
    if (!stopped) onChanged();
  });

  void poll();
  const cancel = (options.repeat ?? realRepeat)(
    () => void poll(),
    options.everyMs ?? DEFAULT_EVERY_MS,
  );

  return () => {
    stopped = true;
    cancel();
  };
}

/**
 * How many times the Workspace has changed since this page loaded. Not the server's count:
 * a screen only needs to know that the number moved, and one that starts at 0 on every page
 * load cannot be mistaken for a version of anything.
 *
 * A screen takes it as a prop and names it among its effect's dependencies, which is all
 * "reload on external changes" amounts to in React.
 */
export function useWorkspaceChanges(
  options: WorkspacePollOptions & { client?: ApiClient } = {},
): number {
  const { client = api, everyMs, repeat } = options;
  const [changes, setChanges] = useState(0);

  useEffect(
    () =>
      pollWorkspaceChanges(client, () => setChanges((count) => count + 1), {
        ...(everyMs === undefined ? {} : { everyMs }),
        ...(repeat === undefined ? {} : { repeat }),
      }),
    [client, everyMs, repeat],
  );

  return changes;
}
