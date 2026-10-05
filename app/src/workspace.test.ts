import { expect, it } from "vitest";
import {
  BackupRefusedError,
  BACKUP_KEEP_DAYS,
  BACKUP_KEEP_SAVES,
  backupDay,
  backupsToPrune,
  isRequirementsFileName,
  isStateFileName,
  isStateFileRevision,
  NotAWorkspaceError,
  requireBackupRef,
  requireCatalogRef,
  requireRequirementsFileName,
  requireStateFileName,
  requireWholeFileRef,
  statusOf,
  WorkspaceRefusedError,
  type BackupRef,
  type WorkspaceRefusal,
} from "./workspace.ts";

/**
 * The name rule stands between free text and a filesystem: a State File is the first
 * `WorkspaceRef` that carries a name rather than a number, so this is the one function in the
 * port that a hostile or careless name reaches. It is tested here directly rather than only
 * through the two adapters, because a clause no adapter test happens to exercise is a clause
 * that can be relaxed without anything failing.
 */

const ACCEPTED = [
  ["an ordinary name", "alice"],
  ["a name in Hebrew, which is the point of not fixing an alphabet", "אליס"],
  // The gershayim, U+05F4, and not an ASCII double quote — that one Windows refuses.
  ["Hebrew punctuation", "נ\u05f4צ"],
  ["a space inside", "alice and bob"],
  ["digits and punctuation", "alice-2027_take.2"],
  ["64 characters, the longest allowed", "a".repeat(64)],
];

const REFUSED = [
  ["nothing at all", ""],
  ["longer than 64 characters", "a".repeat(65)],
  ["a parent directory", ".."],
  ["this directory", "."],
  ["a path", "sub/alice"],
  ["a path out of the Workspace", "../escaped"],
  ["a Windows path", "sub\\alice"],
  ["a Windows drive", "C:alice"],
  ["a hidden file", ".hidden"],
  ["a wildcard Windows refuses", "alice*"],
  ["a redirection Windows refuses", "alice>bob"],
  ["a quote Windows refuses", 'alice"bob'],
  ["a pipe Windows refuses", "alice|bob"],
  ["a question mark Windows refuses", "alice?"],
  ["a tab", "alice\tbob"],
  ["a newline", "alice\nbob"],
  ["a leading space no one can see", " alice"],
  ["a trailing space no one can see", "alice "],
  // Two State Files whose names are indistinguishable in a listing and in the UI is the same
  // trouble as one name that is a path, in an app whose second language is read right to left.
  ["a zero-width space", "alice​"],
  ["a left-to-right mark", "alice‎"],
  ["a lone surrogate", "alice\ud800"],
  // Win32 reserves these whatever is appended, so `NUL.state.json` is the null device: the
  // save reports success and the bytes are gone.
  ["the null device", "nul"],
  ["the console, in any case", "CON"],
  ["a serial port", "com1"],
  ["a printer port", "LPT9"],
];

it.each(ACCEPTED)("accepts %s", (_what, name) => {
  expect(isStateFileName(name)).toBe(true);
  expect(() => requireStateFileName(name)).not.toThrow();
});

it.each(REFUSED)("refuses %s", (_what, name) => {
  expect(isStateFileName(name)).toBe(false);
  expect(() => requireStateFileName(name)).toThrow(WorkspaceRefusedError);
});

/**
 * A Requirements File's name is held to the same rule (#287), and by its own function, so the
 * two cannot drift apart on what a path is: every name above is accepted or refused for both.
 */
it.each(ACCEPTED)("accepts %s as a Requirements File's name", (_what, name) => {
  expect(isRequirementsFileName(name)).toBe(true);
  expect(() => requireRequirementsFileName(name)).not.toThrow();
});

it.each(REFUSED)("refuses %s as a Requirements File's name", (_what, name) => {
  expect(isRequirementsFileName(name)).toBe(false);
  expect(() => requireRequirementsFileName(name)).toThrow(WorkspaceRefusedError);
});

