import { useEffect, useState } from "react";
import { api, type createApiClient } from "./api.ts";

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
 */
export function workspaceChangePoll(
  client: ApiClient,
  onChanged: () => void,
): () => Promise<void> {
  let seen: number | undefined;
  let asking = false;

  return async (): Promise<void> => {
    if (asking) return; // a slow answer must not queue a second ask behind it
    asking = true;
    try {
      const answer = await client.api.workspace.changes.$get();
      if (!answer.ok) return;

      const { changeCount } = await answer.json();
      const moved = seen !== undefined && changeCount !== seen;
      seen = changeCount;
      if (moved) onChanged();
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
