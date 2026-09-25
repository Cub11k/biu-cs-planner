import { expect, it } from "vitest";
import { DEFAULT_SETTLE_MS, watchWorkspace, type Schedule } from "./changes.ts";
import { memoryWorkspace } from "./workspace.memory.ts";
import { editStateFile } from "./edit.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The settling is asserted against a clock the test holds, not the machine's: `settle()`
 * runs whatever is waiting. A debounce tested against a real timer is slow when it passes
 * and flaky when it fails, and neither of those tells you whether the burst collapsed.
 */
function manualClock(): { schedule: Schedule; settle: () => void; waiting: () => number } {
  let pending: (() => void) | undefined;
  return {
    schedule: (run) => {
      pending = run;
      return () => {
        if (pending === run) pending = undefined;
      };
    },
    settle: () => {
      const run = pending;
      pending = undefined;
      run?.();
    },
    waiting: () => (pending === undefined ? 0 : 1),
  };
}

const CATALOG_2027 = { kind: "catalog" as const, academicYear: 2027 };

const PIN = { courseNumber: "83112", requirementId: "core" };

/**
 * The app's own State File save, made the way production makes one: through `editStateFile`,
 * which is the only path that writes a State File (`CLAUDE.md`, "Code guardrails", enforced by
 * `tools/ci/state-file-writer.test.ts`). Calling `workspace.saveStateFile` from here would be a
 * second write path, and it would also weaken what these tests claim — "the app's own write" is
 * the write the app actually makes, and the events the counter has to count are that path's.
 */
async function saveThroughTheApp(workspace: Workspace): Promise<void> {
  const outcome = await editStateFile(
    workspace,
    "alice",
    { label: "pin-course", apply: (state) => ({ ...state, pins: [...state.pins, PIN] }) },
    { basedOn: undefined },
  );
  // A save that did not happen would leave the counts below proving nothing.
  expect(outcome.kind).toBe("saved");
}


it("starts at nothing having changed", async () => {
  const workspace = memoryWorkspace({ created: true });

  const changes = await watchWorkspace(workspace, manualClock());

  expect(changes.changeCount()).toBe(0);
  changes.stop();
});

/** A Catalog dropped into `catalogs/` by hand: the case the ticket is built against. */
it("counts a file that appeared from outside", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  clock.settle();

  expect(changes.changeCount()).toBe(1);
  changes.stop();
});

/**
 * The reason this layer exists. A Workspace arriving from a git clone writes every file it
 * has, and an editor saving one file emits several events on its own; the page should
 * reload once, when the folder is quiet again.
 */
it("collapses a burst into one change", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  for (const academicYear of [2025, 2026, 2027, 2028, 2029]) {
    workspace.seed({ kind: "catalog", academicYear }, { schemaVersion: 1 });
  }
  expect(changes.changeCount()).toBe(0); // nothing yet: the folder is still busy
  clock.settle();

  expect(changes.changeCount()).toBe(1);
  changes.stop();
});

/** One per burst, not one ever: a second edit a minute later is a second reload. */
it("counts a later burst separately", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  clock.settle();
  workspace.seed(CATALOG_2027, { schemaVersion: 1, offerings: [] });
  workspace.seed(CATALOG_2027, { schemaVersion: 1, offerings: [] });
  clock.settle();

  expect(changes.changeCount()).toBe(2);
  changes.stop();
});

/**
 * Deletion and creation both count. Watching a file cannot see the file that appears, and
 * watching a folder sees the one that goes away too.
 */
it("counts a file that went away from outside", async () => {
  const workspace = memoryWorkspace({ created: true });
  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  workspace.remove(CATALOG_2027);
  clock.settle();

  expect(changes.changeCount()).toBe(1);
  changes.stop();
});

/**
 * A real watcher cannot tell the app's own write from an editor's, so this counts both. The
 * save-time guard that tells them apart — "each save carries the file version it was based
 * on" — is the other half of the design's paragraph and belongs with the writer (#63).
 */
