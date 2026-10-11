import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_KEEP_SAVES,
  isStateFileRevision,
  NotAWorkspaceError,
  StateFileChangedError,
  WorkspaceRefusedError,
  type Workspace,
} from "./workspace.ts";

/**
 * The Workspace port's interface as one suite, which both adapters run (#384): `memoryWorkspace`
 * from `./workspace.memory.test.ts` and `fileSystemWorkspace` from
 * `server/src/workspace.fs.test.ts`, through the package subpath
 * `@biu-cs-planner/app/workspace-contract`. Twenty `app` test files run on the in-memory adapter,
 * so a use case's tests are only as true as its agreement with the disk, and #311 and #326 were
 * both the two answering a revision differently.
 *
 * **Only what the port's own methods can stage is here.** A revision that moved is two saves, not
 * an edit on disk. What needs a hand from outside — a file removed behind the adapter's back, a
 * BOM, content that is not JSON, a symlink, two Workspaces over one folder, a mode bit — stays in
 * that adapter's own tests.
 *
 * Kept out of `./index.ts` on purpose, so nothing that bundles `app` reaches `vitest`.
 */

/** A Workspace for one test, and how to put away whatever it stands on. */
export type ContractWorkspace = {
  workspace: Workspace;
  cleanup?: () => Promise<void> | void;
};

/**
 * Makes a fresh Workspace: with the Workspace Layout already there when `created`, and stamping
 * snapshots with `now`.
 */
export type MakeContractWorkspace = (options: {
  created: boolean;
  now: () => number;
}) => Promise<ContractWorkspace> | ContractWorkspace;

const CATALOG = { schemaVersion: 1, academicYear: 2027, sources: [], offerings: [] };
const STATE = {
  schemaVersion: 1,
  attempts: [],
  timetables: [],
  pins: [],
  settings: { language: "en", examSpacingDays: 3 },
};
const REQUIREMENTS = { schemaVersion: 1, program: { id: "cs", name: { he: "מדעי המחשב" } } };

const ALICE = { kind: "state", name: "alice" } as const;
const BOB = { kind: "state", name: "bob" } as const;
const NOON = Date.UTC(2026, 9, 7, 12, 0, 0, 0);

/** A save based on no file, which is the claim that the file is not there yet. */
const firstSave = (data: unknown) => ({ json: data as Record<string, unknown>, basedOn: undefined });

/** A clock a test drives, so a day apart costs no waiting. */
const clock = (start: number) => {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
};

/**
 * `read` and `write` take a `CatalogRef`, and that narrowing is type-only (#113): the cast a
 * future caller would reach the whole-file routes through, written out.
 */
const wholeFileRead = (workspace: Workspace) =>
  workspace.read as unknown as (ref: unknown) => Promise<unknown>;
const wholeFileWrite = (workspace: Workspace) =>
  workspace.write as unknown as (ref: unknown, data: unknown) => Promise<void>;

/** Polls a condition rather than trusting a delay: a disk's watcher calls back when it will. */
async function within(condition: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  return condition();
}

