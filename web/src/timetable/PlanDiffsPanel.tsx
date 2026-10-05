import { t, type Language, type StringKey } from "../i18n/strings.ts";
import type { Semester } from "./catalog.ts";
import type { PlanDiff } from "./picks.ts";
import { isActionable, type ActionablePlanDiff } from "./planDiffs.ts";

/**
 * Plan Diffs on the Timetable (#296; docs/design.md, "Plan Diff"): the words for one, and the side
 * panel's section listing every one of the Variant shown, each actionable one with its one-click
 * "apply to Plan". The Tray's badges (`./TrayColumn.tsx`) use the same words.
 *
 * It decides nothing: which Plan Diffs there are is the server's (`planDiffs` in `core`), and
 * applying one is a request the screen sends. A Plan Diff is never applied but by a press here or
 * on a badge (ADR-0008).
 */

const SEMESTER_STRING = {
  fall: "semesterFall",
  spring: "semesterSpring",
  summer: "semesterSummer",
} as const satisfies Record<Semester, StringKey>;

const BADGE = {
  add: "planDiffBadgeAdd",
  drop: "planDiffBadgeDrop",
  move: "planDiffBadgeMove",
  "not-offered": "planDiffBadgeNotOffered",
} as const satisfies Record<PlanDiff["kind"], StringKey>;

const APPLY = {
  add: "planDiffApplyAdd",
  drop: "planDiffApplyDrop",
  move: "planDiffApplyMove",
} as const satisfies Record<ActionablePlanDiff["kind"], StringKey>;

const SAID = {
  add: "planDiffSaidAdd",
  drop: "planDiffSaidDrop",
  move: "planDiffSaidMove",
  "not-offered": "planDiffSaidNotOffered",
} as const satisfies Record<PlanDiff["kind"], StringKey>;

/** The Semester a `move` goes to, named; nothing for the other kinds. */
const targetOf = (language: Language, diff: PlanDiff): Record<string, string> =>
  diff.kind === "move" ? { semester: t(language, SEMESTER_STRING[diff.to]) } : {};

/** What a Tray badge says. */
export const planDiffBadge = (language: Language, diff: PlanDiff): string =>
  t(language, BADGE[diff.kind], targetOf(language, diff));

/** What the button that applies a Plan Diff says. */
export const planDiffApply = (language: Language, diff: ActionablePlanDiff): string =>
  t(language, APPLY[diff.kind], targetOf(language, diff));

/** The sentence the side panel says about a Plan Diff. */
export const planDiffSaid = (language: Language, diff: PlanDiff, course: string): string =>
  t(language, SAID[diff.kind], { course, ...targetOf(language, diff) });

/** What tells two Plan Diffs of one Variant apart: their kind and their Course (#295). */
export const planDiffKey = (diff: PlanDiff): string => `${diff.kind}:${diff.courseNumber}`;

export type PlanDiffsPanelProps = {
  language: Language;
  planDiffs: readonly PlanDiff[];
  /** The Course name to show; its number when nothing can name it. */
  nameOf: (courseNumber: string) => string;
  /** Applying one, or `undefined` for *not now* — there is no revision to base it on. */
  onApply: ((diff: ActionablePlanDiff) => void) | undefined;
};

/** The side panel's Plan Diffs section. The screen leaves it out when there are none. */
export function PlanDiffsPanel({ language, planDiffs, nameOf, onApply }: PlanDiffsPanelProps): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2" aria-label={t(language, "planDiffsHeading")}>
      <h2 className="text-sm font-semibold">{t(language, "planDiffsHeading")}</h2>
      <ul className="flex flex-col gap-2">
        {planDiffs.map((diff) => (
          <li
            key={planDiffKey(diff)}
            className="plan-diff-entry flex flex-col items-start gap-1 bg-paper px-2.5 py-2 text-sm"
            data-plan-diff-entry={planDiffKey(diff)}
          >
            <span>{planDiffSaid(language, diff, nameOf(diff.courseNumber))}</span>
            {isActionable(diff) && (
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
          </li>
        ))}
      </ul>
    </section>
  );
}
