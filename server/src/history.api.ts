import { Hono, type Context } from "hono";
import { DEFAULT_STATE_FILE, readSettings, setSettings, type SettingsResult } from "@biu-cs-planner/app";
import { settingsSchema } from "@biu-cs-planner/core";
import { z } from "zod";
import { answer, basedOnSchema, bodyAs, capped, type RouteDependencies, type Served } from "./api.shared.ts";
import type { EditHistories, HistoryMove } from "./history.ts";

/**
 * A change to the student's preferences: the fields being set, and the revision the page that
 * sends it was based on.
 *
 * **Every field optional**, which is what makes this a PATCH rather than a PUT. A body carries
 * the preferences it means to change and says nothing about the others, so the one control that
 * exists today — the language switch — cannot reset the Exam spacing by not mentioning it. A
 * whole-object write from a page that knows about one preference would do exactly that, with
 * whatever value it happened to have read, or the schema's default if it had read none.
 *
 * Each field's *type* comes from `core`'s own `settingsSchema`, so a value this route accepts
 * cannot be one the State File would then reject. Each is named here rather than derived, and
 * `./api.test.ts` carries a canary that fails when `settingsSchema` gains a field, because the
 * alternative is a preference the file holds that no route can set.
 *
 * **`settingsSchema.partial()` is not what this is, and the difference is a bug.** `.partial()`
 * leaves each field's `.default()` in place, so a body naming only the language parses as that
 * language *and* the default Exam spacing — and this route would silently reset the preference it
 * was not asked about. Measured on zod 4.6.5: `settingsSchema.partial().parse({})` is
 * `{ language: "en", examSpacingDays: 3 }` (before #173 made that default `null`). Unwrapping the
 * default before making the field optional is what leaves an unmentioned field absent.
 *
 * A body naming no field at all is well formed and changes nothing, which the domain answers as
 * an unchanged save.
 */
export const savedSettingsSchema = z.object({
  // a choice and nothing else: `null` is the file saying nobody chose, and no control un-chooses (#173)
  language: settingsSchema.shape.language.unwrap().unwrap().optional(),
  examSpacingDays: settingsSchema.shape.examSpacingDays.unwrap().optional(),
  creditLoadLimit: settingsSchema.shape.creditLoadLimit.unwrap().optional(),
  basedOn: basedOnSchema,
});

/**
 * What an undo or a redo carries, which is the revision the page it was clicked on was
 * showing and nothing else.
 *
 * No year, no Semester, no Variant and no State File. Undo restores the document (ADR-0013),
 * so naming a part of it would be a promise this operation cannot keep — an undo of a Pick
 * made in one Semester is not scoped to the Semester the student happens to be looking at.
 */
const historyStepSchema = z.object({ basedOn: basedOnSchema });

/**
 * The settings answer, read or write, in one shape: the preferences as the file holds them, the
 * revision they were read from and their Warnings.
 */
function settingsFields(result: Served<SettingsResult>) {
  return { ...result.settings, version: result.version, warnings: result.warnings };
}

/**
 * The history and settings routes: undo and redo over `history`, the stacks `createApi` holds for
 * this server, and the student's preferences.
 */
