import {
  settingsSchema,
  type Settings,
  type StateFileVersion,
  type StateFileWarning,
} from "@biu-cs-planner/core";
import {
  editStateFile,
  readStateFile,
  type EditHistory,
  type EditRefusal,
  type StateEditing,
} from "./edit.ts";
import { DEFAULT_STATE_FILE } from "./picks.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The two use cases behind the State File's `settings`: read them, and set one.
 *
 * `core` has held `settingsSchema` — `language` and `examSpacingDays` — since the schema was
 * written, and `core/src/state/file.ts` reads it field by field so that one corrupted
 * preference costs that preference and not the rest. Until #115 nothing above `core` could
 * reach any of it, so a student's language was hardcoded in `web/src/App.tsx` and reset on
 * every reload.
 *
 * [ADR-0014](../../docs/adr/0014-where-a-preference-is-kept.md) is why they live in the State
 * File rather than in the browser: a per-device *display* preference belongs to the browser's
 * own store, and a preference about the person or the document belongs where the data is. A
 * language is the second kind — a Hebrew speaker wants Hebrew on every device they own — and
 * Exam spacing is a property of the document. The colour scheme is the other kind and stays in
 * `localStorage` (`web/src/scheme.ts`).
 *
 * Setting one goes through `editStateFile` and nothing else, which buys three things at once
 * and is why there is no settings-shaped write path here:
 *
 *   - the external-edit guard (#90): a save carries the revision it was based on, so a
 *     preference written over somebody else's edit is refused rather than silently winning;
 *   - the undo rule ([ADR-0013](../../docs/adr/0013-undo-is-snapshots-not-commands.md),
 *     "settings excluded"): the wrapper already leaves a `settings`-only edit off the stack,
 *     structurally, because a snapshot's type does not carry `settings` at all;
 *   - the one-writer rule (CLAUDE.md, `tools/ci/state-file-writer.test.ts`).
 */

/** What reading the settings comes back as. */
export type SettingsResult =
  /**
   * `version` is the revision of the State File these settings were read from, and the one a
   * save of a change made on them has to be based on — `undefined` when there is no file yet.
   * It travels with the settings for the same reason `TimetableResult`'s does: whatever shows
   * a preference is then holding the revision it came from (docs/design.md, "External edits").
   *
   * `warnings` carries `settings-unreadable` among the rest. `core` raises one per field it
   * could not read, and this is the path by which it reaches a student rather than being
   * dropped at the boundary: a preference silently back at its default is the one a student
   * cannot tell from a preference they never set.
   */
  | {
      kind: "served";
      settings: Settings;
      version: StateFileVersion | undefined;
      warnings: StateFileWarning[];
    }
  | { kind: "refused"; reason: EditRefusal; warnings: StateFileWarning[] };

/**
 * The preferences to set, and only those: a change names the fields it moves and says nothing
 * about the others.
 *
 * Partial rather than the whole `Settings` object, so that a caller which knows about one
 * preference cannot reset another by not mentioning it. That is not hypothetical — the only
 * control that exists today is the language switch, and a whole-object write from it would
 * carry whatever `examSpacingDays` that page happened to have read, or the default if it had
 * read none.
 */
export type SettingsChange = { [K in keyof Settings]?: Settings[K] | undefined };

export type SettingsOptions = {
  /** The revision the view being edited was read from; see `EditOptions.basedOn`. */
  basedOn: StateFileVersion | undefined;
  /** Defaults to `DEFAULT_STATE_FILE`; a State File is named, never a path. */
  stateFile?: string;
  /**
   * Where the undo stack hears about this save. Passed for a settings write too, and the
   * reason is the point rather than a formality: `editStateFile` tells the history the
   * revision **every** save wrote, including one it takes no entry from. A settings save that
   * did not report it would leave the stack believing the revision before it, and the next
   * undo would read a file carrying a revision the stack never wrote and throw the student's
   * whole history away as though something outside the app had been in.
   */
  history?: EditHistory;
};

/** Every field a `Settings` has, from the schema rather than from a list kept here. */
const SETTING_KEYS = Object.keys(settingsSchema.shape) as (keyof Settings)[];

/**
 * The change with the fields it does not mention removed.
 *
 * `SettingsChange` allows an explicit `undefined` and the return type does not, which is this
 * function's whole job spelled as a type. Spreading an explicit `undefined` over the current
 * settings would put it where a value belongs — a State File the schema then rejects, from a
 * caller that meant "leave this alone". It is allowed in because that is what `z.object().
 * partial()` produces at the API boundary and what a caller inside the process naturally
 * writes; it is not allowed through.
 */
function named(change: SettingsChange): Partial<Settings> {
  const named: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (change[key] !== undefined) named[key] = change[key];
  }
  return named as Partial<Settings>;
}

