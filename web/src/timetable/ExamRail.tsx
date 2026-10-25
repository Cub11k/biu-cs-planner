import { t, type Language } from "../i18n/strings.ts";
import type { ExamPeriod, ExamSitting } from "./exams.ts";

/**
 * What the rail has to draw: still being read, read and not had, or the exam period. Not had is its
 * own state and never an empty period: an answer that carries no exam period says nothing about the
 * student's Exams, and an empty rail would say they have none (#184's ruling).
 */
export type ExamRailState = { kind: "loading" } | { kind: "unread" } | { kind: "served"; period: ExamPeriod };

export type ExamRailProps = {
  language: Language;
  state: ExamRailState;
  /** The Course name to show; its number when nothing can name it. */
  nameOf: (courseNumber: string) => string;
};

/** How far apart a day puts two marks. A length, not a colour: the rail's axis is days. */
const REM_PER_DAY = 0.375;

/** One sitting, told from every other, as `core` tells them apart. */
const keyOf = (sitting: ExamSitting): string =>
  `${sitting.courseNumber}|${sitting.moed}|${sitting.date}|${sitting.time}`;

/** A `YYYY-MM-DD` date as the student reads one, counted in UTC so no timezone moves it. */
function dayOf(language: Language, date: string): string {
  const read = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(read.getTime())) return date;
  return read.toLocaleDateString(language === "he" ? "he-IL" : "en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * The exam period as the rail in the side pane (#419; docs/design.md, "Exams"): one mark per
 * sitting, the distance between marks proportional to the days between them, a later Moed of a
 * Course lighter than its first, and a gap the spacing Warning names drawn in red **with the Warning
 * in words beside it**. An Exam Clash is said in words above the rail. The rail is an ordered list,
 * so a screen reader reads it as the dates in order, each with its gap.
 *
 * It decides nothing: which sittings are too close and which Clash is `core`'s (`checkExams`); this
 * draws the Warnings it is handed against the sittings they name.
 *
 * A Year-long Course's sittings are listed apart, under a heading saying no Semester is recorded for
 * them, and are not on the rail's axis (#214's stopgap): the Catalog cannot say which exam period
 * each is in, and the spacing check leaves them out.
 */
export function ExamRail({ language, state, nameOf }: ExamRailProps): React.JSX.Element {
  const heading = t(language, "examRailHeading");
  return (
    <section className="flex flex-col gap-2 text-sm" aria-label={heading} data-exam-rail="">
      <h2 className="text-sm font-semibold">{heading}</h2>
      {state.kind === "loading" ? (
        <p className="text-pencil">{t(language, "examRailLoading")}</p>
      ) : state.kind === "unread" ? (
        <p data-exam-rail-unread="">{t(language, "examRailUnread")}</p>
      ) : (
        <Period language={language} period={state.period} nameOf={nameOf} />
      )}
    </section>
  );
}

function Period({
  language,
  period,
  nameOf,
}: {
  language: Language;
  period: ExamPeriod;
  nameOf: (courseNumber: string) => string;
}): React.JSX.Element {
  const onRail = period.sittings.filter((sitting) => !sitting.yearLong);
  const yearLong = period.sittings.filter((sitting) => sitting.yearLong);
  const clashes = period.warnings.filter((warning) => warning.kind === "exam-clash");
  /** The spacing Warning about each sitting, by its key. */
  const crowded = new Map(
    period.warnings.flatMap((warning) => (warning.kind === "exam-spacing" ? [[keyOf(warning.sitting), warning]] : [])),
  );
  const clashing = new Set(clashes.flatMap((clash) => clash.sittings.map(keyOf)));
  const said = (sitting: ExamSitting): string =>
    t(language, "examSitting", {
      course: nameOf(sitting.courseNumber),
      moed: sitting.moed,
      date: dayOf(language, sitting.date),
      time: sitting.time,
    });

  return (
    <>
      {clashes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {clashes.map((clash) => (
            <li key={clash.sittings.map(keyOf).join("+")} className="text-[var(--red-pen)]" data-exam-clash="">
              {t(language, "examClash", {
                date: dayOf(language, clash.date),
                first: nameOf(clash.sittings[0].courseNumber),
                second: nameOf(clash.sittings[1].courseNumber),
              })}
            </li>
          ))}
        </ul>
      )}

      {onRail.length === 0 && yearLong.length === 0 && period.coursesWithUnknownExams === 0 && (
        <p>{t(language, "examRailNone")}</p>
      )}

      {onRail.length > 0 && (
        <ol aria-label={t(language, "examRailHeading")} className="ms-1.5 flex flex-col">
          {onRail.map((sitting, index) => {
            const key = keyOf(sitting);
            const previous = onRail[index - 1];
            const warning = crowded.get(key);
            // the gap behind this mark is red when the Warning about it names the mark before it
            const tight =
              previous !== undefined &&
              warning?.kind === "exam-spacing" &&
              warning.nearby.some((near) => keyOf(near) === keyOf(previous));
            // a later sitting of a Course already on the rail: its next Moed, drawn lighter
            const resit = onRail.slice(0, index).some((before) => before.courseNumber === sitting.courseNumber);
            const gap = sitting.daysSincePrevious;
            const red = tight || clashing.has(key);
            return (
              <li
                key={key}
                data-exam-sitting={key}
                data-tight={tight}
                data-resit={resit}
                style={{ paddingBlockStart: `${(gap ?? 0) * REM_PER_DAY}rem` }}
                className={`relative border-s-2 ps-3 ${tight ? "border-[var(--red-pen)]" : "border-rule"}`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute -start-[7px] mt-1 size-3 rounded-full border-2 ${
                    red ? "border-[var(--red-pen)]" : resit ? "border-pencil" : "border-ink"
                  } ${resit ? "bg-paper" : red ? "bg-[var(--red-pen)]" : "bg-ink"}`}
                />
                <span className={resit ? "text-ink-soft" : "text-ink"}>{said(sitting)}</span>
                {gap !== undefined && gap > 0 && (
                  <span className="block text-xs text-pencil">
                    {gap === 1 ? t(language, "examGapOne") : t(language, "examGap", { days: gap })}
                  </span>
                )}
                {warning?.kind === "exam-spacing" && (
                  <span className="block text-xs text-[var(--red-pen)]" data-exam-spacing="">
                    {warning.nearbyCount === 1
                      ? t(language, "examSpacingOne", { spacing: period.spacingDays })
                      : t(language, "examSpacing", { spacing: period.spacingDays, count: warning.nearbyCount })}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {period.coursesWithUnknownExams > 0 && (
        <p data-exam-unknown="">
          {period.coursesWithUnknownExams === 1
            ? t(language, "examUnknownOne")
            : t(language, "examUnknown", { count: period.coursesWithUnknownExams })}
        </p>
      )}

      {yearLong.length > 0 && (
        <div className="flex flex-col gap-1" data-exam-year-long="">
          <h3 className="text-xs font-semibold">{t(language, "examYearLongHeading")}</h3>
          <p className="text-xs text-pencil">{t(language, "examYearLongWhy")}</p>
          <ul className="flex flex-col gap-1">
            {yearLong.map((sitting) => (
              <li key={keyOf(sitting)} data-exam-sitting={keyOf(sitting)}>
                {said(sitting)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