export function historyRoutes({ workspace, into }: RouteDependencies, history: EditHistories) {
  /**
   * One step of undo or redo, answered the way a save is: 200 with what moved, or a named
   * 409. The two routes differ only in which direction they ask for, so they share this.
   */
  async function step(c: Context, move: (basedOn: string | undefined) => Promise<HistoryMove>) {
    const body = await bodyAs(c, historyStepSchema, "not-a-history-step");
    if (!body.ok) return c.json({ error: body.error }, 400);

    const moved = await move(body.value.basedOn);
    if (moved.kind === "refused") {
      // `nothing-to-undo` among the reasons, and a 409 is right for it too: the request is
      // well formed and conflicts with the state of the history. The availability travels
      // with every answer, so a UI that asked for an undo it did not have can correct its
      // buttons from the refusal rather than asking again.
      return c.json(
        {
          reason: moved.reason,
          canUndo: moved.canUndo,
          canRedo: moved.canRedo,
          warnings: moved.warnings,
        },
        409,
      );
    }

    return c.json({
      label: moved.label,
      at: moved.at,
      version: moved.version,
      canUndo: moved.canUndo,
      canRedo: moved.canRedo,
      warnings: moved.warnings,
    });
  }

  return new Hono()
    /**
     * Whether there is anything to undo or to redo, for the two buttons.
     *
     * A page asks after a reload, because the history outlives the page: the stacks belong to
     * the State File and live in this process, so a reloaded tab — or a second one — finds the
     * undo it never made still waiting (ADR-0013). Every undo and redo answer carries the same
     * two flags, so this is the first read and not a poll.
     *
     * Answered from memory and never from the disk, which is why `canUndo` can be true for an
     * undo that will then be refused as `history-invalidated`: a State File written from
     * outside is noticed when something reads it, and a read on every one of these would put a
     * disk touch behind a question the page asks on every reload. The student's first sign is
     * then a click that comes back named and harmless, rather than a button that is wrong in
     * the other direction — greyed out over a history that is perfectly good.
     */
    .get("/api/history", (c) => c.json(history.availability(DEFAULT_STATE_FILE)))

    /**
     * Undoes the last edit, and redoes the last undone one.
     *
     * Domain operations, and the paths say so: no file path, no State File name and no
     * Semester (ADR-0002, docs/design.md "API and data rules"). The answer says what moved,
     * so the UI can say it too, and whether either direction is still available.
     *
     * A POST and not a PUT: neither is idempotent — the second undo in a row undoes the edit
     * before, which is the point of a stack.
     *
     * Both carry the revision the page was showing, exactly as a save does, because an undo
     * *is* a save: it goes through the same wrapper and the same external-edit guard
     * (ADR-0013, "the save path is the undo path"). A client that leaves it out claims there
     * is no file, which fails closed the way a forgotten revision on a Pick does.
     */
    .post("/api/history/undo", capped, (c) =>
      step(c, (basedOn) => history.undo(DEFAULT_STATE_FILE, basedOn)),
    )

    .post("/api/history/redo", capped, (c) =>
      step(c, (basedOn) => history.redo(DEFAULT_STATE_FILE, basedOn)),
    )

    /**
     * The student's preferences: the language the UI is in, and the Exam spacing a Warning is
     * raised below (`docs/design.md`, "Workspace"; ADR-0014).
     *
     * Domain operations and no file path, as everywhere: no State File is named, exactly as the
     * history routes name none (ADR-0002). The Warnings travel with the answer and are the
     * reason this is not just the two values — `core/src/state/file.ts` reads the settings one
     * field at a time and raises `settings-unreadable` naming the field it could not read, and a
     * preference silently back at its default is the one a student cannot tell from a preference
     * they never set.
     *
     * `version` is the revision these settings were read from, and what a change made on them
     * has to be based on. Absent when there is no State File yet, which is the claim a first
     * save carries.
     */
    .get("/api/settings", async (c) => {
      return answer(c, await readSettings(workspace), settingsFields);
    })

    /**
     * Sets the preferences the body names, and answers with the settings as the file holds them
     * afterwards — the same shape the GET answers, so a page that can read one can read the
     * other.
     *
     * **A PATCH and not a PUT**, because the body is the fields being changed rather than the
     * whole of the settings; `savedSettingsSchema` carries the argument.
     *
     * A refusal is the same named 409 the Pick routes answer with, and `state-file-changed` is
     * among the reasons: writing a preference is writing the State File, so somebody else's edit
     * between the read the page was showing and this save refuses it rather than overwriting
     * their work (#90). Whatever offered the control owes the student an account of that.
     *
     * `into` is passed for the same reason a Pick passes it, and **not** so that a preference can
     * be undone — ADR-0013 keeps settings off the stack and `app/src/edit.ts` enforces that
     * structurally. It is passed because the stack has to hear the revision every save wrote: a
     * settings save it had not heard about would leave it believing the revision before, and the
     * next undo would read a file carrying a revision the stack never wrote and throw the
     * student's whole history away as though something outside the app had been in.
     */
    .patch("/api/settings", capped, async (c) => {
      const body = await bodyAs(c, savedSettingsSchema, "not-settings");
      if (!body.ok) return c.json({ error: body.error }, 400);

      const { basedOn, ...change } = body.value;
      return answer(c, await setSettings(workspace, change, { basedOn, history: into }), settingsFields);
    });
}