/** Whether two sets of settings say the same thing, field by field over the schema's fields. */
const alike = (a: Settings, b: Settings): boolean => SETTING_KEYS.every((key) => a[key] === b[key]);

/**
 * The pure edit: the preferences named are set and every other part of the document is the
 * object it already was.
 *
 * **It returns the State it was given when nothing moved**, which is load-bearing twice over.
 * `editStateFile` reads that identity as "this edit changed nothing" and writes no file, so
 * choosing the language that is already chosen does not move the Workspace's change count and
 * does not make every other open tab re-read. And every field but `settings` is handed
 * straight through, which is what `movedOutsideSettings` in `./edit.ts` compares by reference
 * when it decides there is nothing here for the undo stack.
 *
 * A `state -> state` function, as ADR-0013 has every edit be. It is here rather than in `core`
 * because there is no domain in it: `recordPick` has to find a Timetable, create a Variant and
 * replace the Pick filling a Lesson Type, and this assigns a field the schema has already
 * validated. `restoring` in `./edit.ts` is the same shape for the same reason.
 */
export const choosing = (change: SettingsChange): StateEditing => ({
  /**
   * One label for both fields. Nothing shows it — ADR-0013 has the label describe an edit for
   * the undo UI, and a settings edit is never on the stack to be described — so a label per
   * field would be two strings no student will read. It is still a truthful name for what was
   * done, for a log or a test reading an outcome.
   */
  label: "set-settings",
  apply: (state) => {
    const settings = { ...state.settings, ...named(change) };
    return alike(settings, state.settings) ? state : { ...state, settings };
  },
});

/** The preferences the State File holds now, and the revision they were read from. */
export async function readSettings(
  workspace: Workspace,
  options: { stateFile?: string } = {},
): Promise<SettingsResult> {
  const loaded = await readStateFile(workspace, options.stateFile ?? DEFAULT_STATE_FILE);
  if ("refused" in loaded) {
    return { kind: "refused", reason: loaded.refused, warnings: loaded.warnings };
  }

  return {
    kind: "served",
    settings: loaded.state.settings,
    version: loaded.version,
    warnings: loaded.warnings,
  };
}

/**
 * Sets the preferences named and reports what the file holds afterwards.
 *
 * **This can be refused**, which is new and is the consequence of a preference living in a
 * guarded document: another tab, an editor, git or Dropbox writing the file between the read
 * the caller was looking at and this save makes it `state-file-changed`, and the change does
 * not happen. Whatever offered the control owes the student an account of that — nothing here
 * retries, because a preference is a deliberate choice and re-applying it over somebody else's
 * edit is exactly what the guard exists to prevent.
 *
 * An unchanged save is served rather than refused: it carries the revision the file still
 * holds, so the caller's next save has something to be based on.
 */
export async function setSettings(
  workspace: Workspace,
  change: SettingsChange,
  options: SettingsOptions,
): Promise<SettingsResult> {
  const outcome = await editStateFile(
    workspace,
    options.stateFile ?? DEFAULT_STATE_FILE,
    choosing(change),
    { basedOn: options.basedOn, ...(options.history ? { history: options.history } : {}) },
  );
  if (outcome.kind === "refused") {
    return { kind: "refused", reason: outcome.reason, warnings: outcome.warnings };
  }

  return {
    kind: "served",
    settings: outcome.state.settings,
    version: outcome.version,
    warnings: outcome.warnings,
  };
}
