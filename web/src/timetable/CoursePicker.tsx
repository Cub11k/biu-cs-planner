import { useId, useState } from "react";
import { t, type Language } from "../i18n/strings.ts";
import { courseName, type Offering } from "./catalog.ts";
import { lessonTypeName } from "./lessonType.ts";
import type { GroupPick } from "./picks.ts";

export type CoursePickerProps = {
  language: Language;
  offerings: readonly Offering[];
  /** Every Pick in the Variant, so a Course can show what is already chosen for it. */
  picks: readonly GroupPick[];
  selected: string | undefined;
  onSelect: (courseNumber: string) => void;
};

/**
 * Choosing the Course whose Groups the week shows, and seeing what is picked for each.
 *
 * This stands where the Tray will stand. It is deliberately not a Tray: a Tray holds a
 * Semester's planned Attempts plus Courses added directly (CONTEXT.md), and there are no
 * Attempts and no Plan yet — so what a student can choose from today is the Catalog itself.
 * It is replaced, not extended, when the Tray arrives, and the chip per Lesson Type the
 * Tray is to carry (docs/design.md, "Grid and Picks") is what the picked line below stands
 * in for until then.
 */
export function CoursePicker({
  language,
  offerings,
  picks,
  selected,
  onSelect,
}: CoursePickerProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const searchId = useId();
  const matches = offerings.filter((offering) => matchesSearch(offering, search));

  return (
    <div className="flex h-full flex-col gap-3">
      <h2 className="text-sm font-semibold">{t(language, "catalogHeading")}</h2>

      <label className="sr-only" htmlFor={searchId}>
        {t(language, "catalogSearch")}
      </label>
      <input
        id={searchId}
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t(language, "catalogSearch")}
        className="rounded-sm border border-rule bg-paper px-2 py-1 text-sm"
      />

      {matches.length === 0 ? (
        <p className="text-sm text-pencil">{t(language, "catalogEmpty")}</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto">
          {matches.map((offering) => (
            <li key={offering.courseNumber}>
              <button
                type="button"
                aria-pressed={offering.courseNumber === selected}
                onClick={() => onSelect(offering.courseNumber)}
                // `border-s-3` and not a box shadow: the marked edge has to be the start
                // edge, which is the right one in Hebrew.
                className={`w-full rounded-sm border bg-paper px-2.5 py-2 text-start text-sm ${
                  offering.courseNumber === selected ? "border-s-3 border-ink" : "border-rule"
                }`}
              >
                <span className="block font-medium">{courseName(offering, language)}</span>
                <span className="block text-xs text-pencil">
                  {offering.courseNumber} · {groupCount(language, offering.groups.length)}
                </span>
                {picked(picks, offering.courseNumber, language) === undefined ? null : (
                  <span className="mt-0.5 block text-xs font-medium text-ink-soft">
                    {t(language, "pickedLabel")}{" "}
                    {picked(picks, offering.courseNumber, language)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What is picked for one Course, as "Lecture 01 · Tirgul 03", or nothing when it has no
 * Pick. One Pick per Lesson Type, so this line has one entry per Lesson Type chosen and
 * shows at a glance which of a Course's Lesson Types are still missing.
 */
function picked(
  picks: readonly GroupPick[],
  courseNumber: string,
  language: Language,
): string | undefined {
  const mine = picks.filter((pick) => pick.courseNumber === courseNumber);
  if (mine.length === 0) return undefined;

  return mine
    .map((pick) => `${lessonTypeName(pick.lessonType, language)} ${pick.groupNumber}`)
    .join(" · ");
}

/** One Group is not "1 groups", and Hebrew's singular is a different word again. */
function groupCount(language: Language, count: number): string {
  return count === 1
    ? t(language, "groupsCountOne")
    : t(language, "groupsCount", { count });
}

/** Course number or either name; the student types whichever they remember. */
function matchesSearch(offering: Offering, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;

  return [offering.courseNumber, offering.nameHebrew, offering.nameEnglish ?? ""].some((field) =>
    field.toLowerCase().includes(needle),
  );
}
