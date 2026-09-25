import { expect, it } from "vitest";
import { DEFAULT_SETTLE_MS, watchWorkspace, type Schedule } from "./changes.ts";
import { memoryWorkspace } from "./workspace.memory.ts";

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
const ALICE = { kind: "state" as const, name: "alice" };

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

  await workspace.saveStateFile(ALICE, { json: { schemaVersion: 1 }, basedOn: undefined });
  clock.settle();

  expect(changes.changeCount()).toBe(1);
  changes.stop();
});

/**
 * A genuine external edit is never lost to the app's own write, even in the same burst. The
 * two collapse into one reported change — one reload, which re-reads both — and one is the
 * right answer: what must not happen is nought. This is the assertion a suppression held open
 * "for the duration of the write", or over a debounce window already running, would fail.
 */
it("still reports an external edit that lands in the same burst as the app's own save", async () => {
  const workspace = memoryWorkspace({ created: true });
  const clock = manualClock();
  const changes = await watchWorkspace(workspace, clock);

  await workspace.saveStateFile(ALICE, { json: { schemaVersion: 1 }, basedOn: undefined });
  // somebody else, into the same still-open window
  workspace.seed(CATALOG_2027, { schemaVersion: 1 });
  clock.settle();

  expect(changes.changeCount()).toBe(1);
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
