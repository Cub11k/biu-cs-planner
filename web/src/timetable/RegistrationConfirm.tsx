import { useId } from "react";
import { t, type Language } from "../i18n/strings.ts";
import { planDiffApply, planDiffKey, planDiffSaid } from "./PlanDiffsPanel.tsx";
import { isActionable } from "./planDiffs.ts";
import type { RegistrationPreview } from "./registration.ts";

export type RegistrationConfirmProps = {
  language: Language;
  /** The Variant being marked, as the student named it. */
  variant: string;
  /** What "apply all" would do, read before this was shown; `unavailable` offers only the mark. */
  preview: RegistrationPreview;
  nameOf: (courseNumber: string) => string;
  onApplyAll: () => void;
  onOnlyMark: () => void;
  onCancel: () => void;
};

/**
 * The one confirmation marking a Variant registered asks (#297; docs/design.md, "Plan Diff"): every
 * change "apply all" would make to the Plan, listed before anything is written — the Plan Diffs,
 * the `not-offered` ones among them saying they are not applied, and the Courses that would become
 * registered — then "apply all", "only mark" and cancel. Nothing reaches the Plan but by the first
 * (ADR-0008).
 *
 * Inline under the tabs rather than a modal, so the week it is about stays in view. It takes the
 * focus when it opens, as the rename form does, and Escape cancels it.
 */
export function RegistrationConfirm({
  language,
  variant,
  preview,
  nameOf,
  onApplyAll,
  onOnlyMark,
  onCancel,
}: RegistrationConfirmProps): React.JSX.Element {
  const headingId = useId();
  const served = preview.kind === "served" ? preview : undefined;
  return (
    <section
      role="dialog"
      aria-labelledby={headingId}
      data-registration-confirm=""
      className="flex flex-col gap-2 border-b border-rule bg-hint px-4 py-3 text-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <h2 id={headingId} className="font-semibold">
        {t(language, "registrationHeading", { name: variant })}
      </h2>
      {served === undefined ? (
        <p>{t(language, "registrationUnavailable")}</p>
      ) : served.planDiffs.length === 0 && served.registers.length === 0 ? (
        <p>{t(language, "registrationNothing")}</p>
      ) : (
        <>
          <p>{t(language, "registrationIntro")}</p>
          <ul className="list-disc space-y-1 ps-5" data-registration-changes="">
            {served.planDiffs.map((diff) => {
              const said = planDiffSaid(language, diff, nameOf(diff.courseNumber));
              return (
                <li key={planDiffKey(diff)} data-registration-change={planDiffKey(diff)}>
                  {isActionable(diff)
                    ? t(language, "registrationApplies", { said, apply: planDiffApply(language, diff) })
                    : t(language, "registrationNotApplied", { said })}
                </li>
              );
            })}
            {served.registers.length > 0 && (
              <li data-registration-change="registers">
                {t(language, "registrationRegisters", {
                  courses: served.registers.map(nameOf).join(t(language, "registrationSeparator")),
                })}
              </li>
            )}
          </ul>
        </>
      )}
      <div className="flex flex-wrap gap-1">
        {served !== undefined && (
          <button
            type="button"
            data-registration="apply"
            // the student is here to answer, so the answer the question is about has the focus
            autoFocus
            onClick={onApplyAll}
            className="variant-action"
          >
            {t(language, "registrationApplyAll")}
          </button>
        )}
        <button
          type="button"
          data-registration="mark"
          autoFocus={served === undefined}
          onClick={onOnlyMark}
          className="variant-action"
        >
          {t(language, "registrationOnlyMark")}
        </button>
        <button type="button" data-registration="cancel" onClick={onCancel} className="variant-action">
          {t(language, "registrationCancel")}
        </button>
      </div>
    </section>
  );
}
