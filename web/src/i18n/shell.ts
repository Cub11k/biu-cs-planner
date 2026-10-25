/**
 * The app shell's strings, and the ones every screen shares: the name, the language and colour
 * scheme switches, the screen navigation, undo and redo with the names of the edits they step
 * over, the preferences, the Launch Token, and the sentences for an answer the page could not
 * read.
 *
 * One of the tables `./strings.ts` composes into one `t()`; a string is added to the file of the
 * screen it is on, in both languages. Hebrew is typed against this file's English keys, so a key
 * missing from either language fails the typecheck.
 */
export const shellEnglish = {
  apiUnreachable: "API unreachable",

  /**
   * The app's name, which the document title follows when the language changes (#310).
   * `index.html` carries the English one as the first-paint title.
   */
  appName: "BIU CS Planner",

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
  /** The labels `app/src/variants.ts` attaches to the Variant edits (#281). */
  editCreateVariant: "creating a variant",
  editDuplicateVariant: "duplicating a variant",
  editRenameVariant: "renaming a variant",
  editDeleteVariant: "deleting a variant",
  editSetPrimaryVariant: "making a variant primary",
  /** The labels `app/src/tray.ts` attaches to the Tray edits (#283). */
  editAddToTray: "adding a course to the tray",
  editRemoveFromTray: "removing a course from the tray",
  /** The labels `app/src/planDiffs.ts` attaches to an "apply to Plan", one per kind (#295). */
  editApplyPlanDiffAdd: "adding a course to the plan",
  editApplyPlanDiffDrop: "dropping a course from the plan",
  editApplyPlanDiffMove: "moving a course in the plan",
  editApplyPlanDiffMoveHere: "moving a course into this semester in the plan",
  /** The labels `app/src/registration.ts` attaches to marking a Variant registered (#297). */
  editMarkVariantRegistered: "marking a variant registered",
  editUnmarkVariantRegistered: "unmarking a registered variant",
  /** The labels `app/src/blockedTimes.ts` attaches to the Blocked Time edits (#282). */
  editAddBlockedTime: "adding a blocked time",
  editReplaceBlockedTime: "changing a blocked time",
  editRemoveBlockedTime: "removing a blocked time",
  editCopyBlockedTimes: "copying blocked times",
  /** The labels `app/src/programs.ts` attaches to the Cohort and Programs edits (#287). */
  editSetCohort: "setting your cohort",
  editSetPrograms: "choosing your programs",

  /** The app shell's navigation between screens (#294): its landmark's name. */
  navScreens: "Screens",
  /** The labels `app/src/progress.ts` attaches to the Progress edits (#288). */
  editPinCourse: "pinning a course",
  editUnpinCourse: "unpinning a course",
  editTickManual: "ticking off a requirement",
  editUntickManual: "unticking a requirement",
  /** The labels `app/src/plan.ts` attaches to the Plan edits (#290, #293). */
  editAddAttempt: "adding a course to the Plan",
  editUpdateAttempt: "changing a course's status or grade",
  editMoveAttempt: "moving a course to another semester",
  editRemoveAttempt: "removing a course from the Plan",
  editPlanFromLayout: "filling the Plan from the Suggested Layout",

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
   * "Your work" and never "your plan": GLOSSARY.md keeps **Plan** for a student's Attempts
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
   * The save could not first make its backup, so it wrote nothing (#229). Three of these, one
   * per place a save is answered — a Pick, an undo or redo, a preference — each ending as that
   * place's other refusals end; the first half is shared and is the whole of what the reason
   * says.
   *
   * **Not `picksUnreadable`, `historyUnreadable` or `settingsFileRefused`**, which is what this
   * used to reach: the
   * State File read perfectly well, and it is the backup that could not be made. Nor does it
   * say why the backup failed, or where backups are kept — the reason carries neither, and a
   * folder named here would be a path in all but spelling (#216).
   */
  historyBackupRefused:
    "The app could not make a backup of your saved work before changing it, so nothing changed.",
  /**
   * A refusal the route named no reason for. The floor, and deliberately the floor: what is
   * true of it is that nothing happened, and naming one of the nine causes would be wrong
   * in the other eight. `picksHeldLost` is the same shape for the same reason.
   */
  historyNotDone: "Nothing changed.",

  /**
   * The student's preferences in the State File (#115, ADR-0014): the language, and the Exam
   * spacing that has no control yet. Three kinds of string, because they are three things:
   *
   * - why a change the student asked for **did not happen** — a preference is a change to a
   *   guarded document, so it can be refused, one sentence per reason the route can give;
   * - that a preference **could not be read** and is showing its default, which is the Warning
   *   `core` has always raised and nothing used to show;
   * - the **name of a preference**, which those Warnings substitute and which is not a sentence.
   *
   * There is nothing here for a change that worked. A language that changed flips the whole
   * document, which is its own account; the Exam spacing has no control to report from.
   *
   * ---
   *
   * The page's own view was stale — the ordinary external-edit guard (#90). Deliberately **not**
   * `picksStale`'s wording: that sentence is about a click on a Group, and a student who used the
   * language switch clicked no Group. It says "your preference was not changed" rather than
   * naming the language, because the same sentence answers a change to either preference.
   */
  settingsStale:
    "This page was showing an older version of your saved work, so your preference was not " +
    "changed. The page has re-read it — try again.",
  /** The State File is there and this build could not read it. Nothing was written. */
  settingsFileUnreadable:
    "The file your preferences are saved in could not be read, so your preference was not changed.",
  /**
   * The Workspace refused the file — and this one must **not** say "could not be read", because
   * `workspace-refused` is raised for a failed *write* as well as a failed read (`app/src/edit.ts`).
   * On a read-only folder or a full disk the read succeeded and the save did not, so naming the
   * read would be a false account of what went wrong. It names both and claims neither.
   *
   * `picksUnreadable` and `historyUnreadable` do name the read for this same reason code, which is
   * the precedent and is wrong in the same way; narrowing that is a change to what the domain
   * reports and belongs in its own ticket.
   */
  settingsFileRefused:
    "The file your preferences are saved in could not be read or written, so your preference was " +
    "not changed.",
  /** `historyBackupRefused`'s sentence, for a preference. */
  settingsBackupRefused:
    "The app could not make a backup of your saved work before changing it, so your preference " +
    "was not changed.",
  /**
   * A refusal the route named no reason for: an answer the contract has and this client cannot
   * provoke. What is true of it is that nothing happened, and naming one of the five causes would
   * be wrong in the other four — `historyNotDone` is the same shape for the same reason.
   */
  settingsNotDone: "Your preference was not changed.",
  /**
   * The State File could not be read at all, so there were no preferences to read out of it and
   * the app is on its defaults. Said because otherwise a Hebrew student's app is in English and
   * the switch is disabled with no account of either — a control that cannot be used and says
   * nothing is the shape of failure #111 is about.
   *
   * It claims only what is true of both ways to get here — an unreadable file and a Workspace
   * that would not read it — and it says "instead of them" rather than "nothing was lost",
   * because whether anything was lost is exactly what could not be established.
   */
  settingsUnread:
    "Your saved preferences could not be read, so the app is showing its defaults instead of " +
    "them.",
  /**
   * …and the same failure on a page that **had** already read them. It must be a second sentence
   * rather than the one above: a student reading Hebrew whose file was corrupted a moment ago is
   * not looking at defaults, and telling them they are would be a claim the page can see is false.
   */
  settingsUnreread:
    "Your saved preferences could not be read just now, so what is on screen is the last version " +
    "this page read.",
  /**
   * `core`'s `settings-unreadable` Warning, which it raises per field it could not read
   * (`core/src/state/file.ts`). A preference silently back at its default is the one a student
   * cannot tell from a preference they never set, so it is said — and the field is named when
   * `core` named one, because "one of them" leaves a student nothing to go and look at.
   *
   * Named after a colon rather than inside the sentence, in both languages: Hebrew would have to
   * agree with the noun substituted, and "שפה" and "מרווח בין בחינות" do not agree the same way.
   */
  /**
   * …and the same Warning with **no** field on it, which `core` raises when the whole `settings`
   * value was not an object — its own comment says "absent `field` means all of them". So this is
   * deliberately plural: it used to read "One of your saved preferences", which was false in the
   * one case it exists for, and is also the fallback for a field this build has no word for.
   */
  settingsUnreadable:
    "Some of your saved preferences could not be read, so they are showing their defaults " +
    "instead, and your next change will save those defaults over them. Nothing else in your " +
    "saved work was affected.",
  settingsUnreadableNamed:
    "A saved preference could not be read: {setting}. It is showing its default instead, and " +
    "your next change will save that default over it. Nothing else in your saved work was " +
    "affected.",
  /** The names of the two preferences, for the Warning above to substitute. */
  settingLanguage: "language",
  settingExamSpacing: "exam spacing",
  /**
   * The two ways the server will not talk to this page, which are **two** states and not one
   * (#126). The remedy is the same — a fresh address from the terminal — and the cause is not:
   * `tokenMissing` is true of a page that was opened without a launch token, and was shown for
   * a page holding one as well, where it is false. A tab that was authenticated when
   * `biu-cs-planner rotate-token` ran holds a retired token, and a student who reads carefully
   * would go looking for a token they can see is present.
   *
   * Neither sentence claims the token *was* rotated: the server refuses a wrong token and a
   * missing one identically, so what is known is that this page sent one and it was refused.
   * Neither names `rotate-token` either — a student who did not run it would be reading about a
   * command that had nothing to do with what happened to them, and the remedy is the same for
   * all of the ways a token stops being accepted.
   *
   * **Neither key names a pane**, and `tokenMissing` was `catalogUnauthorized` until #217.
   * It was named when the Catalog was the only pane with a 401 to report; `unauthorizedSaid`
   * in `../AppShell.tsx` now says one of these two for all four of the Timetable
   * screen's 401 sites (#197), so three of the four were reading a key that named a pane the
   * sentence is not about. Both are about this page's Launch Token, which is what they are
   * named after. They are here, among the strings every screen shares, and not beside the
   * `catalog*` block in `./timetable.ts` where the first of them was written (#366).
   */
  tokenMissing:
    "This page has no launch token. Start the app from a terminal and open the address it prints.",
  tokenRetired:
    "This page's launch token was refused, so it is no longer the one the app accepts. " +
    "Start the app from a terminal and open the address it prints.",

  /**
   * The app answered and this page could not read the answer (#171, #206, #207, #231). Six
   * sentences for one cause, because they appear in six places and the places differ in what
   * they are an account **of**. Three answer for something the student did — a click on a Group,
   * a press of undo or redo, a press of the language switch — and three answer for a pane that
   * simply could not get what it went to read. The rule the three acts follow is #171's: an act
   * gets an account, an ask does not, which is also why the Workspace poll and
   * `fetchAvailability` say nothing.
   *
   * What they claim is exactly what is known: an answer arrived, and it was not one this page
   * can read. **Not** that the file changed, that it was unreadable, or that the Workspace
   * refused — `picksUnreadable` and `catalogUnreadable` each name a cause an unparseable body
   * says nothing about, and the remedy they would send the student to is the wrong one. The two
   * causes that are actually known to produce this are named as the possibilities they are: in
   * development Vite answers an HTML 500 for a server that is not running, and hono answers a
   * plain-text 404 for a path only a newer bundle asks for.
   *
   * **Not one of the six says whether anything was saved**, and `picksAnswerUnreadable` is the
   * one that had to be talked out of it, back when it answered a click as well as the week's
   * read. `read` in `timetable/picks.ts` reaches this arm from the served arm as well as the
   * refused one, so an unparseable **200** to a Pick may perfectly well have landed. A click now
   * has its own sentence, `picksSaveAnswerUnreadable`, which says that whether it was saved is
   * not known (#231); `picksAnswerUnreadable` is left answering for the week's own read, where
   * nothing was attempted at all and what holds is that the week on screen is not known to be
   * the file.
   */
  catalogAnswerUnreadable:
    "The app answered with something this page could not read, so the catalog is not shown. " +
    "The app may not be running, or may be a different version from this page — start it from " +
    "a terminal and open the address it prints.",
  picksAnswerUnreadable:
    "The app answered with something this page could not read, so the week is not your saved " +
    "work. The app may not be running, or may be a different version from this page — start it " +
    "from a terminal and open the address it prints.",
  /**
   * …and the same cause for an undo or a redo (#206), which is the one where the silence was
   * worst: undo is the click a student makes **because something already went wrong**, and
   * ADR-0013 makes it the whole recovery story — there is no inverse to retry.
   *
   * One sentence for both directions, because `read` in `../history.ts` cannot tell them apart
   * and neither can the body it could not read. It says "whether anything changed is not known
   * here" and that is the whole of the claim: this arm is reached from the **200** as well as
   * from the refusal, so an unparseable answer to an undo may perfectly well have undone.
   * `historyNotDone` and `historyUnreadable` both say "nothing changed", which is exactly the
   * false statement #197's reviewers caught in `picksAnswerUnreadable`'s draft, and
   * `historyStale` would name a cause the body says nothing about.
   */
  historyAnswerUnreadable:
    "The app answered with something this page could not read, so whether anything changed is " +
    "not known here. The app may not be running, or may be a different version from this page " +
    "— start it from a terminal and open the address it prints.",
  /**
   * `historyAnswerUnreadable`'s account, for a click on a Group (#231). The click's answer may
   * be a 200 nobody could read, so it says neither that the click was saved nor that it was not:
   * the page re-reads the week, and the week it then draws comes from that re-read.
   * `picksAnswerUnreadable` is the *read's* sentence and says the week is not the saved work,
   * which a week drawn from a re-read that succeeded would contradict.
   */
  picksSaveAnswerUnreadable:
    "The app answered your click with something this page could not read, so whether it was " +
    "saved is not known here. The app may not be running, or may be a different version from " +
    "this page — start it from a terminal and open the address it prints.",
  /**
   * …and the two for the preferences (#207), which had no sentence of their own at all: an answer
   * the page could not read was folded into `settingsNotDone` for a change and into
   * `settingsUnread` or `settingsUnreread` for a read.
   *
   * All three of those are false of it. `settingsNotDone` says the preference was not changed and
   * this arm is reached from the **served** arm, so an unparseable 200 to a `PATCH` may perfectly
   * well have written — the exact sentence #197's reviewers struck out of
   * `picksAnswerUnreadable`'s draft. The other two say the saved preferences could not be read,
   * and nothing in an unparseable body says they were reached at all.
   *
   * Two and not one, because they answer for two different moments, as `settingsStale` and
   * `settingsUnread` already do: one is about a change the student asked for, the other about a
   * page that has no word on their preferences. Neither claims the file was read, written, or
   * left alone.
   */
  settingsAnswerUnreadable:
    "The app answered with something this page could not read, so whether your preference " +
    "changed is not known here. The app may not be running, or may be a different version from " +
    "this page — start it from a terminal and open the address it prints.",
  settingsReadAnswerUnreadable:
    "The app answered with something this page could not read, so what is on screen is not " +
    "known to be your saved preferences. The app may not be running, or may be a different " +
    "version from this page — start it from a terminal and open the address it prints.",

  /**
   * A save that was made and whose revision the Workspace could not hand back readably (#326). It
   * may well have landed, so unlike every other refusal sentence this does not say nothing changed.
   * One sentence for every screen, since it is about the save and not about what was saved.
   */
  saveUnconfirmed:
    "Your change may have been saved, but the app could not confirm it. Check that it is there before making it again.",
} as const;

export const shellHebrew: Record<keyof typeof shellEnglish, string> = {
  apiUnreachable: "ה-API אינו זמין",

  appName: "מתכנן מדעי המחשב בר־אילן",

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
  editCreateVariant: "יצירת חלופה",
  editDuplicateVariant: "שכפול חלופה",
  editRenameVariant: "שינוי שם של חלופה",
  editDeleteVariant: "מחיקת חלופה",
  editSetPrimaryVariant: "קביעת חלופה ראשית",
  editAddToTray: "הוספת קורס לרשימת השיבוץ",
  editRemoveFromTray: "הסרת קורס מרשימת השיבוץ",
  editApplyPlanDiffAdd: "הוספת קורס לתוכנית",
  editApplyPlanDiffDrop: "הסרת קורס מהתוכנית",
  editApplyPlanDiffMove: "העברת קורס בתוכנית",
  editApplyPlanDiffMoveHere: "העברת קורס לסמסטר הזה בתוכנית",
  editMarkVariantRegistered: "סימון חלופה כרשומה",
  editUnmarkVariantRegistered: "ביטול סימון חלופה רשומה",
  editAddBlockedTime: "הוספת זמן חסום",
  editReplaceBlockedTime: "שינוי זמן חסום",
  editRemoveBlockedTime: "הסרת זמן חסום",
  editCopyBlockedTimes: "העתקת זמנים חסומים",
  editSetCohort: "קביעת המחזור שלך",
  editSetPrograms: "בחירת התוכניות שלך",

  navScreens: "מסכים",
  editPinCourse: "הצמדת קורס",
  editUnpinCourse: "ביטול הצמדת קורס",
  editTickManual: "סימון דרישה כבוצעה",
  editUntickManual: "ביטול סימון דרישה",
  editAddAttempt: "הוספת קורס לתוכנית",
  editUpdateAttempt: "שינוי מצב או ציון של קורס",
  editMoveAttempt: "העברת קורס לסמסטר אחר",
  editRemoveAttempt: "הסרת קורס מהתוכנית",
  editPlanFromLayout: "מילוי התוכנית מהפריסה המומלצת",

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
  historyBackupRefused:
    "היישום לא הצליח ליצור גיבוי של העבודה השמורה שלכם לפני שינויה, ולכן לא השתנה דבר.",
  historyNotDone: "לא השתנה דבר.",

  settingsStale:
    "הדף הציג גרסה ישנה יותר של העבודה השמורה, ולכן ההעדפה לא שונתה. " +
    "הדף קרא אותה מחדש — נסו שוב.",
  settingsFileUnreadable:
    "לא ניתן היה לקרוא את הקובץ שבו נשמרות ההעדפות שלכם, ולכן ההעדפה לא שונתה.",
  settingsFileRefused:
    "לא ניתן היה לקרוא או לכתוב את הקובץ שבו נשמרות ההעדפות שלכם, ולכן ההעדפה לא שונתה.",
  settingsBackupRefused:
    "היישום לא הצליח ליצור גיבוי של העבודה השמורה שלכם לפני שינויה, ולכן ההעדפה לא שונתה.",
  settingsNotDone: "ההעדפה לא שונתה.",
  settingsUnread:
    "לא ניתן היה לקרוא את ההעדפות השמורות שלכם, ולכן היישום מציג את ברירות המחדל " +
    "במקומן.",
  settingsUnreread:
    "לא ניתן היה לקרוא את ההעדפות השמורות שלכם כרגע, ולכן מוצגת הגרסה האחרונה שהדף קרא.",
  settingsUnreadable:
    "לא ניתן היה לקרוא חלק מההעדפות השמורות שלכם, ולכן הן מוצגות כברירת המחדל, " +
    "והשינוי הבא שלכם ישמור את ברירות המחדל במקומן. שאר העבודה השמורה לא נפגעה.",
  settingsUnreadableNamed:
    "לא ניתן היה לקרוא העדפה שמורה: {setting}. היא מוצגת כברירת המחדל, " +
    "והשינוי הבא שלכם ישמור את ברירת המחדל במקומה. שאר העבודה השמורה לא נפגעה.",
  settingLanguage: "שפה",
  settingExamSpacing: "מרווח בין בחינות",
  tokenMissing:
    "לדף הזה אין אסימון הפעלה. הפעילו את היישום מהמסוף ופתחו את הכתובת שהוא מדפיס.",
  tokenRetired:
    "אסימון ההפעלה של הדף הזה נדחה, ולכן הוא כבר אינו האסימון שהיישום מקבל. " +
    "הפעילו את היישום מהמסוף ופתחו את הכתובת שהוא מדפיס.",

  catalogAnswerUnreadable:
    "היישום החזיר תשובה שהדף הזה אינו יודע לקרוא, ולכן הקטלוג אינו מוצג. " +
    "ייתכן שהיישום אינו פועל, או שהוא בגרסה אחרת מזו של הדף — הפעילו אותו מהמסוף " +
    "ופתחו את הכתובת שהוא מדפיס.",
  picksAnswerUnreadable:
    "היישום החזיר תשובה שהדף הזה אינו יודע לקרוא, ולכן השבוע אינו משקף את העבודה " +
    "השמורה שלכם. ייתכן שהיישום אינו פועל, או שהוא בגרסה אחרת מזו של הדף — הפעילו " +
    "אותו מהמסוף ופתחו את הכתובת שהוא מדפיס.",
  historyAnswerUnreadable:
    "היישום החזיר תשובה שהדף הזה אינו יודע לקרוא, ולכן לא ידוע כאן אם משהו השתנה. " +
    "ייתכן שהיישום אינו פועל, או שהוא בגרסה אחרת מזו של הדף — הפעילו אותו מהמסוף " +
    "ופתחו את הכתובת שהוא מדפיס.",
  picksSaveAnswerUnreadable:
    "היישום השיב ללחיצה שלכם בתשובה שהדף הזה אינו יודע לקרוא, ולכן לא ידוע כאן אם היא " +
    "נשמרה. ייתכן שהיישום אינו פועל, או שהוא בגרסה אחרת מזו של הדף — הפעילו אותו מהמסוף " +
    "ופתחו את הכתובת שהוא מדפיס.",
  settingsAnswerUnreadable:
    "היישום החזיר תשובה שהדף הזה אינו יודע לקרוא, ולכן לא ידוע כאן אם ההעדפה שלכם שונתה. " +
    "ייתכן שהיישום אינו פועל, או שהוא בגרסה אחרת מזו של הדף — הפעילו אותו מהמסוף " +
    "ופתחו את הכתובת שהוא מדפיס.",
  settingsReadAnswerUnreadable:
    "היישום החזיר תשובה שהדף הזה אינו יודע לקרוא, ולכן לא ידוע אם מה שמוצג הוא ההעדפות " +
    "השמורות שלכם. ייתכן שהיישום אינו פועל, או שהוא בגרסה אחרת מזו של הדף — הפעילו אותו " +
    "מהמסוף ופתחו את הכתובת שהוא מדפיס.",

  saveUnconfirmed: "ייתכן שהשינוי נשמר, אך היישום לא הצליח לאשר זאת. בדקו שהוא מופיע לפני שתבצעו אותו שוב.",
};
