import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { DIRECTION, t, type Language, type StringKey } from "../i18n/strings.ts";
import { academicYearOf, academicYearSpan, semesterOf } from "./calendar.ts";
import { courseName, type Offering, type Semester } from "./catalog.ts";
import { fetchOfferings } from "./offerings.ts";
import { CoursePicker } from "./CoursePicker.tsx";
import { WeekGrid } from "./WeekGrid.tsx";

const SEMESTER_STRING = {
  fall: "semesterFall",
  spring: "semesterSpring",
  summer: "semesterSummer",
} as const satisfies Record<Semester, StringKey>;

type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; offerings: Offering[] }
  /** The Workspace has no Catalog for this Academic Year, or would not read it. */
  | { kind: "missing" }
  | { kind: "unreachable" };

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
      if (!current) return;
      setCatalog(
        result.kind === "served" ? { kind: "ready", offerings: result.offerings } : result,
      );
    });

    return () => {
      current = false;
    };
  }, [academicYear, semester]);

  const offerings = catalog.kind === "ready" ? catalog.offerings : [];
  const chosen = offerings.find((offering) => offering.courseNumber === selected);
  const span = academicYearSpan(academicYear);

  return (
    <div dir={DIRECTION[language]} className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-4 border-b border-rule bg-paper px-4 py-2">
        <h1 className="text-lg font-semibold">{t(language, "timetable")}</h1>
        <span className="text-sm text-pencil">
          {t(language, SEMESTER_STRING[semester])} · {t(language, "academicYear", span)}
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
          ) : catalog.kind === "missing" ? (
            <p className="text-sm text-pencil">
              {t(language, "catalogMissing", { year: academicYear })}
            </p>
          ) : catalog.kind === "unreachable" ? (
            <p className="text-sm text-pencil">{t(language, "apiUnreachable")}</p>
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
            <WeekGrid language={language} semester={semester} offering={chosen} />
          </div>
        </section>
      </div>
    </div>
  );
}
