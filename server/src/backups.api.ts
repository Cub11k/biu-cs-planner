import { Hono } from "hono";
import { listBackups, restoreBackup } from "@biu-cs-planner/app";
import { z } from "zod";
import { answer, basedOnSchema, bodyAs, capped, type RouteDependencies } from "./api.shared.ts";

/**
 * Which snapshot to put back, and the revision the restore is based on.
 *
 * **A moment and not a path** (ADR-0002; docs/design.md, "API and data rules", rule 1): a
 * snapshot is named by when it was taken, which is the only thing that tells two of one State
 * File's apart, and where it lives is the Workspace adapter's business. A safe integer and
 * nothing else, so there is nothing in it an adapter could resolve.
 *
 * `basedOn` is carried exactly as a Pick and an undo carry it, because a restore **is** a save:
 * it goes through the same wrapper and the same external-edit guard (ADR-0013, "the save path
 * is the undo path"). A client that leaves it out claims there is no State File, which fails
 * closed.
 */
const restoreSchema = z.object({
  takenAt: z.number().int().safe(),
  basedOn: basedOnSchema,
});

/** The backups routes: the snapshots of the State File, and putting one back. */
export function backupsRoutes({ workspace, into }: RouteDependencies) {
  return new Hono()
    /**
     * The snapshots of the student's State File, newest first — the listing behind "backups and
     * restore" on the Workspace screen (docs/design.md, "Screens").
     *
     * Each is one moment and nothing else, which is all that tells two apart and all a restore
     * needs: no file name, no path, no size (ADR-0002). No State File is named in the path
     * either, exactly as the history and settings routes name none.
     *
     * A refusal is the same named 409 every other Workspace route answers with, and it means
     * exactly one thing: `.backups/` is there and cannot be listed. It is **not** "the folder
     * is not a Workspace yet" — that is an empty list, which a test in `./api.test.ts` pins — and it is
     * never "no backups", which is an empty list too and a perfectly good answer. The one other
     * refusal is the same reason with `of: "state-file"`: the listing was fine and the State File's
     * bytes could not be got at, so there is no revision to restore over.
     *
     * `version` is the State File's revision, the one a restore is based on, and absent when there
     * is no State File (#412). Served for a State File that cannot be read too: a restore is how
     * that file is replaced, and its revision is a hash of its bytes like any other (ADR-0015).
     */
    .get("/api/backups", async (c) => {
      const result = await listBackups(workspace);
      if (result.kind === "refused") return c.json({ reason: result.reason, of: result.of }, 409);

      return c.json({ snapshots: result.snapshots, version: result.version });
    })

    /**
     * Puts one snapshot back into the State File.
     *
     * A POST and not a PUT: it is not idempotent in any useful sense, because the restore is
     * itself a save that takes its own snapshot of what it replaced, so restoring twice leaves
     * a different folder behind the second time.
     *
     * The Workspace screen calls it (#238), with a sentence of its own for every refusal: a page
     * that reused the Timetable's wording would be wrong about them, since `workspace-refused`
     * there is worded as Picks that could not be read.
     *
     * `into` is passed because a restore is undoable and because the stacks have to hear the
     * revision every save wrote (ADR-0013). `unchanged` is a 200 and not a refusal: restoring
     * the snapshot the file already holds is a request that was honoured and simply moved
     * nothing.
     */
    .post("/api/backups/restore", capped, async (c) => {
      const body = await bodyAs(c, restoreSchema, "not-a-restore");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const result = await restoreBackup(workspace, {
        takenAt: body.value.takenAt,
        basedOn: body.value.basedOn,
        history: into,
      });
      // `backup-not-found` among the reasons, and a 409 rather than a 404: the request is well
      // formed and conflicts with the state of the folder, which is what every other refusal out
      // of this port answers with. A stale listing is the ordinary way to get here, and the
      // page's answer to it is to list again — the same thing it does for `state-file-changed`.
      return answer(c, result, (restored) => ({
        kind: restored.kind,
        takenAt: restored.takenAt,
        version: restored.version,
        warnings: restored.warnings,
        // a restore over a file that could not be read has nothing to undo to (#412)
        replacedUnreadable: restored.kind === "restored" && restored.replacedUnreadable,
      }));
    });
}
