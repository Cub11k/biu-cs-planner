import { useState } from "react";
import { t, type Language, type StringKey } from "../i18n/strings.ts";
import { courseName, isUntimedIn, type Offering, type Semester } from "./catalog.ts";
import { lessonSlot, lessonTypeName } from "./lessonType.ts";
import {
  daysShown,
  formatClock,
  hourLines,
  hourRange,
  tileBox,
  tileText,
  tilesFor,
  type HourRange,
  type Tile,
} from "./week.ts";

/** Tall enough that a two-hour Meeting has room for its name and its times. */
const HOUR_PX = 66;

export type WeekGridProps = {
  language: Language;
  semester: Semester;
  /** The Course whose Groups are on the week; none until one is chosen. */
  offering: Offering | undefined;
};

/**
 * One Semester's week. Every block on it is pencil — a dashed outline on the surface
 * colour, an option nobody has taken — because there is no Variant and no Pick yet
 * (docs/design.md, "Visual language").
 *
 * The component decides nothing: `week.ts` says which days and hours the grid has and
 * where each block goes, and this turns those answers into elements.
 */
export function WeekGrid({ language, semester, offering }: WeekGridProps): React.JSX.Element {
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);

  const groups = offering?.groups ?? [];
  const tiles = tilesFor(groups, semester);
  const days = daysShown(tiles);
  const range = hourRange(tiles);
  const columnHeight = (range.endHour - range.startHour) * HOUR_PX;
  const untimed = groups.filter((group) => isUntimedIn(group, semester));

  const grid = {
    gridTemplateColumns: `3.25rem repeat(${days.length}, minmax(0, 1fr))`,
    "--hour": `${HOUR_PX}px`,
  } as React.CSSProperties;

  return (
    <>
      <div className="week" style={grid}>
        <div className="week-corner" />
        {days.map((day) => (
          <div key={day} className="week-head">
            {t(language, day satisfies StringKey)}
          </div>
        ))}

        <div className="hour-gutter" style={{ height: columnHeight }}>
          {hourLines(range).map((hour) => (
            <span
              key={hour}
              className="hour-label"
              style={{ top: (hour - range.startHour) * HOUR_PX }}
            >
              {formatClock(hour * 60)}
            </span>
          ))}
        </div>

        {days.map((day) => (
          <div key={day} className="day-column" style={{ height: columnHeight }}>
            {tiles
              .filter((tile) => tile.day === day)
              .map((tile) => (
                <PencilTile
                  key={tile.key}
                  tile={tile}
                  range={range}
                  offering={offering}
                  language={language}
                  highlighted={tile.groupKey === highlighted}
                  onHighlight={setHighlighted}
                />
              ))}
          </div>
        ))}
      </div>

      {untimed.length > 0 && (
        <div className="untimed flex flex-wrap items-center gap-2 border-t border-rule bg-paper px-3 py-2">
          <span className="text-xs text-pencil">{t(language, "noFixedTime")}</span>
          {untimed.map((group) => (
            <div
              key={`${group.lessonType}|${group.number}`}
              className="tile"
              data-lesson-slot={lessonSlot(group.lessonType)}
            >
              <div className="tile-name" style={{ "--name-lines": 1 } as React.CSSProperties}>
                {offering === undefined ? "" : courseName(offering, language)}
              </div>
              <div className="tile-detail">
                {[
                  offering?.courseNumber ?? "",
                  lessonTypeName(group.lessonType, language),
                  group.number,
                ].join(" · ")}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function PencilTile({
  tile,
  range,
  offering,
  language,
  highlighted,
  onHighlight,
}: {
  tile: Tile;
  range: HourRange;
  offering: Offering | undefined;
  language: Language;
  highlighted: boolean;
  onHighlight: (groupKey: string | undefined) => void;
}): React.JSX.Element {
  const box = tileBox(tile, range, HOUR_PX);
  const text = tileText({
    name: offering === undefined ? "" : courseName(offering, language),
    courseNumber: offering?.courseNumber ?? "",
    lessonTypeName: lessonTypeName(tile.group.lessonType, language),
    groupNumber: tile.group.number,
    startMinutes: tile.startMinutes,
    endMinutes: tile.endMinutes,
    heightPx: box.heightPx,
  });

  return (
    <div
      className={`tile${highlighted ? " is-highlighted" : ""}`}
      data-lesson-slot={lessonSlot(tile.group.lessonType)}
      tabIndex={0}
      style={
        {
          top: box.topPx,
          height: box.heightPx,
          insetInlineStart: `${box.startPercent}%`,
          width: `${box.widthPercent}%`,
          "--name-lines": text.nameLines,
        } as React.CSSProperties
      }
      onMouseEnter={() => onHighlight(tile.groupKey)}
      onMouseLeave={() => onHighlight(undefined)}
      onFocus={() => onHighlight(tile.groupKey)}
      onBlur={() => onHighlight(undefined)}
    >
      <div className="tile-name">{text.name}</div>
      <div className="tile-detail">{text.detail}</div>
    </div>
  );
}
