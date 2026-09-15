import { useId, useState } from "react";
import { t, type Language } from "../i18n/strings.ts";
import { courseName, type Offering } from "./catalog.ts";

export type CoursePickerProps = {
  language: Language;
  offerings: readonly Offering[];
  selected: string | undefined;
  onSelect: (courseNumber: string) => void;
};

/**
 * Choosing the Course whose Groups the week shows.
 *
 * This stands where the Tray will stand. It is deliberately not a Tray: a Tray holds a
 * Semester's planned Attempts plus Courses added directly (CONTEXT.md), and there is no
 * State File, no Plan and no Variant yet — so what a student can choose from today is the
 * Catalog itself. It is replaced, not extended, when the Tray arrives.
 */
export function CoursePicker({
  language,
  offerings,
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
                  {offering.courseNumber} ·{" "}
                  {t(language, "groupsCount", { count: offering.groups.length })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Course number or either name; the student types whichever they remember. */
function matchesSearch(offering: Offering, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;

  return [offering.courseNumber, offering.nameHebrew, offering.nameEnglish ?? ""].some((field) =>
    field.toLowerCase().includes(needle),
  );
}
