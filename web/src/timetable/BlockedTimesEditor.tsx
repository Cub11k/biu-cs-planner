import { useId, useState } from "react";
import { t, type Language, type StringKey } from "../i18n/strings.ts";
import type { Day, Semester } from "./catalog.ts";
import type { BlockedRange } from "./blockedTimes.ts";
import type { BlockedTime, BlockedTimeWarning } from "./picks.ts";
import { WEEK_DAYS } from "./week.ts";

/** Every Day a Blocked Time can fall on: the week, and Friday, which it brings onto the grid. */
const DAYS: readonly Day[] = [...WEEK_DAYS, "friday"];

const SEMESTER_STRING = {
  fall: "semesterFall",
  spring: "semesterSpring",
  summer: "semesterSummer",
} as const satisfies Record<Semester, StringKey>;

export type BlockedTimesEditorProps = {
  language: Language;
  /** The Semester shown, which the copy control offers the other two of. */
  semester: Semester;
  /** The Semester's Blocked Times, or `undefined` while the State File has not been read. */
  blockedTimes: readonly BlockedTime[] | undefined;
  warnings: readonly BlockedTimeWarning[];
  /**
   * The edits, or `undefined` for *not now* — there is no revision to base a save on — in which
   * case every control that would write is disabled.
   */
  edits:
    | {
        /** Each answered with whether the save landed, which is what closes the form (#324). */
        add: (range: BlockedRange) => Promise<FormAnswer>;
        replace: (index: number, range: BlockedRange) => Promise<FormAnswer>;
        remove: (index: number) => void;
        copyTo: (semester: Semester) => void;
      }
    | undefined;
};

/**
 * What became of a save the form sent: it landed, or it did not and `said` is why — `undefined`
 * when there is nothing to say beyond what the screen's own notices already say.
 */
export type FormAnswer = { landed: true } | { landed: false; said: string | undefined };

const EMPTY: BlockedRange = { day: "sunday", start: "08:00", end: "10:00", label: "" };

/**
 * Entering the Semester's Blocked Times (#282): a list of them with Edit and Remove, a form for
 * a new one or a changed one, and copying them all to another Semester.
 *
 * A form rather than a popover over the grid: every control is an ordinary field with a label,
 * reached with Tab and submitted with Enter, which is what keeps it usable without a mouse. The
 * student types one range; a range that ends before it starts wraps past midnight, and the server
 * stores it as two rows (CONTEXT.md, Blocked Time) — this form does not need to know that rule,
 * and the list then shows both rows, which is the truth about what was stored.
 */