it("counts the app's own write, because a watcher cannot tell whose it was", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  await workspace.write(CATALOG_2027, { schemaVersion: 1 });
  clock.settle();

  expect(changes.changeCount()).toBe(1);
  changes.stop();
});

/**
 * The same for a State File save, which is the write autosave will make every few seconds and
 * the one #88 was filed about. It is counted, deliberately: **the fix is that a page tolerates
 * its own write, not that it is spared one** (see the ruling in `./changes.ts`). This counter
 * is a single number served to every poller, so sparing the saving page would spare the other
 * tab too, and for that tab the save is an external change (ADR-0013).
 */
it("counts the app's own State File save, which is the autosave case", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  await saveThroughTheApp(workspace);
  clock.settle();

  expect(changes.changeCount()).toBe(1);
  changes.stop();
});

/**
 * The app's own save and somebody else's edit in one burst are one reported change — one
 * reload, which re-reads both, because collapsing is not swallowing.
 *
 * **What this cannot prove, and the next test can.** One is what a working counter reports and
 * also what a counter that heard only one of the two would report, so this asserts the
 * collapsing and not that both were heard. A single number is not separable that way; the
 * discriminating question is whether an external edit is still counted *after* the app has
 * written, which is the test below.
 */
it("collapses the app's own save and an external edit into one change", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  await saveThroughTheApp(workspace);
  // somebody else, into the same still-open window
  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  clock.settle();

  expect(changes.changeCount()).toBe(1);
  changes.stop();
});

/**
 * **A genuine external edit is never lost to the app having written.** The app saves, that
 * burst settles, and somebody else's edit moves the count *again* — two changes, not one.
 *
 * This is the discriminating one, and the failure it guards is a suppression that latches:
 * anything that decides "the app is the writer here" and keeps deciding it, or whose window
 * outlives the write that opened it, reports one change instead of two and the student's own
 * editor, Dropbox or git goes unheard. Unlike the test above, the two events are in separate
 * bursts, so the count can say which of them it missed.
 */
it("counts an external edit that follows the app's own save, as a second change", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  await saveThroughTheApp(workspace);
  clock.settle();
  expect(changes.changeCount()).toBe(1);

  // and now somebody else, in a burst of their own
  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  clock.settle();

  expect(changes.changeCount()).toBe(2);
  changes.stop();
});

/**
 * The layout itself appearing is a change: a Workspace being created, or a clone arriving
 * with its folders. This is why the adapter watches the folder the layout sits in and not
 * only the layout's folders, which do not exist yet at that moment.
 */
it("counts the layout being created", async () => {
  const workspace = memoryWorkspace();
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  await workspace.create();
  clock.settle();

  expect(changes.changeCount()).toBe(1);
  changes.stop();
});

/**
 * Stopping matters as much as starting: a watcher left open stops Ctrl-C ending the server
 * and would hang a CI smoke leg. Both handles have to go — the folder's and the timer's.
 */
it("lets go of the watcher and the pending timer when it stops", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);
  expect(workspace.watching()).toBe(1);

  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  expect(clock.waiting()).toBe(1);

  changes.stop();

  expect(workspace.watching()).toBe(0);
  expect(clock.waiting()).toBe(0);
});

it("reports nothing after it has stopped, and stops twice without complaint", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  changes.stop();
  changes.stop();
  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  clock.settle();

  expect(changes.changeCount()).toBe(0);
  expect(workspace.watching()).toBe(0);
});

/**
 * The default settling, through a real timer — the one arrangement that actually ships, and
 * the one every test above replaces. Short enough to be worth the wait, and the only place
 * here that waits at all.
 */
it("settles on its own clock when no schedule is given", async () => {
  const workspace = memoryWorkspace({ created: true });
  const changes = await watchWorkspace(workspace, { settleMs: 20 });

  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  expect(changes.changeCount()).toBe(0);
  await new Promise((settle) => setTimeout(settle, 80));

  expect(changes.changeCount()).toBe(1);
  changes.stop();
});

/** A settling time that is a value, so the burst cannot be collapsed by accident. */
it("waits a fifth of a second by default", () => {
  expect(DEFAULT_SETTLE_MS).toBe(200);
});
