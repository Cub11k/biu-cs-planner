import { useState } from "react";
import { t, type Language, type StringKey } from "../i18n/strings.ts";
import { isUntimedIn, type Semester } from "./catalog.ts";
import { lessonSlot, lessonTypeName } from "./lessonType.ts";
import {
  daysShown,
  formatClock,
  groupKey,
  hourLines,
  hourRange,
  tileBox,
  tileText,
  tilesFor,
  type HourRange,
  type Tile,
  type WeekGroup,
} from "./week.ts";

/** Tall enough that a two-hour Meeting has room for its name and its times. */
const HOUR_PX = 66;

export type WeekGridProps = {
  language: Language;
  semester: Semester;
  /**
   * Every Group on the week: the Variant's Picks, and the Groups of the Course the student
   * is looking at as options. `week.ts` builds the list; this draws it.
   */
  groups: readonly WeekGroup[];
  /** The Groups a Clash touches, by `groupKey`. Red pen, and nothing refused. */
  clashing?: ReadonlySet<string>;
  /** Picking a Group — or, on one already picked, removing that Pick. */
  onPick: (group: WeekGroup) => void;
};

/**
 * One Semester's week.
 *
 * Three of the states docs/design.md, "Visual language" names are drawn here: **pencil**, a
 * dashed outline for an option nobody has taken; **ink**, a solid border with a thick start
 * edge and a tint of the Lesson Type's colour, for a Pick; and **red pen** for a Pick that
 * Clashes. Hatching — time already taken — waits for Blocked Times.
 *
 * The component decides nothing: `week.ts` says which Groups the week shows, which days and
 * hours the grid has, where each block goes and which Groups a Clash touches, and this turns
 * those answers into elements.
 */
export function WeekGrid({
  language,
  semester,
  groups,
  clashing,
  onPick,
}: WeekGridProps): React.JSX.Element {
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);

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
              // the first label would be translated up into the sticky corner cell, which
              // paints over it; it sits under its line instead of astride it
              className={hour === range.startHour ? "hour-label hour-label-first" : "hour-label"}
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
                <GroupTile
                  key={tile.key}
                  tile={tile}
                  range={range}
                  language={language}
                  clashes={clashing?.has(tile.groupKey) ?? false}
                  highlighted={tile.groupKey === highlighted}
                  onHighlight={setHighlighted}
                  onPick={onPick}
                />
              ))}
          </div>
        ))}
      </div>

      {untimed.length > 0 && (
        <div className="untimed flex flex-wrap items-center gap-2 border-t border-rule bg-paper px-3 py-2">
          <span className="text-xs text-pencil">{t(language, "noFixedTime")}</span>
          {untimed.map((group) => (
            <button
              key={groupKey(group)}
              type="button"
              className={tileClass(group, clashing?.has(groupKey(group)) ?? false, false)}
              data-lesson-slot={lessonSlot(group.lessonType)}
              aria-pressed={group.picked}
              onClick={() => onPick(group)}
            >
              <span
                className="tile-name"
                style={{ "--name-lines": 1 } as React.CSSProperties}
              >
                {group.courseName}
              </span>
              <span className="tile-detail">
                {[
                  group.courseNumber,
                  lessonTypeName(group.lessonType, language),
                  group.number,
                ].join(" · ")}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Pencil, ink and red pen, as classes rather than as styles: the colours are tokens in
 * index.css and a component holds no raw colour value (docs/design.md, "Light and dark").
 */
function tileClass(group: WeekGroup, clashes: boolean, highlighted: boolean): string {
  return [
    "tile",
    group.picked ? "is-picked" : undefined,
    clashes ? "is-clashing" : undefined,
    highlighted ? "is-highlighted" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}

function GroupTile({
  tile,
  range,
  language,
  clashes,
  highlighted,
  onHighlight,
  onPick,
}: {
  tile: Tile;
  range: HourRange;
  language: Language;
  clashes: boolean;
  highlighted: boolean;
  onHighlight: (groupKey: string | undefined) => void;
  onPick: (group: WeekGroup) => void;
}): React.JSX.Element {
  const box = tileBox(tile, range, HOUR_PX);
  const text = tileText({
    name: tile.group.courseName,
    courseNumber: tile.group.courseNumber,
    lessonTypeName: lessonTypeName(tile.group.lessonType, language),
    groupNumber: tile.group.number,
    startMinutes: tile.startMinutes,
    endMinutes: tile.endMinutes,
    heightPx: box.heightPx,
  });

  return (
    <button
      type="button"
      className={tileClass(tile.group, clashes, highlighted)}
      data-lesson-slot={lessonSlot(tile.group.lessonType)}
      // a toggle, because clicking a Group already picked removes that Pick; "pressed" is
      // what a screen reader says instead of the ink a sighted student sees
      aria-pressed={tile.group.picked}
      style={
        {
          top: box.topPx,
          height: box.heightPx,
          insetInlineStart: `${box.startPercent}%`,
          width: `${box.widthPercent}%`,
          "--name-lines": text.nameLines,
        } as React.CSSProperties
      }
      onClick={() => onPick(tile.group)}
      onMouseEnter={() => onHighlight(tile.groupKey)}
      onMouseLeave={() => onHighlight(undefined)}
      onFocus={() => onHighlight(tile.groupKey)}
      onBlur={() => onHighlight(undefined)}
    >
      <span className="tile-name">{text.name}</span>
      <span className="tile-detail">
        {text.detail}
        {text.times === undefined ? null : (
          <>
            {" · "}
            {/* isolated and left-to-right: the dash between two clock times is bidi-neutral,
                so in Hebrew "15:00–18:00" would otherwise be reordered into "18:00–15:00" */}
            <bdi dir="ltr">{text.times}</bdi>
          </>
        )}
      </span>
    </button>
  );
}
