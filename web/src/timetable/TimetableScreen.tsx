import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { DIRECTION, t, type Language, type StringKey } from "../i18n/strings.ts";
import { academicYearOf, academicYearSpan, semesterOf } from "./calendar.ts";
import { courseName, type Semester } from "./catalog.ts";
import { fetchOfferings, type CatalogWarning, type OfferingsResult } from "./offerings.ts";
import { CoursePicker } from "./CoursePicker.tsx";
import { WeekGrid } from "./WeekGrid.tsx";

const SEMESTER_STRING = {
  fall: "semesterFall",
  spring: "semesterSpring",
  summer: "semesterSummer",
} as const satisfies Record<Semester, StringKey>;

type CatalogState = { kind: "loading" } | OfferingsResult;

/**
 * Why the API served no Catalog, said in words the student can act on. A Warning nobody
 * can read is not a Warning, and the four reasons ask for four different things.
 */
const WARNING_STRING = new Map<CatalogWarning["kind"], StringKey>([
  ["file-unreadable", "warningFileUnreadable"],
  ["schema-version-too-new", "warningSchemaTooNew"],
  ["schema-version-unsupported", "warningSchemaUnsupported"],
  ["workspace-refused", "warningWorkspaceRefused"],
]);

/** Absence is not a fault: the year simply has no Catalog yet, and one can be imported. */
const isAbsence = (warnings: readonly CatalogWarning[]): boolean =>
  warnings.length === 0 || warnings.every((warning) => warning.kind === "no-catalog-for-year");

export type TimetableScreenProps = {
  language: Language;
  onLanguage: (language: Language) => void;
  /** Taken as an argument so the screen can be opened on any date, and tested. */
  today?: Date;
};

/**
 * The landing screen: the week of one Semester of the current Academic Year, and the
 * Catalog to choose a Course from. Choosing one puts its Groups' Meetings on the week.
 *
 * It reaches the domain only through the typed client in ../api.ts, which is the only
 * thing on this side that knows the API contract (docs/design.md, "Architecture").
 */
export function TimetableScreen({
  language,
  onLanguage,
  today = new Date(),
}: TimetableScreenProps): React.JSX.Element {
  const academicYear = academicYearOf(today);
  const semester = semesterOf(today);

  const [catalog, setCatalog] = useState<CatalogState>({ kind: "loading" });
  const [selected, setSelected] = useState<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    setCatalog({ kind: "loading" });

    fetchOfferings(api, { academicYear, semester }).then((result) => {
      if (current) setCatalog(result);
    });

    return () => {
      current = false;
    };
  }, [academicYear, semester]);

  const offerings = catalog.kind === "served" ? catalog.offerings : [];
  const chosen = offerings.find((offering) => offering.courseNumber === selected);
  // one spelling of the year on the whole screen: the header and the sidebar disagreeing
  // about 2026-27 and 2027 reads as if a different year were the one missing
  const yearLabel = t(language, "academicYear", academicYearSpan(academicYear));

  return (
    <div dir={DIRECTION[language]} className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-4 border-b border-rule bg-paper px-4 py-2">
        <h1 className="text-lg font-semibold">{t(language, "timetable")}</h1>
        <span className="text-sm text-pencil">
          {t(language, SEMESTER_STRING[semester])} · {yearLabel}
        </span>
        <button
          type="button"
          onClick={() => onLanguage(language === "en" ? "he" : "en")}
          className="ms-auto rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft"
        >
          {t(language, "otherLanguage")}
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="overflow-auto border-e border-rule bg-desk p-4">
          {catalog.kind === "loading" ? (
            <p className="text-sm text-pencil">{t(language, "catalogLoading")}</p>
          ) : catalog.kind === "unreachable" ? (
            <p className="text-sm text-pencil">{t(language, "apiUnreachable")}</p>
          ) : catalog.kind === "unauthorized" ? (
            <p className="text-sm text-pencil">{t(language, "catalogUnauthorized")}</p>
          ) : catalog.kind === "refused" ? (
            <CatalogNotice
              language={language}
              academicYear={yearLabel}
              warnings={catalog.warnings}
            />
          ) : (
            <CoursePicker
              language={language}
              offerings={offerings}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </aside>

        <section className="flex min-w-0 flex-col">
          <p className="flex items-center gap-3 border-b border-rule bg-hint px-4 py-2 text-sm text-ink-soft">
            {chosen === undefined
              ? t(language, "hintChoose")
              : t(language, "hintShowing", { course: courseName(chosen, language) })}
            <span className="ms-auto flex items-center gap-2 text-xs text-pencil">
              <span className="inline-block h-3 w-4 rounded-xs border-2 border-dashed border-pencil" />
              {t(language, "legendPencil")}
            </span>
          </p>

          <div className="min-h-0 flex-1 overflow-auto">
            {/* keyed by the Course: choosing another one starts the week fresh, so a
                Group highlighted under the pointer cannot carry over to a Group of the
                same number and Lesson Type in the Course that replaced it */}
            <WeekGrid
              key={chosen?.courseNumber ?? "none"}
              language={language}
              semester={semester}
              offering={chosen}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * What the screen says when the API served no Catalog. Absence asks the student to import
 * a crawl; a file that is there but unreadable asks for something else entirely, so the
 * Warnings the API sent decide which it is and are shown rather than swallowed.
 */
export function CatalogNotice({
  language,
  academicYear,
  warnings,
}: {
  language: Language;
  /** Spelled as the header spells it, so the screen names one year once. */
  academicYear: string;
  warnings: readonly CatalogWarning[];
}): React.JSX.Element {
  return (
    <div className="text-sm text-pencil">
      <p>
        {isAbsence(warnings)
          ? t(language, "catalogMissing", { year: academicYear })
          : t(language, "catalogUnreadable", { year: academicYear })}
      </p>
      <ul className="mt-2 list-disc space-y-1 ps-5">
        {warnings.map((warning) => {
          const key = WARNING_STRING.get(warning.kind);
          return key === undefined ? null : <li key={warning.kind}>{t(language, key)}</li>;
        })}
      </ul>
    </div>
  );
}
