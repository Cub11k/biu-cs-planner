import { useState } from "react";
import { t, type Language } from "../i18n/strings.ts";
import { lessonSlot, lessonTypeName } from "./lessonType.ts";
import type { PlanDiff, TrayEntry } from "./picks.ts";
import { planDiffApply, planDiffBadge, planDiffKey } from "./PlanDiffsPanel.tsx";
import { isActionable, type ActionablePlanDiff } from "./planDiffs.ts";

export type TrayColumnProps = {
  language: Language;
  /**
   * The Tray as the server derived it, or `undefined` while the State File has not been read —
   * which is not an empty Tray, and is not drawn as one.
   */
  tray: readonly TrayEntry[] | undefined;
  /** The Course name to show; its number when nothing can name it. */
  nameOf: (courseNumber: string) => string;
  selected: string | undefined;
  onSelect: (courseNumber: string) => void;
  /** Taking a Course out, or `undefined` for *not now* — there is no revision to base it on. */
  onRemove: ((courseNumber: string) => void) | undefined;
  /** The Plan Diffs of the Variant shown (#296), drawn as badges on the entries they are about. */
  planDiffs?: readonly PlanDiff[];
  /** Applying one to the Plan, or `undefined` for *not now*, as `onRemove` is. */
  onApplyPlanDiff?: ((diff: ActionablePlanDiff) => void) | undefined;
};

/**
 * The Tray (#283; docs/design.md, "Grid and Picks"): the Courses waiting to be scheduled in the
 * Variant shown, each with one chip per Lesson Type — filled with the Group number once picked,
 * empty while missing — and an incomplete mark while any is missing.
 *
 * It decides nothing: which Courses are here, why, and what each needs is the server's
 * derivation (`trayEntries` in `core`), and this draws it. Selecting an entry puts that Course's
 * Groups on the week as pencil options, which is how the Tray drives picking.
 *
 * **A Plan Diff is a badge on the entry it is about** (#296; docs/design.md, "Tray badges"): "not in
 * plan", "not scheduled", "offered in" another Semester, "not in this year's catalog". Pressing an
 * actionable one offers its "apply to Plan" beside it, and nothing is applied until that is
 * pressed (ADR-0008); a `not-offered` one has nothing to offer and is a label, not a button.
 */
export function TrayColumn({
  language,
  tray,
  nameOf,
  selected,
  onSelect,
  onRemove,
  planDiffs = [],
  onApplyPlanDiff,
}: TrayColumnProps): React.JSX.Element {
  /** The badge whose "apply to Plan" is offered, by its Plan Diff's key; one at a time. */
  const [offered, setOffered] = useState<string | undefined>(undefined);
  return (
    <section className="flex flex-col gap-1.5" aria-label={t(language, "trayHeading")}>
      <h2 className="text-sm font-semibold">{t(language, "trayHeading")}</h2>
      {tray === undefined ? null : tray.length === 0 ? (
        <p className="text-sm text-pencil">{t(language, "trayEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tray.map((entry) => (
            <li
              key={entry.courseNumber}
              className="tray-entry flex flex-wrap items-start gap-1"
              data-course={entry.courseNumber}
              data-complete={entry.complete === null ? "unknown" : String(entry.complete)}
            >
              <button
                type="button"
                aria-pressed={entry.courseNumber === selected}
                onClick={() => onSelect(entry.courseNumber)}
                // `border-s-3`, the start edge, which is the right one in Hebrew
                className={`min-w-0 flex-1 rounded-sm border bg-paper px-2.5 py-2 text-start text-sm ${
                  entry.courseNumber === selected ? "border-s-3 border-ink" : "border-rule"
                }`}
              >
                <span className="block font-medium">{nameOf(entry.courseNumber)}</span>
                <span className="block text-xs text-pencil">{entry.courseNumber}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1">
                  {entry.chips.map((chip) => (
                    <span
                      key={chip.lessonType}
                      className={`tray-chip ${chip.groupNumber === undefined ? "is-missing" : "is-filled"}`}
                      data-lesson-slot={lessonSlot(chip.lessonType)}
                      data-lesson-type={chip.lessonType}
                    >
                      {lessonTypeName(chip.lessonType, language)}{" "}
                      {chip.groupNumber ?? t(language, "trayChipMissing")}
                    </span>
                  ))}
                  {entry.complete === false && (
                    <span className="tray-incomplete">{t(language, "trayIncomplete")}</span>
                  )}
                  {/* not in this Semester's Catalog: what the Course needs is not known, and
                      saying so is what keeps it from being quietly forgotten */}
                  {!entry.known && (
                    <span className="text-xs text-pencil">{t(language, "trayChipsUnknown")}</span>
                  )}
                </span>
              </button>
              <button
                type="button"
                data-tray-remove={entry.courseNumber}
                // a Course here only because the Plan puts it in this Semester has nothing the
                // Timetable may take out: the Attempt is the Plan's (ADR-0008)
                disabled={onRemove === undefined || entry.origins.every((why) => why === "planned")}
                aria-label={t(language, "trayRemoveCourse", { course: nameOf(entry.courseNumber) })}
                onClick={() => onRemove?.(entry.courseNumber)}
                className="variant-action text-xs"
              >
                {t(language, "trayRemove")}
              </button>
              <PlanDiffBadges
                language={language}
                diffs={planDiffs.filter((diff) => diff.courseNumber === entry.courseNumber)}
                course={nameOf(entry.courseNumber)}
                offered={offered}
                onOffer={setOffered}
                onApply={
                  onApplyPlanDiff === undefined
                    ? undefined
                    : (diff) => {
                        setOffered(undefined);
                        onApplyPlanDiff(diff);
                      }
                }
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One Tray entry's Plan Diff badges, and the apply the pressed one offers. Nothing when none. */
function PlanDiffBadges({
  language,
  diffs,
  course,
  offered,
  onOffer,
  onApply,
}: {
  language: Language;
  diffs: readonly PlanDiff[];
  course: string;
  offered: string | undefined;
  onOffer: (key: string | undefined) => void;
  onApply: ((diff: ActionablePlanDiff) => void) | undefined;
}): React.JSX.Element | null {
  if (diffs.length === 0) return null;
  return (
    <span className="flex basis-full flex-wrap items-center gap-1">
      {diffs.map((diff) => {
        const key = planDiffKey(diff);
        const label = t(language, "planDiffBadgeLabel", { badge: planDiffBadge(language, diff), course });
        if (!isActionable(diff)) {
          return (
            <span key={key} className="plan-diff-badge" data-plan-diff={diff.kind} aria-label={label} role="note">
              {planDiffBadge(language, diff)}
            </span>
          );
        }
        const open = offered === key;
        return (
          <span key={key} className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              className="plan-diff-badge"
              data-plan-diff={diff.kind}
              aria-expanded={open}
              aria-label={label}
              onClick={() => onOffer(open ? undefined : key)}
            >
              {planDiffBadge(language, diff)}
            </button>
            {open && (
              <button
                type="button"
                data-plan-diff-apply={diff.kind}
                disabled={onApply === undefined}
                onClick={() => onApply?.(diff)}
                className="variant-action text-xs"
              >
                {planDiffApply(language, diff)}
              </button>
            )}
          </span>
        );
      })}
    </span>
  );
}
