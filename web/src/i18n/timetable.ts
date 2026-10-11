/**
 * The Timetable screen's strings: the Catalog pane, the week and its Picks, Variants, the Tray,
 * Plan Diffs and registration, Blocked Times, and the names of Days and Lesson Types.
 *
 * One of the tables `./strings.ts` composes into one `t()`; a string is added to the file of the
 * screen it is on, in both languages. Hebrew is typed against this file's English keys, so a key
 * missing from either language fails the typecheck.
 */
export const timetableEnglish = {
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

  warningFileUnreadable: "The catalog file is not a catalog this app can read.",
  warningSchemaTooNew: "The catalog was written by a newer version of the app.",
  warningSchemaUnsupported: "The catalog's schema version is not one this app reads.",
  /**
   * Not a Warning: the Workspace refusing the Catalog is a refusal (#149), and the key says so
   * (#357). It sits beside the Catalog Warnings because the screen lists it with them.
   */
  catalogRefusedByWorkspace: "The workspace would not read the catalog file.",

  hintChoose: "Choose a course to see when its groups meet, and click one to pick it.",
  hintShowing: "Every group of {course} is on the week. Click one to pick it.",
  legendPencil: "option",
  legendInk: "picked",
  legendClash: "clash",
  /** Hatching: a Blocked Time, or an option that would Clash if picked (#282). */
  legendHatched: "time taken",
  /** A Pick over a Blocked Time, named by the Blocked Time's own label. */
  clashWithBlocked: "{group} clashes with “{label}”.",

  pickedLabel: "Picked:",
  picksNone: "Nothing picked yet.",
  picksCount: "{count} groups picked.",
  picksCountOne: "1 group picked.",
  clashesCount: "{count} clashes.",
  clashesCountOne: "1 clash.",
  picksUnreadable: "Your saved picks could not be read, so the week shows none of them.",
  /**
   * The folder, not the Picks — which is why this one key in the middle of the Picks block
   * carries no pane prefix. It was `picksNotSaved` until #217, named when a click on a Group
   * was the only thing that could be refused, and all three of the refusal maps in
   * `../timetable/TimetableScreen.tsx` now answer `workspace-not-ready` with it: a Pick, an
   * undo or redo, and a change to a preference. Their comments say why, in as many words —
   * "this folder is not a workspace yet, so nothing can be saved in it" is the whole truth for
   * any of them, which is exactly the property a pane in the key would have contradicted.
   */
  workspaceNotReady: "This folder is not a workspace yet, so nothing can be saved in it.",
  picksStale:
    "The file changed since this page read it, so your click was not saved. " +
    "The week is the file as it is now — click again if you still want it.",
  /** `historyBackupRefused`'s sentence, for a click on a Group. */
  picksBackupRefused:
    "The app could not make a backup of your saved work before changing it, so your click was " +
    "not saved.",
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
  /**
   * An edit made while the page re-reads a file that changed under it (#334): it is held, and sent
   * on what the re-read brings.
   */
  picksHeldForReread: "Reading the file again. Your change will be sent once it has been read.",
  /**
   * A re-read whose answer could not be read, over a week the page had read (#218): the week stays,
   * as the last one read, and this says so.
   */
  picksReadStale:
    "The file could not be read again just now, so this is the week as it was last read. It may be out of date.",
  /** Beside the Blocked Time form when its save did not land; the reason follows it (#324). */
  blockedNotSaved: "Not saved. What you typed is still here.",

  /**
   * The Variant tabs above the week (#281). A Variant's own name is the student's text and is
   * never translated; these are the words around it.
   */
  variantTabs: "Variants",
  variantPrimaryMark: "primary",
  variantNew: "New variant",
  variantDuplicate: "Duplicate",
  variantRename: "Rename",
  variantMakePrimary: "Make primary",
  variantDelete: "Delete",
  variantNameNew: "Name of the new variant",
  variantNameRename: "New name",
  /** What an empty name will become: the server picks the first free letter. */
  variantNamePlaceholder: "Leave empty for the next letter",
  variantSave: "Save",
  variantCancel: "Cancel",
  /** Warnings and never refusals: the edit went through, and the tabs show it. */
  variantNameNotUnique: "Two variants are named “{name}”. Rename one so each tab says which it is.",
  variantPrimaryNotUnique:
    "This timetable does not have exactly one primary variant. Mark the one you register with.",

  /**
   * The Tray (#283): the Courses waiting to be scheduled in the Variant shown. "To schedule" is
   * the prototype's word for it, and says what the column is for rather than naming a container.
   */
  trayHeading: "To schedule",
  trayEmpty: "Nothing to schedule yet. Add a course from the catalog below.",
  /** An empty chip: the Lesson Type is still missing a Group. */
  trayChipMissing: "—",
  trayIncomplete: "incomplete",
  /** A Course this Semester's catalog does not have, so what it needs is not known. */
  trayChipsUnknown: "Not in this semester's catalog, so what it needs is not known.",
  trayRemove: "Remove",
  trayRemoveCourse: "Remove {course} and its picks from this variant",
  trayAdd: "Add",
  trayAddCourse: "Add {course} to the courses to schedule",

  /**
   * Plan Diffs (#296): where the Variant shown and the Plan disagree. A badge on the Tray entry,
   * which offers its "apply to Plan" when pressed, and the same list in the side panel. The badge
   * words are `docs/design.md`'s, with the Semester named where the design said "the other".
   */
  planDiffBadgeAdd: "not in plan",
  planDiffBadgeDrop: "not scheduled",
  planDiffBadgeMove: "offered in {semester}",
  planDiffBadgeMoveHere: "planned in {semester}",
  planDiffBadgeMoveHeld: "offered in {semester}, already planned there",
  planDiffBadgeNotOffered: "not in this year's catalog",
  /** A badge's accessible name: what it says, and which Course it says it of. */
  planDiffBadgeLabel: "{badge}: {course}",
  planDiffApplyAdd: "Add to plan",
  planDiffApplyDrop: "Drop from plan",
  planDiffApplyMove: "Move to {semester} in plan",
  planDiffApplyMoveHere: "Move to this semester in plan",
  planDiffsHeading: "Differences from your plan",
  planDiffSaidAdd: "{course} is in this variant but not in your plan for this semester.",
  planDiffSaidDrop: "{course} is planned for this semester but not scheduled in this variant.",
  planDiffSaidMove: "{course} is planned for this semester, but this year's catalog offers it in {semester}.",
  planDiffSaidMoveHere: "{course} is in this variant, and your plan has it in {semester}.",
  planDiffSaidMoveHeld:
    "{course} is planned for this semester, but this year's catalog offers it in {semester}, where your plan already has it.",
  planDiffSaidNotOffered: "{course} is planned for this semester, but is not in this year's catalog.",
  /** An apply refused because that Plan Diff is no longer there; the screen re-reads. */
  planDiffStale: "That difference is no longer there: your plan or the catalog changed. What is left is shown.",

  /**
   * Marking the Variant a student registered with (#297), and the one confirmation that offers to
   * bring the Plan along. Nothing reaches the Plan unless "apply all" is pressed (ADR-0008).
   */
  variantRegisteredMark: "registered",
  variantMarkRegistered: "Mark registered",
  variantUnmarkRegistered: "Unmark registered",
  variantRegisteredNotUnique:
    "More than one variant of this timetable is marked registered. Mark the one you registered with.",
  registrationHeading: "Mark {name} as the variant you registered with",
  registrationIntro: "Applying all brings your plan in line with this variant:",
  /** A Plan Diff "apply all" would apply, and the apply it is: the sentence, then what it does. */
  registrationApplies: "{said} {apply}.",
  /** A `not-offered` Plan Diff: listed so nothing is hidden, and never applied. */
  registrationNotApplied: "{said} Nothing to apply.",
  registrationRegisters: "Set to registered in your plan: {courses}.",
  registrationSeparator: ", ",
  registrationNothing: "Your plan already says what this variant holds.",
  registrationApplyAll: "Apply all and mark registered",
  registrationOnlyMark: "Only mark registered",
  registrationCancel: "Cancel",
  registrationUnavailable: "What applying all would change could not be read, so only marking is offered.",

  /**
   * Blocked Times (#282): weekly time the student keeps free. A range typed past midnight is
   * stored as two rows, which the hint says so the list showing two is no surprise.
   */
  blockedHeading: "Blocked times",
  blockedNone: "No blocked times. Add work, a commute, anything to keep free.",
  blockedUnlabelled: "(no label)",
  blockedDoesNotAdvance: "keeps no time free",
  blockedEdit: "Edit",
  blockedRemove: "Remove",
  blockedAdd: "Add blocked time",
  blockedCopy: "Copy all to",
  blockedCopyTarget: "Semester to copy the blocked times to",
  blockedDay: "Day",
  blockedStart: "From",
  blockedEnd: "Until",
  blockedLabel: "Label",
  blockedWrapHint: "Until earlier than from runs past midnight, and is kept as two blocked times.",
  blockedSave: "Save",
  blockedCancel: "Cancel",

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

export const timetableHebrew: Record<keyof typeof timetableEnglish, string> = {
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

  warningFileUnreadable: "הקובץ אינו קטלוג שהיישום יודע לקרוא.",
  warningSchemaTooNew: "הקטלוג נכתב בגרסה חדשה יותר של היישום.",
  warningSchemaUnsupported: "גרסת הסכימה של הקטלוג אינה נתמכת ביישום הזה.",
  catalogRefusedByWorkspace: "סביבת העבודה סירבה לקרוא את קובץ הקטלוג.",

  hintChoose: "בחרו קורס כדי לראות מתי הקבוצות שלו נפגשות, ולחצו על קבוצה כדי לבחור אותה.",
  hintShowing: "כל הקבוצות של {course} מוצגות בשבוע. לחצו על קבוצה כדי לבחור אותה.",
  legendPencil: "אפשרות",
  legendInk: "נבחרה",
  legendClash: "התנגשות",
  legendHatched: "זמן תפוס",
  clashWithBlocked: "{group} מתנגשת עם „{label}”.",

  pickedLabel: "נבחרו:",
  picksNone: "עדיין לא נבחרה אף קבוצה.",
  picksCount: "{count} קבוצות נבחרו.",
  picksCountOne: "קבוצה אחת נבחרה.",
  clashesCount: "{count} התנגשויות.",
  clashesCountOne: "התנגשות אחת.",
  picksUnreadable: "לא ניתן לקרוא את הבחירות השמורות, ולכן הן אינן מוצגות בשבוע.",
  workspaceNotReady: "התיקייה הזו אינה עדיין סביבת עבודה, ולכן לא ניתן לשמור בה דבר.",
  picksStale:
    "הקובץ השתנה מאז שהדף קרא אותו, ולכן הלחיצה לא נשמרה. " +
    "השבוע מוצג כפי שהקובץ נראה עכשיו — לחצו שוב אם עדיין תרצו את הבחירה.",
  picksBackupRefused:
    "היישום לא הצליח ליצור גיבוי של העבודה השמורה שלכם לפני שינויה, ולכן הלחיצה לא נשמרה.",
  picksHeld: "הבחירות השמורות עדיין נטענות. הלחיצה שלכם ממתינה להן.",
  picksHeldLost: "הלחיצה שלכם לא נשמרה.",
  blockedNotSaved: "לא נשמר. מה שהקלדתם עדיין כאן.",
  picksHeldForReread: "הקובץ נקרא שוב. השינוי שלכם יישלח מיד לאחר מכן.",
  picksReadStale: "לא ניתן היה לקרוא שוב את הקובץ כרגע, ולכן זה השבוע כפי שנקרא לאחרונה. ייתכן שאינו עדכני.",

  variantTabs: "חלופות",
  variantPrimaryMark: "ראשית",
  variantNew: "חלופה חדשה",
  variantDuplicate: "שכפול",
  variantRename: "שינוי שם",
  variantMakePrimary: "קביעה כראשית",
  variantDelete: "מחיקה",
  variantNameNew: "שם החלופה החדשה",
  variantNameRename: "שם חדש",
  variantNamePlaceholder: "השאירו ריק לאות הבאה",
  variantSave: "שמירה",
  variantCancel: "ביטול",
  variantNameNotUnique: "שתי חלופות נקראות „{name}”. שנו את שמה של אחת מהן כדי שכל לשונית תאמר מהי.",
  variantPrimaryNotUnique: "למערכת השעות הזו אין בדיוק חלופה ראשית אחת. סמנו את זו שאיתה תירשמו.",

  trayHeading: "לשיבוץ",
  trayEmpty: "עדיין אין מה לשבץ. הוסיפו קורס מהקטלוג שלמטה.",
  trayChipMissing: "—",
  trayIncomplete: "חסר",
  trayChipsUnknown: "הקורס אינו בקטלוג של הסמסטר הזה, ולכן לא ידוע מה הוא דורש.",
  trayRemove: "הסרה",
  trayRemoveCourse: "הסרת {course} והבחירות שלו מהחלופה הזו",
  trayAdd: "הוספה",
  trayAddCourse: "הוספת {course} לקורסים לשיבוץ",

  planDiffBadgeAdd: "לא בתוכנית",
  planDiffBadgeDrop: "לא משובץ",
  planDiffBadgeMove: "ניתן ב{semester}",
  planDiffBadgeMoveHere: "מתוכנן ב{semester}",
  planDiffBadgeMoveHeld: "ניתן ב{semester}, וכבר מתוכנן שם",
  planDiffBadgeNotOffered: "לא בקטלוג של השנה",
  planDiffBadgeLabel: "{badge}: {course}",
  planDiffApplyAdd: "הוספה לתוכנית",
  planDiffApplyDrop: "הסרה מהתוכנית",
  planDiffApplyMove: "העברה ל{semester} בתוכנית",
  planDiffApplyMoveHere: "העברה לסמסטר הזה בתוכנית",
  planDiffsHeading: "הבדלים מהתוכנית שלך",
  planDiffSaidAdd: "{course} נמצא בחלופה הזו אך לא בתוכנית שלך לסמסטר הזה.",
  planDiffSaidDrop: "{course} מתוכנן לסמסטר הזה אך לא משובץ בחלופה הזו.",
  planDiffSaidMove: "{course} מתוכנן לסמסטר הזה, אך הקטלוג של השנה מציע אותו ב{semester}.",
  planDiffSaidMoveHere: "{course} נמצא בחלופה הזו, והתוכנית שלך מציבה אותו ב{semester}.",
  planDiffSaidMoveHeld: "{course} מתוכנן לסמסטר הזה, אך הקטלוג של השנה מציע אותו ב{semester}, שם הוא כבר בתוכנית שלך.",
  planDiffSaidNotOffered: "{course} מתוכנן לסמסטר הזה, אך אינו בקטלוג של השנה.",
  planDiffStale: "ההבדל הזה כבר אינו קיים: התוכנית או הקטלוג השתנו. מוצג מה שנותר.",

  variantRegisteredMark: "רשומה",
  variantMarkRegistered: "סימון כרשומה",
  variantUnmarkRegistered: "ביטול סימון רשומה",
  variantRegisteredNotUnique: "יותר מחלופה אחת במערכת השעות הזו מסומנת כרשומה. סמנו את זו שאיתה נרשמתם.",
  registrationHeading: "סימון {name} כחלופה שאיתה נרשמת",
  registrationIntro: "החלת הכול תתאים את התוכנית שלך לחלופה הזו:",
  registrationApplies: "{said} {apply}.",
  registrationNotApplied: "{said} אין מה להחיל.",
  registrationRegisters: "יסומנו כרשומים בתוכנית שלך: {courses}.",
  registrationSeparator: ", ",
  registrationNothing: "התוכנית שלך כבר תואמת את מה שבחלופה הזו.",
  registrationApplyAll: "החלת הכול וסימון כרשומה",
  registrationOnlyMark: "סימון כרשומה בלבד",
  registrationCancel: "ביטול",
  registrationUnavailable: "לא ניתן היה לקרוא מה תשנה החלת הכול, ולכן מוצע סימון בלבד.",

  blockedHeading: "זמנים חסומים",
  blockedNone: "אין זמנים חסומים. הוסיפו עבודה, נסיעה, כל מה שצריך להשאיר פנוי.",
  blockedUnlabelled: "(ללא תווית)",
  blockedDoesNotAdvance: "אינו שומר זמן פנוי",
  blockedEdit: "עריכה",
  blockedRemove: "הסרה",
  blockedAdd: "הוספת זמן חסום",
  blockedCopy: "העתקת הכול אל",
  blockedCopyTarget: "הסמסטר שאליו יועתקו הזמנים החסומים",
  blockedDay: "יום",
  blockedStart: "משעה",
  blockedEnd: "עד שעה",
  blockedLabel: "תווית",
  blockedWrapHint: "שעת סיום מוקדמת משעת ההתחלה עוברת את חצות, ונשמרת כשני זמנים חסומים.",
  blockedSave: "שמירה",
  blockedCancel: "ביטול",

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