export function BlockedTimesEditor({
  language,
  semester,
  blockedTimes,
  warnings,
  edits,
}: BlockedTimesEditorProps): React.JSX.Element {
  /** The form: closed, a new Blocked Time, or the one at this position being changed. */
  const [editing, setEditing] = useState<"new" | number | undefined>(undefined);
  const [range, setRange] = useState<BlockedRange>(EMPTY);
  const others = (["fall", "spring", "summer"] as const).filter((other) => other !== semester);
  const [copyTarget, setCopyTarget] = useState<Semester>(others[0]!);
  /** Why the last save from the form did not land, shown beside it until the next try. */
  const [notSaved, setNotSaved] = useState<string | undefined>(undefined);
  /** A save from the form is in flight, so a second press cannot send it twice. */
  const [saving, setSaving] = useState(false);
  const ids = { day: useId(), start: useId(), end: useId(), label: useId(), copy: useId() };

  const open = (which: "new" | number): void => {
    const held = typeof which === "number" ? blockedTimes?.[which] : undefined;
    setRange(
      held === undefined
        ? EMPTY
        : { day: held.day, start: held.start, end: held.end, label: held.label },
    );
    setEditing(which);
    setNotSaved(undefined);
  };

  /**
   * The form closes only once the answer says the save landed (#324). Closing it as the request
   * left lost what the student typed whenever the save was then refused — a stale revision is the
   * ordinary way — so it stays open with its input, and says why beside it.
   */
  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (edits === undefined || editing === undefined) return;
    const sent = editing === "new" ? edits.add(range) : edits.replace(editing, range);
    setSaving(true);
    setNotSaved(undefined);
    void sent.then((answer) => {
      setSaving(false);
      if (answer.landed) setEditing(undefined);
      else setNotSaved(answer.said ?? "");
    });
  };

  return (
    <section className="flex flex-col gap-1.5" aria-label={t(language, "blockedHeading")}>
      <h2 className="text-sm font-semibold">{t(language, "blockedHeading")}</h2>

      {blockedTimes !== undefined && blockedTimes.length === 0 && (
        <p className="text-sm text-pencil">{t(language, "blockedNone")}</p>
      )}
      {blockedTimes !== undefined && blockedTimes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {blockedTimes.map((blocked, index) => (
            <li
              key={`${index}:${blocked.day}:${blocked.start}`}
              className="blocked-row flex flex-wrap items-center gap-1 text-sm"
              data-blocked-row={index}
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{blocked.label || t(language, "blockedUnlabelled")}</span>
                {" · "}
                {t(language, blocked.day)}{" "}
                <bdi dir="ltr">
                  {blocked.start}–{blocked.end}
                </bdi>
                {warnings.some((warning) => warning.index === index) && (
                  <span className="tray-incomplete ms-1">{t(language, "blockedDoesNotAdvance")}</span>
                )}
              </span>
              <button
                type="button"
                data-blocked-action="edit"
                disabled={edits === undefined}
                onClick={() => open(index)}
                className="variant-action text-xs"
              >
                {t(language, "blockedEdit")}
              </button>
              <button
                type="button"
                data-blocked-action="remove"
                disabled={edits === undefined}
                onClick={() => edits?.remove(index)}
                className="variant-action text-xs"
              >
                {t(language, "blockedRemove")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing === undefined ? (
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            data-blocked-action="new"
            disabled={edits === undefined}
            onClick={() => open("new")}
            className="variant-action text-xs"
          >
            {t(language, "blockedAdd")}
          </button>
          {blockedTimes !== undefined && blockedTimes.length > 0 && (
            <>
              <label htmlFor={ids.copy} className="sr-only">
                {t(language, "blockedCopyTarget")}
              </label>
              <select
                id={ids.copy}
                value={copyTarget}
                onChange={(event) => setCopyTarget(event.target.value as Semester)}
                className="rounded-sm border border-rule bg-paper px-1 py-0.5 text-xs"
              >
                {others.map((other) => (
                  <option key={other} value={other}>
                    {t(language, SEMESTER_STRING[other])}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-blocked-action="copy"
                disabled={edits === undefined}
                onClick={() => edits?.copyTo(copyTarget)}
                className="variant-action text-xs"
              >
                {t(language, "blockedCopy")}
              </button>
            </>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="blocked-form grid grid-cols-2 gap-1 text-xs">
          <label htmlFor={ids.day} className="text-pencil">
            {t(language, "blockedDay")}
          </label>
          <select
            id={ids.day}
            value={range.day}
            onChange={(event) => setRange({ ...range, day: event.target.value as Day })}
            className="rounded-sm border border-rule bg-paper px-1 py-0.5"
          >
            {DAYS.map((day) => (
              <option key={day} value={day}>
                {t(language, day)}
              </option>
            ))}
          </select>
          <label htmlFor={ids.start} className="text-pencil">
            {t(language, "blockedStart")}
          </label>
          <input
            id={ids.start}
            type="time"
            required
            value={range.start}
            onChange={(event) => setRange({ ...range, start: event.target.value })}
            className="rounded-sm border border-rule bg-paper px-1 py-0.5"
          />
          <label htmlFor={ids.end} className="text-pencil">
            {t(language, "blockedEnd")}
          </label>
          <input
            id={ids.end}
            type="time"
            required
            value={range.end}
            onChange={(event) => setRange({ ...range, end: event.target.value })}
            className="rounded-sm border border-rule bg-paper px-1 py-0.5"
          />
          <label htmlFor={ids.label} className="text-pencil">
            {t(language, "blockedLabel")}
          </label>
          <input
            id={ids.label}
            value={range.label}
            maxLength={200}
            onChange={(event) => setRange({ ...range, label: event.target.value })}
            className="rounded-sm border border-rule bg-paper px-1 py-0.5"
          />
          <p className="col-span-2 text-pencil">{t(language, "blockedWrapHint")}</p>
          {notSaved !== undefined && (
            <p className="col-span-2 tray-incomplete" data-blocked-not-saved="">
              {t(language, "blockedNotSaved")} {notSaved}
            </p>
          )}
          <span className="col-span-2 flex gap-1">
            <button
              type="submit"
              data-blocked-action="save"
              disabled={saving || edits === undefined}
              className="variant-action"
            >
              {t(language, "blockedSave")}
            </button>
            <button type="button" onClick={() => setEditing(undefined)} className="variant-action">
              {t(language, "blockedCancel")}
            </button>
          </span>
        </form>
      )}
    </section>
  );
}