export function workspaceContract(label: string, make: MakeContractWorkspace): void {
  describe(label, () => {
    let cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
      for (const cleanup of cleanups) await cleanup();
      cleanups = [];
    });

    const open = async (
      options: { created?: boolean; now?: () => number } = {},
    ): Promise<Workspace> => {
      const made = await make({ created: options.created ?? true, now: options.now ?? Date.now });
      if (made.cleanup !== undefined) cleanups.push(made.cleanup);
      return made.workspace;
    };

    describe("the Workspace Layout", () => {
      it("reports an ordinary folder as not a Workspace, and creates the Layout when asked", async () => {
        const workspace = await open({ created: false });

        expect(await workspace.status()).toEqual({
          ready: false,
          missing: ["catalogs", "requirements", "backups"],
        });
        // left out, not empty, while no part is the wrong kind of thing (#243)
        expect(await workspace.status()).not.toHaveProperty("notAFolder");

        await workspace.create();

        expect(await workspace.status()).toEqual({ ready: true, missing: [] });
        expect(await workspace.status()).not.toHaveProperty("notAFolder");
      });

      /**
       * `NotAWorkspaceError` from the port, and both writes, so the wording a student reads cannot
       * drift between adapters (#121). Nothing is written into a folder the student has not agreed
       * to make a Workspace (docs/design.md, "Storage").
       */
      it("refuses a write before the Workspace Layout exists", async () => {
        const workspace = await open({ created: false });

        await expect(workspace.saveStateFile(ALICE, firstSave(STATE))).rejects.toThrow(
          NotAWorkspaceError,
        );
        await expect(workspace.saveStateFile(ALICE, firstSave(STATE))).rejects.toThrow(
          /layout does not exist/,
        );
        await expect(
          workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG),
        ).rejects.toThrow(NotAWorkspaceError);
        // the type every caller of this port already catches, so the refusal is a named answer
        // and never a crashed server (docs/design.md, "API and data rules")
        await expect(
          workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG),
        ).rejects.toThrow(WorkspaceRefusedError);

        // and it made nothing on the way to refusing
        expect(await workspace.status()).toEqual({
          ready: false,
          missing: ["catalogs", "requirements", "backups"],
        });
        expect(await workspace.list("state")).toEqual([]);
      });

      it("refuses a Requirements File write before the Workspace Layout exists", async () => {
        const workspace = await open({ created: false });

        await expect(
          workspace.write({ kind: "requirements", name: "cs-2027" }, REQUIREMENTS),
        ).rejects.toThrow(NotAWorkspaceError);
      });

      it("reads nothing, rather than throwing, before the Workspace Layout exists", async () => {
        const workspace = await open({ created: false });

        // the port promises absence is not an error, and a query must not become a 500
        await expect(
          workspace.read({ kind: "catalog", academicYear: 2027 }),
        ).resolves.toBeUndefined();
        await expect(workspace.readStateFile(ALICE)).resolves.toBeUndefined();
      });
    });

    describe("listing", () => {
      it("lists what it holds, by kind, and keeps the kinds apart", async () => {
        const workspace = await open();

        await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);
        await workspace.write({ kind: "catalog", academicYear: 2026 }, { ...CATALOG, academicYear: 2026 });
        await workspace.saveStateFile(BOB, firstSave(STATE));
        await workspace.saveStateFile(ALICE, firstSave(STATE));

        expect(await workspace.list("catalog")).toEqual([
          { kind: "catalog", academicYear: 2026 },
          { kind: "catalog", academicYear: 2027 },
        ]);
        expect(await workspace.list("state")).toEqual([ALICE, BOB]);
        expect(await workspace.list("requirements")).toEqual([]);
      });

      /**
       * Empty is the answer for a folder that is not there, and no adapter may have grown a refusal
       * where another reports absence: a use-case test that met one would be failing for a
       * Workspace that is merely not set up yet (#129).
       */
      it("lists nothing, and never refuses, for a Workspace holding nothing of that kind", async () => {
        const fresh = await open({ created: false });
        await expect(fresh.list("catalog")).resolves.toEqual([]);
        await expect(fresh.list("state")).resolves.toEqual([]);

        const workspace = await open();
        await expect(workspace.list("catalog")).resolves.toEqual([]);
        await expect(workspace.list("state")).resolves.toEqual([]);

        // and one kind being there is not the other kind refusing
        await workspace.saveStateFile(ALICE, firstSave(STATE));
        await expect(workspace.list("catalog")).resolves.toEqual([]);
        await expect(workspace.list("state")).resolves.toEqual([ALICE]);
      });

      it("lists no Requirements Files, and never refuses, for a Workspace holding none", async () => {
        await expect((await open({ created: false })).list("requirements")).resolves.toEqual([]);
        await expect((await open()).list("requirements")).resolves.toEqual([]);
      });
    });

    describe("Catalogs and Requirements Files, read and written whole", () => {
      it("stores a Catalog and reads it back", async () => {
        const workspace = await open();

        await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);

        expect(await workspace.read({ kind: "catalog", academicYear: 2027 })).toEqual(CATALOG);
      });

      it("returns nothing for a year with no Catalog, rather than throwing", async () => {
        const workspace = await open();

        expect(await workspace.read({ kind: "catalog", academicYear: 2030 })).toBeUndefined();
      });

      /**
       * A file holds JSON, whoever the adapter is: a value JSON cannot express is refused before
       * it touches what was there, so a use case cannot pass on one adapter by writing a value
       * the other would refuse.
       */
      it("refuses a value JSON cannot express, and keeps what was there", async () => {
        const workspace = await open();
        await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);

        await expect(
          workspace.write({ kind: "catalog", academicYear: 2027 }, { schemaVersion: 1n }),
        ).rejects.toThrow();
        await expect(
          workspace.saveStateFile(ALICE, firstSave({ schemaVersion: 1n })),
        ).rejects.toThrow();

        expect(await workspace.read({ kind: "catalog", academicYear: 2027 })).toEqual(CATALOG);
        expect(await workspace.readStateFile(ALICE)).toBeUndefined();
      });

      it("lists, reads and writes Requirements Files apart from the other kinds", async () => {
        const workspace = await open();

        await workspace.write({ kind: "requirements", name: "math-2027" }, REQUIREMENTS);
        await workspace.write({ kind: "requirements", name: "cs-2027" }, REQUIREMENTS);
        await workspace.write({ kind: "catalog", academicYear: 2027 }, CATALOG);

        expect(await workspace.list("requirements")).toEqual([
          { kind: "requirements", name: "cs-2027" },
          { kind: "requirements", name: "math-2027" },
        ]);
        expect(await workspace.list("catalog")).toEqual([{ kind: "catalog", academicYear: 2027 }]);
        expect(await workspace.read({ kind: "requirements", name: "math-2027" })).toEqual(
          REQUIREMENTS,
        );
        expect(await workspace.read({ kind: "requirements", name: "absent" })).toBeUndefined();
      });

      it("refuses a Requirements File whose name is a path, on a read and on a write", async () => {
        const workspace = await open();
        await workspace.saveStateFile(ALICE, firstSave(STATE));
        const hostile = { kind: "requirements", name: "../alice.state" } as const;

        await expect(workspace.write(hostile, REQUIREMENTS)).rejects.toThrow(WorkspaceRefusedError);
        await expect(workspace.read(hostile)).rejects.toThrow(/a name, never a path/);
        // the State File the path pointed at is untouched
        expect((await workspace.readStateFile(ALICE))?.data).toEqual(STATE);
      });

      /**
       * #113: a `CatalogRef` is narrowed by kind only and its year becomes a file name, so a cast
       * year of `"../alice.state"` would point back out of the Catalogs and onto a State File.
       * The rule belongs to the port, not to the adapter that has a filesystem to lose.
       */
      it("refuses a Catalog whose year is a path rather than a year, cast past the type", async () => {
        const workspace = await open();
        await workspace.saveStateFile(ALICE, firstSave(STATE));
        const pathAsYear = { kind: "catalog", academicYear: "../alice.state" };

        await expect(wholeFileWrite(workspace)(pathAsYear, { schemaVersion: 1 })).rejects.toThrow(
          /a year is a whole number/,
        );
        await expect(wholeFileRead(workspace)(pathAsYear)).rejects.toThrow(WorkspaceRefusedError);

        // the State File the crafted year resolved to is untouched
        expect((await workspace.readStateFile(ALICE))?.data).toEqual(STATE);
        expect(await workspace.list("catalog")).toEqual([]);
      });
    });

    describe("State Files never go through the whole-file routes", () => {
      /** #113, through the one function in the port, so both adapters say it in the same words. */
      it("refuses a whole-file write of a State File, cast past the narrowing", async () => {
        const workspace = await open();
        await workspace.saveStateFile(ALICE, firstSave(STATE));

        await expect(wholeFileWrite(workspace)(ALICE, { schemaVersion: 2 })).rejects.toThrow(
          WorkspaceRefusedError,
        );
        await expect(wholeFileWrite(workspace)(ALICE, { schemaVersion: 2 })).rejects.toThrow(
          /refusing the State File "alice" here/,
        );

        // the guarded save is the only way in, and what it wrote is still there
        expect((await workspace.readStateFile(ALICE))?.data).toEqual(STATE);
      });

      /**
       * Refused because of the ref and not because of the folder: an answer about the Workspace
       * Layout would send a caller looking at the wrong thing.
       */
      it("refuses a cast whole-file write of a State File before it looks at the Layout", async () => {
        const workspace = await open({ created: false });

        await expect(wholeFileWrite(workspace)(ALICE, STATE)).rejects.toThrow(
          /refusing the State File "alice" here/,
        );
        expect(await workspace.list("state")).toEqual([]);
      });

      /** Content with no revision is content nothing can safely save afterwards. */
      it("refuses a whole-file read of a State File, which would come back with no revision", async () => {
        const workspace = await open();
        await workspace.saveStateFile(ALICE, firstSave(STATE));

        await expect(wholeFileRead(workspace)(ALICE)).rejects.toThrow(WorkspaceRefusedError);
        await expect(wholeFileRead(workspace)(ALICE)).rejects.toThrow(
          /refusing the State File "alice" here/,
        );
      });
    });

    describe("State Files and their revisions", () => {
      it("reports a State File that is not there as absent rather than failing", async () => {
        const workspace = await open();

        expect(await workspace.readStateFile({ kind: "state", name: "nobody" })).toBeUndefined();
      });

      /**
       * The first ref that carries free text rather than a number, so this is where a path could
       * be smuggled in. A name is a name (ADR-0003).
       */
      it("refuses a State File whose name is a path rather than a name", async () => {
        const workspace = await open();

        for (const name of ["../escaped", "sub/alice", "alice/../../escaped", "", ".hidden", ".."]) {
          await expect(workspace.readStateFile({ kind: "state", name })).rejects.toThrow(
            WorkspaceRefusedError,
          );
          await expect(
            workspace.saveStateFile({ kind: "state", name }, firstSave(STATE)),
          ).rejects.toThrow(WorkspaceRefusedError);
        }
        expect(await workspace.list("state")).toEqual([]);
      });

      /** #311: `app` refuses a revision that is not in the format the port states. */
      it("hands back every revision as a well-formed hash, on a read and on a save", async () => {
        const workspace = await open();

        const wrote = await workspace.saveStateFile(ALICE, firstSave(STATE));
        const read = await workspace.readStateFile(ALICE);
        const again = await workspace.saveStateFile(ALICE, { json: { ...STATE }, basedOn: wrote });

        for (const revision of [wrote, read?.version, again]) {
          expect(isStateFileRevision(revision), String(revision)).toBe(true);
        }
        // the save's answer is the revision a read of what it wrote gives
        expect(read?.version).toBe(wrote);
      });

      /** The external-edit guard (#90): a revision is handed out with the file and taken back. */
      it("hands a revision back with a State File, and takes it back on the save", async () => {
        const workspace = await open();

        const written = await workspace.saveStateFile(ALICE, firstSave(STATE));

        const held = await workspace.readStateFile(ALICE);
        expect(held?.data).toEqual(STATE);
        // a page saving twice in a row needs no read in between
        expect(held?.version).toBe(written);
        const next = { schemaVersion: 1, pins: [] };
        const saved = await workspace.saveStateFile(ALICE, { json: next, basedOn: held?.version });
        expect((await workspace.readStateFile(ALICE))?.version).toBe(saved);
        expect((await workspace.readStateFile(ALICE))?.data).toEqual(next);
      });

      it("hands back a copy, so what was written cannot change afterwards", async () => {
        const workspace = await open();
        const state = { schemaVersion: 1, pins: [] as string[] };

        await workspace.saveStateFile(ALICE, firstSave(state));
        state.pins.push("added after the save");

        expect((await workspace.readStateFile(ALICE))?.data).toEqual({ schemaVersion: 1, pins: [] });
      });

      /**
       * The revision moved under a save, staged as two saves: the second writer is the other tab,
       * Dropbox, git or an editor, and the port cannot tell which.
       */
      it("refuses a save based on a revision the file no longer holds", async () => {
        const workspace = await open();
        const stale = await workspace.saveStateFile(ALICE, firstSave(STATE));
        const fromElsewhere = { schemaVersion: 1, pins: ["from elsewhere"] };
        await workspace.saveStateFile(ALICE, { json: fromElsewhere, basedOn: stale });

        const refused = workspace.saveStateFile(ALICE, { json: { schemaVersion: 1 }, basedOn: stale });

        await expect(refused).rejects.toThrow(StateFileChangedError);
        // a refusal costs the other writer nothing: their file is there, whole
        expect((await workspace.readStateFile(ALICE))?.data).toEqual(fromElsewhere);
      });

      /**
       * `basedOn: undefined` is the claim that there is no file, so it is guarded like any other
       * revision rather than being the one argument that skips the guard (#80).
       */
      it("refuses a save based on no file when a file is already there", async () => {
        const workspace = await open();
        await workspace.saveStateFile(ALICE, firstSave(STATE));

        await expect(workspace.saveStateFile(ALICE, firstSave({ schemaVersion: 1 }))).rejects.toThrow(
          StateFileChangedError,
        );
        expect((await workspace.readStateFile(ALICE))?.data).toEqual(STATE);
      });

      /**
       * A conflict is not a target the Workspace will not touch. The two ask the student for
       * different things — reload, or fix a file name — so a caller must be able to tell them apart.
       */
      it("makes a conflict distinguishable from a refusal about the target itself", async () => {
        const workspace = await open();
        await workspace.saveStateFile(ALICE, firstSave(STATE));

        const error = await workspace
          .saveStateFile(ALICE, firstSave({ schemaVersion: 1 }))
          .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(StateFileChangedError);
        expect(error).not.toBeInstanceOf(WorkspaceRefusedError);
        expect((error as StateFileChangedError).basedOn).toBeUndefined();
        expect(isStateFileRevision((error as StateFileChangedError).found)).toBe(true);
      });

      /**
       * The property a content revision buys: a writer that put back the same content changed
       * nothing, so nothing is refused. `git checkout` of an unchanged file is this case, and it
       * is where an mtime would have misfired. Staged as two saves of the same document.
       */
      it("does not refuse a save when the file was rewritten with identical content", async () => {
        const workspace = await open();
        const version = await workspace.saveStateFile(ALICE, firstSave(STATE));

        const rewritten = await workspace.saveStateFile(ALICE, {
          json: { ...STATE },
          basedOn: version,
        });

        expect(rewritten).toBe(version);
        await expect(
          workspace.saveStateFile(ALICE, { json: { schemaVersion: 1 }, basedOn: version }),
        ).resolves.toEqual(expect.any(String));
      });
    });

    /**
     * `.backups/` (#67). The retention rule is one pure function both adapters call, tested in
     * `./workspace.test.ts`; these assert that a save really calls it.
     */
    describe("snapshots", () => {
      it("takes a snapshot of the State File a save replaces, and none on a first save", async () => {
        const time = clock(NOON);
        const workspace = await open({ now: time.now });

        const first = await workspace.saveStateFile(ALICE, firstSave(STATE));
        // nothing was replaced, so there is nothing to have copied
        expect(await workspace.listBackups(ALICE)).toEqual([]);

        time.advance(1000);
        const takenAt = time.now();
        await workspace.saveStateFile(ALICE, { json: { schemaVersion: 1, pins: [] }, basedOn: first });

        expect(await workspace.listBackups(ALICE)).toEqual([{ kind: "backup", name: "alice", takenAt }]);
        // and it holds what the file held before the save, not what it holds now
        expect(await workspace.readBackup({ kind: "backup", name: "alice", takenAt })).toEqual(STATE);
      });

      it("lists the snapshots of one State File newest first, and none of another's", async () => {
        const time = clock(NOON);
        const workspace = await open({ now: time.now });

        let version = await workspace.saveStateFile(ALICE, firstSave(STATE));
        const moments: number[] = [];
        for (let save = 0; save < 3; save++) {
          time.advance(1000);
          moments.push(time.now());
          version = await workspace.saveStateFile(ALICE, { json: { schemaVersion: 1 }, basedOn: version });
        }
        const bobFirst = await workspace.saveStateFile(BOB, firstSave(STATE));
        time.advance(1000);
        await workspace.saveStateFile(BOB, { json: { schemaVersion: 1 }, basedOn: bobFirst });

        expect((await workspace.listBackups(ALICE)).map((held) => held.takenAt)).toEqual(
          [...moments].reverse(),
        );
        // retention is per State File, and so is a listing
        expect((await workspace.listBackups(BOB)).map((held) => held.name)).toEqual(["bob"]);
      });

      it("hands back nothing for a snapshot that is not there", async () => {
        const workspace = await open();

        expect(
          await workspace.readBackup({ kind: "backup", name: "alice", takenAt: 1 }),
        ).toBeUndefined();
      });

      it("prunes to the retention rule as a save lands", async () => {
        const time = clock(NOON);
        const workspace = await open({ now: time.now });

        let version = await workspace.saveStateFile(ALICE, firstSave(STATE));
        // 22 saves after the first, so 22 snapshots are taken and the count rule wants 20
        for (let save = 0; save < 22; save++) {
          time.advance(1000);
          version = await workspace.saveStateFile(ALICE, {
            json: { schemaVersion: 1, pins: [] },
            basedOn: version,
          });
        }

        const held = await workspace.listBackups(ALICE);
        expect(held).toHaveLength(BACKUP_KEEP_SAVES);
        expect(held[0]?.takenAt).toBe(time.now());
      });

      it("keeps two saves inside one millisecond as two snapshots", async () => {
        // a clock that never moves, which is the only way to stage this deliberately
        const workspace = await open({ now: () => NOON });

        const first = await workspace.saveStateFile(ALICE, firstSave(STATE));
        const second = await workspace.saveStateFile(ALICE, {
          json: { schemaVersion: 1, pins: [] },
          basedOn: first,
        });
        await workspace.saveStateFile(ALICE, { json: { schemaVersion: 1 }, basedOn: second });

        // two snapshots and not one silently replacing the other, a millisecond apart by the nudge
        expect((await workspace.listBackups(ALICE)).map((held) => held.takenAt)).toEqual([
          NOON + 1,
          NOON,
        ]);
      });

      it("lists nothing, and never refuses, for a Workspace with no snapshots", async () => {
        // before the Workspace Layout exists, which on a disk is the absent `.backups/`
        await expect((await open({ created: false })).listBackups(ALICE)).resolves.toEqual([]);
        await expect((await open()).listBackups(ALICE)).resolves.toEqual([]);
      });

      it("refuses a snapshot of a name that is not a name", async () => {
        const workspace = await open();

        await expect(workspace.listBackups({ kind: "state", name: "../alice" })).rejects.toThrow(
          WorkspaceRefusedError,
        );
        await expect(
          workspace.readBackup({ kind: "backup", name: "../alice", takenAt: 1 }),
        ).rejects.toThrow(WorkspaceRefusedError);
      });

      it("takes no snapshot when the save is refused", async () => {
        const workspace = await open({ now: () => NOON });
        await workspace.saveStateFile(ALICE, firstSave(STATE));

        // based on there being no file, when there is one: the guard's refusal
        await expect(workspace.saveStateFile(ALICE, firstSave({ schemaVersion: 1 }))).rejects.toThrow(
          StateFileChangedError,
        );

        expect(await workspace.listBackups(ALICE)).toEqual([]);
      });

      it("takes no snapshot into a folder that is not a Workspace", async () => {
        const workspace = await open({ created: false, now: () => NOON });

        await expect(workspace.saveStateFile(ALICE, firstSave(STATE))).rejects.toThrow(
          NotAWorkspaceError,
        );
        expect(await workspace.listBackups(ALICE)).toEqual([]);
      });

      /**
       * The save that takes a snapshot is reported, as every save is (#88). That the snapshot
       * itself moves no count is each adapter's own test: only the in-memory one can count its
       * events exactly, and only the disk has a `.backups/` a watcher could be opened on.
       */
      it("reports a save that takes a snapshot", async () => {
        const time = clock(NOON);
        const workspace = await open({ now: time.now });
        const first = await workspace.saveStateFile(ALICE, firstSave(STATE));

        let heard = 0;
        const watcher = await workspace.watch(() => void heard++);
        try {
          time.advance(1000);
          await workspace.saveStateFile(ALICE, {
            json: { schemaVersion: 1, pins: [] },
            basedOn: first,
          });

          expect(await within(() => heard > 0)).toBe(true);
          expect(await workspace.listBackups(ALICE)).toHaveLength(1);
        } finally {
          watcher.stop();
        }
      });
    });
  });
}