it("refuses a hostile Requirements File name as a name, naming the Requirements File", () => {
  let refused: unknown;
  try {
    requireRequirementsFileName("../alice.state");
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(WorkspaceRefusedError);
  expect((refused as WorkspaceRefusedError).refusal).toEqual({
    reason: "not-a-name",
    subject: { kind: "requirements", name: "../alice.state" },
  });
});

/**
 * What a whole-file read or write may be handed since #287: a Catalog's ref or a Requirements
 * File's, each held to its own rule, and never a State File's.
 */
it("lets a Catalog and a Requirements File through a whole-file read or write, and no State File", () => {
  expect(() => requireWholeFileRef({ kind: "catalog", academicYear: 2027 })).not.toThrow();
  expect(() => requireWholeFileRef({ kind: "requirements", name: "cs-2027" })).not.toThrow();

  expect(() => requireWholeFileRef({ kind: "requirements", name: "../cs" })).toThrow(
    WorkspaceRefusedError,
  );
  expect(() => requireWholeFileRef({ kind: "catalog", academicYear: "../x" } as never)).toThrow(
    /a year is a whole number/,
  );
  expect(() => requireWholeFileRef({ kind: "state", name: "alice" })).toThrow(
    /State File "alice".*readStateFile/s,
  );
});

it("keeps refusing a Requirements File where only a Catalog is asked for", () => {
  expect(() => requireCatalogRef({ kind: "requirements", name: "cs-2027" })).toThrow(
    WorkspaceRefusedError,
  );
});

/** A refusal a student can act on names what was refused, so the message carries the name. */
it("says which name it refused", () => {
  expect(() => requireStateFileName("../escaped")).toThrow(/\.\.\/escaped/);
});

/**
 * The other refusal both adapters share, and the runtime half of narrowing `read` and `write`
 * to a `CatalogRef` (#113). Tested here for the same reason the name rule is: it is one
 * function, and an adapter test that happened to stop exercising it would leave it free to be
 * relaxed with nothing failing.
 */
it("lets a Catalog through a whole-file read or write", () => {
  expect(() => requireCatalogRef({ kind: "catalog", academicYear: 2027 })).not.toThrow();
});

it("refuses a Catalog whose year is not a whole number, which an adapter turns into a path", () => {
  for (const academicYear of ["../alice.state", "2027/../..", 2027.5, NaN, Infinity]) {
    expect(() => requireCatalogRef({ kind: "catalog", academicYear } as never)).toThrow(
      WorkspaceRefusedError,
    );
  }
  // and the ordinary ones still pass, including a year no Catalog would sensibly carry: the
  // range is the API's rule, and this one is only about what can become a path
  for (const academicYear of [2027, 0, -1, 9999]) {
    expect(() => requireCatalogRef({ kind: "catalog", academicYear })).not.toThrow();
  }
});

it("refuses a State File handed to a whole-file read or write", () => {
  expect(() => requireCatalogRef({ kind: "state", name: "alice" })).toThrow(WorkspaceRefusedError);
  // it names the file, and says where a State File is read and saved instead
  expect(() => requireCatalogRef({ kind: "state", name: "alice" })).toThrow(
    /State File "alice".*readStateFile.*saveStateFile/s,
  );
});

/**
 * The third refusal both adapters share, and the newest (#121). Tested here for the reason the
 * other two are: it is one sentence, and the whole value of its being here is that neither
 * adapter can word it differently — which is a property of this file rather than of either
 * adapter's tests. It was a plain `Error` at three sites, two in `server/src/workspace.fs.ts`
 * and one spelling the same words again in `app/src/workspace.memory.ts`.
 */
it("refuses a write into a folder that is not a Workspace, as a refusal and not a plain Error", () => {
  const refusal = new NotAWorkspaceError();

  // What makes it answerable: `app/src/edit.ts` and `app/src/catalog.ts` catch
  // `WorkspaceRefusedError` and word it as `workspace-refused`, which `server/src/api.ts`
  // answers with a 409. A plain `Error` is caught by nothing, which is what made this the
  // first unnamed 500 the API would ever have had.
  expect(refusal).toBeInstanceOf(WorkspaceRefusedError);
  expect(refusal).toBeInstanceOf(NotAWorkspaceError);
  expect(refusal.message).toBe("refusing to write: the Workspace layout does not exist yet");
  expect(refusal.folder).toBeUndefined();
});

/**
 * The second way a layout is not one: a plain file standing where a folder of it belongs, which
 * `status` used to report as ready (it reports it under `notAFolder` now, #243) and a write used
 * to meet as a raw `ENOTDIR` (#121). The stem is
 * shared and the tail is the adapter's, because "is there and is not a folder" and "could not
 * be made" are different news about the same folder.
 */
it("names the part of the Workspace Layout that is what is wrong, when one part is", () => {
  const refusal = new NotAWorkspaceError({
    folder: "catalogs",
    because: "is there and is not a folder",
  });

  expect(refusal).toBeInstanceOf(WorkspaceRefusedError);
  expect(refusal.folder).toBe("catalogs");
  expect(refusal.message).toMatch(
    /^refusing to write: the Workspace layout does not exist yet — catalogs is there and is not a folder$/,
  );
});

/**
 * #311: the format of a revision, which `app` holds every adapter to. A SHA-256 as lowercase hex
 * and nothing near it: not the file's content, not a path, not upper case, not one digit short or
 * long, and not with a trailing newline, which an `m` flag or a missing `$` would let through.
 */
it("takes a SHA-256 as lowercase hex for a revision, and nothing else", () => {
  const hash = "0123456789abcdef".repeat(4);
  expect(isStateFileRevision(hash)).toBe(true);

  for (const notOne of [
    '{"schemaVersion":1,"pins":[]}',
    "/home/student/plans/alice.state.json",
    hash.toUpperCase(),
    hash.slice(1),
    hash + "0",
    hash + "\n",
    "\n" + hash,
    `${hash.slice(0, 32)}\n${hash.slice(32)}`,
    hash.replace("a", "g"),
    "",
    undefined,
    null,
    42,
    { toString: () => hash },
  ]) {
    expect(isStateFileRevision(notOne), JSON.stringify(notOne)).toBe(false);
  }
});

/**
 * #243: what `ready` means, pinned at the port rather than only where a disk can reach it. A part
 * of the Workspace Layout that is there and is not a folder makes a Workspace not ready exactly as
 * a missing one does, and is reported apart from the missing ones, because `create` makes what is
 * missing and cannot make a folder whose name a file holds. The in-memory double can never hold
 * such a part, so this is the only place its half of the promise is asserted.
 */
it("is not ready while a part of the Workspace Layout is missing or is there and not a folder", () => {
  expect(statusOf({ missing: [], notAFolder: [] })).toEqual({ ready: true, missing: [] });
  expect(statusOf({ missing: ["backups"], notAFolder: [] })).toEqual({
    ready: false,
    missing: ["backups"],
  });
  expect(statusOf({ missing: [], notAFolder: ["catalogs"] })).toEqual({
    ready: false,
    missing: [],
    notAFolder: ["catalogs"],
  });
  expect(statusOf({ missing: ["requirements"], notAFolder: ["catalogs"] })).toEqual({
    ready: false,
    missing: ["requirements"],
    notAFolder: ["catalogs"],
  });
  // left out rather than empty, so every other Workspace's answer is the one it always was
  expect(statusOf({ missing: [], notAFolder: [] })).not.toHaveProperty("notAFolder");
});

/**
 * The retention rule, tested here rather than only through the two adapters, for the reason the
 * name rule is: **this is the part of the app that deletes a student's data.** A clause no
 * adapter test happens to reach is a clause that can be relaxed without anything failing, and
 * the cost of relaxing this one is a snapshot somebody wanted, gone, with no Warning attached
 * — the guarantee that every domain check is a Warning and the edit goes through does not help
 * here, because deletion is not a check (#67).
 *
 * The rule is one pure function shared by both adapters, so these cases bind both.
 */

const DAY = 86_400_000;
/** A Wednesday at noon UTC, so nothing here sits on a day boundary by accident. */
const NOON = Date.UTC(2026, 9, 7, 12, 0, 0, 0);

const snapshotsAt = (...moments: number[]): BackupRef[] =>
  moments.map((takenAt) => ({ kind: "backup", name: "alice", takenAt }));

const prunedFrom = (snapshots: BackupRef[], now: number): number[] =>
  backupsToPrune(snapshots, now)
    .map((snapshot) => snapshot.takenAt)
    .sort((a, b) => a - b);

const keptFrom = (snapshots: BackupRef[], now: number): number[] => {
  const going = new Set(backupsToPrune(snapshots, now).map((snapshot) => snapshot.takenAt));
  return snapshots
    .map((snapshot) => snapshot.takenAt)
    .filter((takenAt) => !going.has(takenAt))
    .sort((a, b) => a - b);
};

it("keeps everything while there is little, and the design's two numbers are the design's", () => {
  expect(BACKUP_KEEP_SAVES).toBe(20);
  expect(BACKUP_KEEP_DAYS).toBe(30);

  expect(backupsToPrune([], NOON)).toEqual([]);
  expect(prunedFrom(snapshotsAt(NOON - 1000, NOON - 500, NOON), NOON)).toEqual([]);
});

/**
 * The afternoon case, the first of the three #67 names. 200 saves in one day: the count rule
 * keeps the last 20 and the daily rule keeps that day's newest, which is already among them —
 * so exactly 20 survive, and the 180 before them go.
 */
it("keeps the last 20 of 200 saves in one afternoon, and nothing older of that day", () => {
  // a minute apart, so all 200 fall inside one UTC day
  const moments = Array.from({ length: 200 }, (_, index) => NOON - (199 - index) * 60_000);

  const kept = keptFrom(snapshotsAt(...moments), NOON);

  expect(kept).toHaveLength(20);
  expect(kept).toEqual(moments.slice(-20));
});

/**
 * And the half of that case the ticket says the two rules have to settle between them: once
 * those 20 have aged out of the window, the day they were taken on must still have one.
 */
it("still keeps one snapshot of a busy day once its last 20 are no longer the last 20", () => {
  // 30 saves on one day five days ago, and 25 today. The count rule's last 20 are all
  // today's, so the busy day has aged out of it entirely — which is the moment the ticket
  // asks about, and the daily rule is the only thing left that could keep anything of it.
  const busy = Array.from({ length: 30 }, (_, index) => NOON - 5 * DAY + index * 60_000);
  const today = Array.from({ length: 25 }, (_, index) => NOON - (24 - index) * 60_000);

  const kept = keptFrom(snapshotsAt(...busy, ...today), NOON);

  // none of the busy day is among the last 20 any more
  expect(busy.filter((takenAt) => today.includes(takenAt))).toEqual([]);
  // and it keeps its newest and only its newest
  const ofBusyDay = kept.filter((takenAt) => backupDay(takenAt) === backupDay(busy[0] as number));
  expect(ofBusyDay).toEqual([busy[busy.length - 1]]);
});

/**
 * The once-a-month case, the second of the three. Age alone never deletes anything: a save from
 * months ago is kept because it is among the last 20, and the 30-day window not wanting it is
 * not a reason to take it away.
 */
it("keeps a save from months ago because it is among the last 20, not despite its age", () => {
  // one a month for a year, so every one of them is far outside the 30-day window
  const monthly = Array.from({ length: 12 }, (_, index) => NOON - (11 - index) * 30 * DAY);

  expect(prunedFrom(snapshotsAt(...monthly), NOON)).toEqual([]);
  expect(keptFrom(snapshotsAt(...monthly), NOON)).toEqual([...monthly].sort((a, b) => a - b));
});

/**
 * The gap case, the third. The window is walked over the snapshots that exist rather than over
 * 30 calendar days, so a day with nothing saved is simply a day with nothing to keep — and
 * never a reason to hold on to something older to fill it.
 */
it("tolerates a day with no saves rather than keeping something older to fill it", () => {
  // 25 days apart: the older one is outside the window, the newer inside, and every day
  // between them is empty. The count rule keeps both, so the age rule is asked on its own by
  // adding 20 newer saves.
  const old = NOON - 45 * DAY;
  const recent = NOON - 20 * DAY;
  const since = Array.from({ length: 20 }, (_, index) => NOON - 19 * DAY + index * DAY);

  const kept = keptFrom(snapshotsAt(old, recent, ...since), NOON);

  // `old` is past the window and out of the last 20, so it goes; `recent` is inside the
  // window and stays, although there are 24 empty days between the two
  expect(kept).not.toContain(old);
  expect(kept).toContain(recent);
});

/** One per day, and the one kept is that day's last word rather than its first. */
it("keeps the newest snapshot of each day inside the window", () => {
  const dayBefore = [NOON - DAY - 3600_000, NOON - DAY - 60_000, NOON - DAY];
  // 20 newer saves, all on one day, so the count rule has no opinion about the day before
  const today = Array.from({ length: 20 }, (_, index) => NOON - (19 - index) * 1000);

  const kept = keptFrom(snapshotsAt(...dayBefore, ...today), NOON);

  expect(kept.filter((takenAt) => backupDay(takenAt) === backupDay(NOON - DAY))).toEqual([
    dayBefore[2],
  ]);
});

/** The window's edge, asserted rather than assumed: 29 days back is in and 30 is out. */
it("holds the window at 30 days, counted in whole UTC days", () => {
  const atEdge = (daysAgo: number): number[] => {
    const older = NOON - daysAgo * DAY;
    const since = Array.from({ length: BACKUP_KEEP_SAVES }, (_, index) => NOON - index * 1000);
    return keptFrom(snapshotsAt(older, ...since), NOON);
  };

  expect(atEdge(29)).toContain(NOON - 29 * DAY);
  expect(atEdge(30)).not.toContain(NOON - 30 * DAY);

  // and the day number is the UTC one, so two moments either side of local midnight anywhere
  // are the same day or not by the same arithmetic on both adapters
  expect(backupDay(Date.UTC(2026, 9, 7, 0, 0, 0, 0))).toBe(backupDay(Date.UTC(2026, 9, 7, 23, 59, 59, 999)));
  expect(backupDay(Date.UTC(2026, 9, 8, 0, 0, 0, 0))).toBe(backupDay(NOON) + 1);
});

/**
 * A clock that has gone backwards — a laptop waking with a bad time, a sync client stamping
 * ahead — is not a reason to delete anything. The window is the last 30 days *and everything
 * after now*, so a snapshot dated in the future is that day's keeper rather than an outlier.
 */
it("keeps a snapshot dated in the future rather than treating a bad clock as a reason", () => {
  const ahead = NOON + 5 * DAY;
  const since = Array.from({ length: BACKUP_KEEP_SAVES }, (_, index) => NOON - index * 1000);

  expect(keptFrom(snapshotsAt(ahead, ...since), NOON)).toContain(ahead);
});

/**
 * The property the ticket states as its own criterion, asserted as a property rather than
 * case by case: **nothing either rule would keep is ever pruned.** Checked against an
 * independent reading of the two halves, written out here rather than reusing the function
 * under test, over a spread that makes both halves bite.
 */
it("never prunes a snapshot that either rule would keep", () => {
  const moments: number[] = [];
  for (let day = 0; day < 60; day++) {
    // a couple of saves on most days, several on a few, and nothing at all on every seventh
    if (day % 7 === 3) continue;
    const saves = day % 11 === 0 ? 6 : 2;
    for (let index = 0; index < saves; index++) {
      moments.push(NOON - day * DAY + index * 90_000);
    }
  }

  const snapshots = snapshotsAt(...moments);
  const going = new Set(backupsToPrune(snapshots, NOON).map((snapshot) => snapshot.takenAt));

  const newestFirst = [...moments].sort((a, b) => b - a);
  const byCount = new Set(newestFirst.slice(0, BACKUP_KEEP_SAVES));
  const byDay = new Set<number>();
  const daysSeen = new Set<number>();
  for (const takenAt of newestFirst) {
    const day = backupDay(takenAt);
    if (backupDay(NOON) - day >= BACKUP_KEEP_DAYS || daysSeen.has(day)) continue;
    daysSeen.add(day);
    byDay.add(takenAt);
  }

  for (const takenAt of [...byCount, ...byDay]) {
    expect(going.has(takenAt), `${takenAt} is kept by a rule and was pruned`).toBe(false);
  }
  // and the suite is not vacuous: this spread really does leave snapshots to delete
  expect(going.size).toBeGreaterThan(0);
  expect(going.size).toBe(moments.length - new Set([...byCount, ...byDay]).size);
});

/** The answer is newest first, which is the function's own order and not the input's. */
it("answers in newest-first order whatever order it was handed", () => {
  const moments = Array.from({ length: 25 }, (_, index) => NOON - index * DAY * 2);
  const going = backupsToPrune(snapshotsAt(...moments.slice().reverse()), NOON);

  expect(going.map((snapshot) => snapshot.takenAt)).toEqual(
    [...going.map((snapshot) => snapshot.takenAt)].sort((a, b) => b - a),
  );
  expect(going.length).toBeGreaterThan(0);
});

/**
 * A snapshot's reference, which carries both kinds of key the port has learned to distrust: a
 * name, and a number an adapter turns straight into a file name. `requireCatalogRef`'s doc is
 * the argument — "the rule should not depend on being remembered" — and this is it applied to
 * the third ref.
 */
it("refuses a snapshot whose name is a path, or whose moment is not a whole number", () => {
  expect(() => requireBackupRef({ kind: "backup", name: "alice", takenAt: NOON })).not.toThrow();
  // zero and a pre-epoch moment are whole numbers and are accepted: a clock is allowed to be
  // wrong, and `backupsToPrune` is where that is dealt with
  expect(() => requireBackupRef({ kind: "backup", name: "alice", takenAt: 0 })).not.toThrow();
  expect(() => requireBackupRef({ kind: "backup", name: "alice", takenAt: -1 })).not.toThrow();

  for (const name of ["../alice", "a/b", ".hidden", "", "NUL"]) {
    expect(() => requireBackupRef({ kind: "backup", name, takenAt: NOON }), name).toThrow(
      WorkspaceRefusedError,
    );
  }
  for (const takenAt of [1.5, Number.NaN, Infinity, -Infinity, 2 ** 53]) {
    expect(() => requireBackupRef({ kind: "backup", name: "alice", takenAt }), `${takenAt}`)
      .toThrow(/a moment is a whole number of milliseconds, never a path/);
  }
});

/**
 * The count rule is "the last 20 **of this file**", so a list holding two names has one
 * allowance to share and would delete the whole of the quieter file's history. Guarded rather
 * than documented, because this is the function whose mistake deletes a student's data.
 */
it("refuses to prune the snapshots of more than one State File at once", () => {
  const mixed: BackupRef[] = [
    ...Array.from({ length: 30 }, (_, index) => ({
      kind: "backup" as const,
      name: "alice",
      takenAt: NOON - index * 1000,
    })),
    ...Array.from({ length: 30 }, (_, index) => ({
      kind: "backup" as const,
      name: "bob",
      takenAt: NOON - index * 1000,
    })),
  ];

  expect(() => backupsToPrune(mixed, NOON)).toThrow(WorkspaceRefusedError);
  expect(() => backupsToPrune(mixed, NOON)).toThrow(/"alice", "bob"/);
  // and one name is fine however many of them there are
  expect(backupsToPrune(mixed.slice(0, 30), NOON)).toHaveLength(10);
});

/**
 * A moment identifies a snapshot, so a list holding one of them twice is read as one file: 20
 * moments are still kept, and the duplicate is not counted twice nor named twice in the answer.
 */
it("reads two references to one moment as one snapshot", () => {
  const one: BackupRef = { kind: "backup", name: "alice", takenAt: NOON };
  const rest = Array.from({ length: 31 }, (_, index) => ({
    kind: "backup" as const,
    name: "alice",
    takenAt: NOON - (index + 1) * 1000,
  }));
  const held = [one, one, ...rest];

  const going = backupsToPrune(held, NOON);
  const goingMoments = going.map((snapshot) => snapshot.takenAt);

  // 32 distinct moments, 20 kept, so 12 go — and each named once
  expect(new Set(goingMoments).size).toBe(goingMoments.length);
  expect(goingMoments).toHaveLength(12);
  expect(goingMoments).not.toContain(NOON);
  // which leaves exactly the count rule's 20 distinct moments standing
  const keptMoments = new Set(held.map((snapshot) => snapshot.takenAt));
  for (const moment of goingMoments) keptMoments.delete(moment);
  expect(keptMoments.size).toBe(BACKUP_KEEP_SAVES);
});

/**
 * #249: the refusals this port makes itself, shared by both adapters, each say which one they are
 * as a reason code and a subject — the only part of a refusal `app` reads. The message is the
 * adapter's account for a log, and is pinned by the tests above.
 */
it("says which refusal each shared one is, as a reason and a subject", () => {
  const refusalOf = (refuse: () => unknown): WorkspaceRefusal | undefined => {
    try {
      refuse();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceRefusedError);
      return (error as WorkspaceRefusedError).refusal;
    }
    return undefined;
  };

  expect(refusalOf(() => requireStateFileName("../bob"))).toEqual({
    reason: "not-a-name",
    subject: { kind: "state", name: "../bob" },
  });
  const unstamped = { kind: "backup", name: "alice", takenAt: 1.5 } as const;
  expect(refusalOf(() => requireBackupRef(unstamped))).toEqual({
    reason: "not-a-moment",
    subject: unstamped,
  });
  const pathAsYear = { kind: "catalog", academicYear: "../alice.state" } as never;
  expect(refusalOf(() => requireCatalogRef(pathAsYear))).toEqual({
    reason: "not-a-year",
    subject: pathAsYear,
  });
  expect(refusalOf(() => requireCatalogRef({ kind: "state", name: "alice" }))).toEqual({
    reason: "not-a-catalog",
    subject: { kind: "state", name: "alice" },
  });
  expect(
    refusalOf(() =>
      backupsToPrune(
        [
          { kind: "backup", name: "alice", takenAt: 0 },
          { kind: "backup", name: "bob", takenAt: 0 },
        ],
        0,
      ),
    ),
  ).toEqual({ reason: "mixed-snapshots", subject: { kind: "folder", folder: "backups" } });

  expect(new NotAWorkspaceError().refusal).toEqual({
    reason: "not-a-workspace",
    subject: { kind: "workspace" },
  });
  expect(new NotAWorkspaceError({ folder: "catalogs", because: "is a file" }).refusal).toEqual({
    reason: "not-a-workspace",
    subject: { kind: "folder", folder: "catalogs" },
  });

  // a snapshot's refusal keeps the refusal it wraps, so the page still learns which folder
  const inner = new NotAWorkspaceError({ folder: "backups", because: "is a file" });
  expect(new BackupRefusedError(inner).refusal).toBe(inner.refusal);
});
