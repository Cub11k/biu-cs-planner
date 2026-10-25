import { useRef } from "react";
import { DIRECTION, t, type Language, type StringKey } from "../i18n/strings.ts";
import { academicYearSpan } from "./calendar.ts";
import type { Semester } from "./catalog.ts";
import { tabKeyTarget } from "./VariantTabs.tsx";

const SEMESTERS: readonly Semester[] = ["fall", "spring", "summer"];

export const SEMESTER_STRING = {
  fall: "semesterFall",
  spring: "semesterSpring",
  summer: "semesterSummer",
} as const satisfies Record<Semester, StringKey>;

/** The id of a Semester's tab, for the panel's `aria-labelledby`. */
export const semesterTabId = (panelId: string, semester: Semester): string => `${panelId}-semester-${semester}`;

export type SemesterTabsProps = {
  language: Language;
  academicYear: number;
  semester: Semester;
  /** Showing another Semester, or another Academic Year: view state, never a State File edit. */
  onShow: (academicYear: number, semester: Semester) => void;
  /** The id of the element the tabs control: everything under them. */
  panelId: string;
};

/**
 * The year control and the Semester tabs above the Timetable (#418; docs/design.md, "Screens").
 *
 * The year is written as `academicYearSpan` writes it everywhere else, with a step either way; a
 * year with no Catalog is the Catalog pane's notice to give, not a reason to stop here. The tabs
 * are a tab list as the Variant tabs are (`./VariantTabs.tsx`): one Tab stop, the arrow keys in the
 * visual direction, and switching on Enter or Space rather than on focus, because showing a
 * Semester asks the server for its Catalog and its Timetable.
 */
export function SemesterTabs({ language, academicYear, semester, onShow, panelId }: SemesterTabsProps): React.JSX.Element {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const rtl = DIRECTION[language] === "rtl";

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-desk px-4 py-1.5 text-sm">
      <div role="group" aria-label={t(language, "yearControl")} className="flex items-center gap-1">
        <button
          type="button"
          data-year-step="previous"
          aria-label={t(language, "yearPrevious")}
          onClick={() => onShow(academicYear - 1, semester)}
          className="variant-action"
        >
          {/* an arrow that points back in the reading direction */}
          {rtl ? "→" : "←"}
        </button>
        <span data-year-shown="" className="px-1 font-semibold">
          {t(language, "academicYear", academicYearSpan(academicYear))}
        </span>
        <button
          type="button"
          data-year-step="next"
          aria-label={t(language, "yearNext")}
          onClick={() => onShow(academicYear + 1, semester)}
          className="variant-action"
        >
          {rtl ? "←" : "→"}
        </button>
      </div>
      <div role="tablist" aria-label={t(language, "semesterTabs")} className="flex flex-wrap gap-1">
        {SEMESTERS.map((each, index) => {
          const selected = each === semester;
          return (
            <button
              key={each}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={semesterTabId(panelId, each)}
              aria-controls={panelId}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              data-semester={each}
              onClick={() => {
                if (!selected) onShow(academicYear, each);
              }}
              onKeyDown={(event) => {
                const to = tabKeyTarget(language, index, SEMESTERS.length, event.key);
                if (to !== undefined) tabs.current[to]?.focus();
              }}
              className={`variant-tab rounded-sm border px-2.5 py-1 ${selected ? "is-selected border-ink" : "border-rule"}`}
            >
              {t(language, SEMESTER_STRING[each])}
            </button>
          );
        })}
      </div>
    </div>
  );
}
