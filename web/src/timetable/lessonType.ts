/**
 * A Lesson Type is the label Shoham printed on a Group, so it arrives as free Hebrew text
 * and the set is open (CONTEXT.md, "Lesson Type"). Two things are read off it here, and
 * both fall back rather than fail on a label nobody has seen before.
 */
import { t, type Language, type StringKey } from "../i18n/strings.ts";

/**
 * The colour slot a tile paints itself in. Four, as the prototype settled: the three
 * Lesson Types a CS student meets every week, and one for all the rest. The colours
 * themselves are tokens in index.css and appear nowhere in a component.
 */
export const LESSON_SLOTS = ["lecture", "tirgul", "lab", "other"] as const;

export type LessonSlot = (typeof LESSON_SLOTS)[number];

const SLOTS: Readonly<Record<string, LessonSlot>> = {
  הרצאה: "lecture",
  תרגיל: "tirgul",
  מעבדה: "lab",
};

/** Labels seen in a real Raw Crawl of the CS department; anything else shows as it came. */
const LABELS: Readonly<Record<string, StringKey>> = {
  הרצאה: "lessonLecture",
  תרגיל: "lessonTirgul",
  מעבדה: "lessonLab",
  סמינריון: "lessonSeminar",
  סדנה: "lessonWorkshop",
  פרויקט: "lessonProject",
  תגבור: "lessonSupport",
  הדרכה: "lessonGuidance",
  "קולוקויום חובה": "lessonColloquiumRequired",
  "קולוקויום רשות": "lessonColloquiumElective",
  "ש.מחלקה": "lessonDepartmentHours",
  תיזה: "lessonThesis",
  דיסרטציה: "lessonDissertation",
  בחינה: "lessonExam",
  רישום: "lessonRegistration",
};

export function lessonSlot(lessonType: string): LessonSlot {
  return SLOTS[lessonType.trim()] ?? "other";
}

/**
 * The Lesson Type as the student should read it. Shoham publishes no English label, so a
 * known one is translated and an unknown one is shown as the Catalog wrote it — the same
 * rule Course names follow, and better than hiding a Group behind a guess.
 */
export function lessonTypeName(lessonType: string, language: Language): string {
  const key = LABELS[lessonType.trim()];
  return key === undefined ? lessonType : t(language, key);
}
