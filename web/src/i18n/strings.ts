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

  /**
   * Light and dark. Three named states and not a two-way switch, because "no choice" is
   * one of them: a student who has chosen dark and changes their mind needs a way to hand
   * the decision back to the operating system, and a toggle offers none (#114).
   */
  schemeLabel: "Colour scheme",
  schemeSystem: "System",
  schemeLight: "Light",
  schemeDark: "Dark",

  /**
   * Undo and redo (#144, ADR-0013). Three kinds of string, and they are three because they
   * are three different things:
   *
   * - the **buttons**, which say what will happen if you press them;
   * - the **name of an edit**, which is what the API's `label` is a key for — `pick-group`
   *   is not a sentence, and "picking a group" is not a button;
   * - the **refusals**, one per reason the route can give.
   */
  undo: "Undo",
  redo: "Redo",
  /** What just happened, with the name of the edit substituted into it. */
  undoneEdit: "Undid {edit}.",
  redoneEdit: "Redid {edit}.",
  /** The two labels `app/src/picks.ts` attaches to an edit, as the name of the thing done. */
  editPickGroup: "picking a group",
  editRemovePick: "removing a pick",
  /**
   * A label this build has no name for. The API types `label` as a `string`, so a server
   * newer than this page can send one — and "an edit" is true of every label there will
   * ever be, where guessing at the key's own text would not be.
   */
  editUnknown: "an edit",

  /**
   * Why the undo or the redo did not happen. The two empty stacks are ordinarily prevented
   * by a disabled button rather than explained here, and are still said because a second
   * tab can empty a stack between this page asking and this page clicking.
   */
  historyNothingToUndo: "There is nothing left to undo.",
  historyNothingToRedo: "There is nothing to redo.",
  /**
   * The file is not there — an unmounted drive, a moved folder. Nothing was written and both
   * stacks are intact, so this must not read like losing anything: it is a folder to go and
   * find, and the undo is waiting for it.
   *
   * "Your work" and never "your plan": CONTEXT.md keeps **Plan** for a student's Attempts
   * across Semesters, and every edit these sentences can be shown for today is a Pick in a
   * Timetable. A State File holds Attempts, Timetables, Pins and settings, so naming one of
   * them would be wrong about the other three — and naming the Plan would tell a student
   * something had happened to a part of their degree that nothing had touched.
   */
  historyFileMissing:
    "The file your work is saved in is not in the workspace folder right now, so nothing " +
    "was changed and nothing was lost. Check that the folder is still where it was — a " +
    "drive that is not mounted looks like this. Undo will work again once the file is back.",
  /**
   * Somebody else wrote the file, so every snapshot predates their change and the history
   * was thrown away rather than silently revert their work (ADR-0013). The student has lost
   * the ability to undo and has to be told, without being alarmed about data that is fine.
   *
   * Deliberately **not** `picksStale`'s wording. That sentence — "the file changed since
   * this page read it" — is a claim about what this page read, and #111 is the ticket about
   * showing it when the page had simply not read the file yet. What is true here is
   * narrower and is all that is said: the file was changed from outside, which the server
   * knows because the revision on disk is not the one it last wrote.
   */
  historyInvalidated:
    "The file your work is saved in was changed by something other than this app, so the " +
    "undo history was dropped rather than put an older version back over that change. " +
    "Nothing you had saved was lost; the steps before now can no longer be undone.",
  /**
   * The page's own view was stale, which is the ordinary external-edit guard and not an
   * invalidation: the stacks survive, and a re-read is all it takes. Says "nothing changed"
   * rather than "nothing was undone", because the same refusal answers a redo.
   */
  historyStale:
    "This page was showing an older version of your saved work, so nothing changed. " +
    "The page has re-read it — try again.",
  /** The file, or the folder, could not be read at all. Nothing was written. */
  historyUnreadable: "The file your work is saved in could not be read, so nothing changed.",
  /**
   * A refusal the route named no reason for. The floor, and deliberately the floor: what is
   * true of it is that nothing happened, and naming one of the eight causes would be wrong
   * in the other seven. `picksHeldLost` is the same shape for the same reason.
   */
  historyNotDone: "Nothing changed.",

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

/**
 * Every key there is, so a test can walk them. Off the English object rather than written
 * out, because a hand-kept list's failure mode is quietly ceasing to be the list.
 */
export const STRING_KEYS = Object.keys(english) as StringKey[];

/** Typed against the English keys, so a missing Hebrew string is a compile error. */
const hebrew: Record<StringKey, string> = {
  appName: "מתכנן מדעי המחשב בר־אילן",
  apiUnreachable: "ה-API אינו זמין",

  otherLanguage: "English",

  schemeLabel: "ערכת צבעים",
  schemeSystem: "לפי הגדרות המערכת",
  schemeLight: "בהיר",
  schemeDark: "כהה",

  undo: "בטל",
  redo: "בצע שוב",
  undoneEdit: "הפעולה בוטלה: {edit}.",
  redoneEdit: "הפעולה בוצעה מחדש: {edit}.",
  editPickGroup: "בחירת קבוצה",
  editRemovePick: "הסרת בחירה",
  editUnknown: "עריכה",

  historyNothingToUndo: "אין עוד מה לבטל.",
  historyNothingToRedo: "אין מה לבצע מחדש.",
  historyFileMissing:
    "הקובץ שבו נשמרת העבודה שלכם אינו נמצא כרגע בתיקיית סביבת העבודה, ולכן לא שונה דבר " +
    "ולא אבד דבר. בדקו שהתיקייה עדיין במקומה — כך זה נראה כאשר כונן אינו מחובר. " +
    "הביטול יעבוד שוב כשהקובץ יחזור.",
  historyInvalidated:
    "הקובץ שבו נשמרת העבודה שלכם שונה בידי משהו אחר מלבד היישום הזה, ולכן היסטוריית " +
    "הביטול הוסרה במקום להחזיר גרסה ישנה מעל אותו שינוי. שום דבר ממה ששמרתם לא אבד; " +
    "את הצעדים שקדמו לכך לא ניתן עוד לבטל.",
  historyStale:
    "הדף הציג גרסה ישנה יותר של העבודה השמורה, ולכן לא השתנה דבר. " +
    "הדף קרא את הקובץ מחדש — נסו שוב.",
  historyUnreadable: "לא ניתן היה לקרוא את הקובץ שבו נשמרת העבודה שלכם, ולכן לא השתנה דבר.",
  historyNotDone: "לא השתנה דבר.",

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
