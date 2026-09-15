/**
 * Every UI string goes through translation files, and right-to-left support is
 * mandatory from the first component (docs/design.md, "Language and direction").
 *
 * A real i18n library with lazy-loaded message catalogs is its own ticket; this is the
 * smallest thing that keeps strings out of components in the meantime.
 *
 * Catalog data is not translated here. A Course name arrives from Shoham in both
 * languages and falls back to Hebrew when there is no English one; a Lesson Type arrives
 * as the Hebrew label Shoham printed, and `lessonType.ts` renders the ones we know in
 * English and shows the rest as the Catalog wrote them.
 */
export const LANGUAGES = ["en", "he"] as const;

export type Language = (typeof LANGUAGES)[number];

const english = {
  appName: "BIU CS Planner",
  apiUnreachable: "API unreachable",

  /** The other language, named in itself: the switch says where it takes you. */
  otherLanguage: "עברית",

  timetable: "Timetable",
  academicYear: "{first}-{second}",
  semesterFall: "Semester A",
  semesterSpring: "Semester B",
  semesterSummer: "Summer",

  catalogHeading: "Courses in the catalog",
  catalogSearch: "Search by name or number",
  catalogLoading: "Loading the catalog…",
  catalogEmpty: "No course matches",
  catalogMissing: "No catalog for {year} yet. Import a crawl of Shoham to fill it.",

  hintChoose: "Choose a course to see when its groups meet.",
  hintShowing: "Every group of {course} is on the week. Nothing is picked yet.",
  legendPencil: "option",

  noFixedTime: "No fixed time",
  groupsCount: "{count} groups",

  sunday: "Sunday",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",

  lessonLecture: "Lecture",
  lessonTirgul: "Tirgul",
  lessonLab: "Lab",
  lessonSeminar: "Seminar",
  lessonWorkshop: "Workshop",
  lessonProject: "Project",
  lessonSupport: "Support class",
  lessonGuidance: "Guidance",
  lessonColloquiumRequired: "Colloquium (required)",
  lessonColloquiumElective: "Colloquium (elective)",
  lessonDepartmentHours: "Department hours",
  lessonThesis: "Thesis",
  lessonDissertation: "Dissertation",
  lessonExam: "Exam",
  lessonRegistration: "Registration",
} as const;

export type StringKey = keyof typeof english;

/** Typed against the English keys, so a missing Hebrew string is a compile error. */
const hebrew: Record<StringKey, string> = {
  appName: "מתכנן מדעי המחשב בר־אילן",
  apiUnreachable: "ה-API אינו זמין",

  otherLanguage: "English",

  timetable: "מערכת שעות",
  academicYear: "{first}-{second}",
  semesterFall: "סמסטר א",
  semesterSpring: "סמסטר ב",
  semesterSummer: "קיץ",

  catalogHeading: "קורסים בקטלוג",
  catalogSearch: "חיפוש לפי שם או מספר",
  catalogLoading: "טוען את הקטלוג…",
  catalogEmpty: "אין קורס מתאים",
  catalogMissing: "אין עדיין קטלוג לשנת {year}. ייבאו זחילה משוהם כדי למלא אותו.",

  hintChoose: "בחרו קורס כדי לראות מתי הקבוצות שלו נפגשות.",
  hintShowing: "כל הקבוצות של {course} מוצגות בשבוע. עדיין לא נבחרה אף אחת.",
  legendPencil: "אפשרות",

  noFixedTime: "ללא שעה קבועה",
  groupsCount: "{count} קבוצות",

  sunday: "ראשון",
  monday: "שני",
  tuesday: "שלישי",
  wednesday: "רביעי",
  thursday: "חמישי",
  friday: "שישי",

  lessonLecture: "הרצאה",
  lessonTirgul: "תרגיל",
  lessonLab: "מעבדה",
  lessonSeminar: "סמינריון",
  lessonWorkshop: "סדנה",
  lessonProject: "פרויקט",
  lessonSupport: "תגבור",
  lessonGuidance: "הדרכה",
  lessonColloquiumRequired: "קולוקויום חובה",
  lessonColloquiumElective: "קולוקויום רשות",
  lessonDepartmentHours: "שעות מחלקה",
  lessonThesis: "תיזה",
  lessonDissertation: "דיסרטציה",
  lessonExam: "בחינה",
  lessonRegistration: "רישום",
};

const strings: Record<Language, Record<StringKey, string>> = { en: english, he: hebrew };

export const DIRECTION: Record<Language, "ltr" | "rtl"> = { en: "ltr", he: "rtl" };

/**
 * A literal pattern, never one built from data: a placeholder is `{name}`, and the values
 * that fill it are substituted rather than interpolated into anything executable
 * (docs/design.md, "API and data rules"; ADR-0007).
 */
const PLACEHOLDER = /\{(\w+)\}/g;

export function t(
  language: Language,
  key: StringKey,
  values?: Readonly<Record<string, string | number>>,
): string {
  const template: string = strings[language][key];
  if (values === undefined) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[name];
  return value === undefined ? whole : String(value);
  });
}
