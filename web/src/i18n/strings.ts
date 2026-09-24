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
  catalogUnreadable: "The catalog for {year} is there, but could not be read:",
  catalogUnauthorized:
    "This page has no launch token. Start the app from a terminal and open the address it prints.",

  warningFileUnreadable: "The catalog file is not a catalog this app can read.",
  warningSchemaTooNew: "The catalog was written by a newer version of the app.",
  warningSchemaUnsupported: "The catalog's schema version is not one this app reads.",
  warningWorkspaceRefused: "The workspace would not read the catalog file.",

  hintChoose: "Choose a course to see when its groups meet, and click one to pick it.",
  hintShowing: "Every group of {course} is on the week. Click one to pick it.",
  legendPencil: "option",
  legendInk: "picked",
  legendClash: "clash",

  pickedLabel: "Picked:",
  picksNone: "Nothing picked yet.",
  picksCount: "{count} groups picked.",
  picksCountOne: "1 group picked.",
  clashesCount: "{count} clashes.",
  clashesCountOne: "1 clash.",
  picksUnreadable: "Your saved picks could not be read, so the week shows none of them.",
  picksNotSaved: "This folder is not a workspace yet, so nothing can be saved in it.",
  picksStale:
    "The file changed since this page read it, so your click was not saved. " +
    "The week is the file as it is now — click again if you still want it.",
  /**
   * A click made before the saved Picks had arrived. It is kept rather than sent on a
   * guess about a file the page has not read, so this says where it went (#111).
   */
  picksHeld: "Your saved picks are still loading. Your click is waiting for them.",
  /**
   * …and the same click when it had to be dropped. It names no cause on purpose: the three
   * are a file that could not be read, a page that cannot reach the server, and a screen
   * now showing another week, and in every one of them the answer beside this sentence
   * already says which. Naming one here made it wrong in the other two.
   */
  picksHeldLost: "Your click was not saved.",

  noFixedTime: "No fixed time",
  groupsCount: "{count} groups",
  groupsCountOne: "1 group",

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
  catalogUnreadable: "הקטלוג לשנת {year} קיים, אך לא ניתן לקרוא אותו:",
  catalogUnauthorized:
    "לדף הזה אין אסימון הפעלה. הפעילו את היישום מהמסוף ופתחו את הכתובת שהוא מדפיס.",

  warningFileUnreadable: "הקובץ אינו קטלוג שהיישום יודע לקרוא.",
  warningSchemaTooNew: "הקטלוג נכתב בגרסה חדשה יותר של היישום.",
  warningSchemaUnsupported: "גרסת הסכימה של הקטלוג אינה נתמכת ביישום הזה.",
  warningWorkspaceRefused: "סביבת העבודה סירבה לקרוא את קובץ הקטלוג.",

  hintChoose: "בחרו קורס כדי לראות מתי הקבוצות שלו נפגשות, ולחצו על קבוצה כדי לבחור אותה.",
  hintShowing: "כל הקבוצות של {course} מוצגות בשבוע. לחצו על קבוצה כדי לבחור אותה.",
  legendPencil: "אפשרות",
  legendInk: "נבחרה",
  legendClash: "התנגשות",

  pickedLabel: "נבחרו:",
  picksNone: "עדיין לא נבחרה אף קבוצה.",
  picksCount: "{count} קבוצות נבחרו.",
  picksCountOne: "קבוצה אחת נבחרה.",
  clashesCount: "{count} התנגשויות.",
  clashesCountOne: "התנגשות אחת.",
  picksUnreadable: "לא ניתן לקרוא את הבחירות השמורות, ולכן הן אינן מוצגות בשבוע.",
  picksNotSaved: "התיקייה הזו אינה עדיין סביבת עבודה, ולכן לא ניתן לשמור בה דבר.",
  picksStale:
    "הקובץ השתנה מאז שהדף קרא אותו, ולכן הלחיצה לא נשמרה. " +
    "השבוע מוצג כפי שהקובץ נראה עכשיו — לחצו שוב אם עדיין תרצו את הבחירה.",
  picksHeld: "הבחירות השמורות עדיין נטענות. הלחיצה שלכם ממתינה להן.",
  picksHeldLost: "הלחיצה שלכם לא נשמרה.",

  noFixedTime: "ללא שעה קבועה",
  groupsCount: "{count} קבוצות",
  groupsCountOne: "קבוצה אחת",

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
