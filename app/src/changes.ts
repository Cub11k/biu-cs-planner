import type { Workspace, WorkspaceWatcher } from "./workspace.ts";

/**
 * Watching the Workspace for changes the app did not make: a Catalog dropped into
 * `catalogs/` by hand, a Workspace arriving from a git clone, a file landing over
 * Dropbox. The design has said since it was agreed that "the server watches the Workspace
 * folder, not individual files, and the UI reloads on external changes"
 * (docs/design.md, "Storage"); this is the half of that sentence that does not need a
 * writer, and it is the half that decides what the UI is told.
 *
 * What the UI is told is a **number**, and nothing else. Every burst of filesystem events
 * moves one counter, `web` asks for it through the HTTP API and reloads when it has moved.
 * A number is the smallest thing that can carry "something changed" over a plain request,
 * which is what let the notification stay inside the one edge `web` is allowed to use — see
 * `server/src/api.ts` for why that ruled out Server-Sent Events and a websocket.
 *
 * The collapsing lives here rather than in either adapter, so that both get it and a test
 * can drive a burst through the in-memory Workspace without a disk and without a clock.
 */

/** How long the folder has to go quiet before one change is reported. */
export const DEFAULT_SETTLE_MS = 200;

/**
 * Cancels the run it scheduled. Injected so a test drives the settling itself: a debounce
 * asserted against a real clock is a test that is slow when it passes and flaky when it
 * fails.
 */
export type Schedule = (run: () => void, afterMs: number) => () => void;

const realSchedule: Schedule = (run, afterMs) => {
  const handle = setTimeout(run, afterMs);
  return () => clearTimeout(handle);
};

export type WorkspaceChangesOptions = {
  settleMs?: number;
  schedule?: Schedule;
};

export type WorkspaceChanges = {
  /**
   * Starts at 0 and moves by one per burst. `web` compares it against the last one it
   * saw, so only the movement means anything — never the value, which restarts at 0 with
   * the server and says nothing about how many times the folder has ever changed.
   */
  revision(): number;
  /** Stops watching. Idempotent, and leaves no timer and no watcher behind. */
  stop(): void;
};

/**
 * Watches the Workspace and counts settled changes.
 *
 * Debounced rather than throttled: an editor writing one file emits several events and a
 * clone emits a burst, and both should reload the page once, after the folder is quiet.
 * A throttle would report the first event and then the tail of the burst as a second
 * change, which is one reload too many on every save.
 */
export async function watchWorkspace(
  workspace: Workspace,
  options: WorkspaceChangesOptions = {},
): Promise<WorkspaceChanges> {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const schedule = options.schedule ?? realSchedule;

  let revision = 0;
  let stopped = false;
  let cancelPending: (() => void) | undefined;

  const settled = (): void => {
    cancelPending = undefined;
    if (stopped) return;
    revision += 1;
  };

  const watcher: WorkspaceWatcher = await workspace.watch(() => {
    if (stopped) return;
    // each event restarts the wait, so the burst is over before the count moves
    cancelPending?.();
    cancelPending = schedule(settled, settleMs);
  });

  return {
    revision: () => revision,
    stop(): void {
      stopped = true;
      cancelPending?.();
      cancelPending = undefined;
      watcher.stop();
    },
  };
}
