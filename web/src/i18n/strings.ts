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
   * The Plan screen (#292): a column per Semester, grouped by Academic Year, and a card per
   * Attempt. A Semester is said as `planSemesterSaid`, from the Semester's own name and the
   * Academic Year's span (`academicYear`).
   */
  plan: "Plan",
  planLoading: "Reading your Plan…",
  planFileUnreadable: "The file your work is saved in could not be read, so your Plan cannot be shown.",
  planStale: "Your Plan changed elsewhere since this page read it, so that change was not made. The page is reading it again.",
  planBackupRefused: "A backup could not be taken before saving, so that change was not made.",
  planNotDone: "That change was not made.",
  planAnswerUnreadable:
    "The answer could not be read, so whether that was saved is not known. The page is reading your Plan again.",
  planNoCohort: "No cohort is chosen, so the Plan starts at your first course. Set your cohort on the Progress screen.",
  planEmpty: "Your Plan has no courses yet. Add one to a semester, or start from the Suggested Layout.",
  planSemesterSaid: "{semester} {year}",
  planSummerShow: "Show summer",
  planSummerHide: "Hide summer",
  planSummerShowOf: "Show summer: {semester}",
  planAddYear: "Show another year",
  planColumnCredits: "{credits} credits",
  planColumnJoin: " · ",
  planColumnUnknown: "without known credits: {count}",
  planCardCredits: "{credits} credits",
  planCardNoCredits: "credits unknown",
  planStatus: "Status",
  planStatusPlanned: "Planned",
  planStatusRegistered: "Registered",
  planStatusPassed: "Passed",
  planStatusFailed: "Failed",
  planStatusExempt: "Exempt",
  planStatusCredited: "Credited",
  planGrade: "Grade",
  planGradeSet: "Set",
  /** The words a pass/fail grade is shown and typed as. */
  planGradePass: "Pass",
  planGradeFail: "Fail",
  planGradeNotAGrade: "“{text}” is not a grade: type a number, {pass} or {fail}, or nothing to clear it.",
  planMoveTo: "Move to",
  planRetake: "Add a retake",
  planRemove: "Remove",
  planAddCourse: "Add a course",
  planAddCourseHint: "Course number or name",
  planAddSubmit: "Add",
  planAddTo: "to",
  planLayoutAction: "New Plan from Suggested Layout",
  planLayoutCreated: "Planned courses the Suggested Layout added: {count}.",
  planLayoutNothing: "The Suggested Layout added nothing: every course in it is already in your Plan.",
  planLayoutSkipped: "Skipped:",
  planLayoutSkippedAttempted: "{course} (already in your Plan)",
  planLayoutSkippedTwice: "{course} (listed twice in the layout)",
  planLayoutCohortNotChosen:
    "Choose your cohort on the Progress screen first: the Suggested Layout is placed relative to when you started.",
  planLayoutProgramNotChosen: "Choose your program on the Progress screen first: the Suggested Layout is your program's.",
  planLayoutFileUnavailable:
    "Your program's Requirements File is not in your Workspace or cannot be read, so there is no Suggested Layout to follow.",
  planLayoutNone: "Your program's Requirements File has no Suggested Layout.",
  planWarnPrerequisite: "Planned before its prerequisite: {courses}.",
  planWarnPrerequisiteGrade: "{course} was passed with {grade}, below the {minGrade} this course requires.",
  planWarnPrerequisiteManual: "A prerequisite to check yourself: {text}",
  planWarnOfferingPattern: "Not given in this semester, by its offering pattern.",
  planWarnYearLongSplit: "A year-long course whose halves are in different academic years.",
  planWarnCreditLoad: "{credits} credits, above your limit of {limit}.",
  planWarnRequirementsMissing: "{file}: even if this Plan holds, these requirements stay unmet: {requirements}.",
  planWarnDeadline: "{name}: to be passed by the end of this semester: {courses}.",
  planWarnDeadlineUnnamed: "A progression deadline",
  planWarnDuplicate: "{course} is in this semester twice.",
  planWarnGradeRange: "The grade {value} is outside 0–100.",
  planWarnGradeNotCompleted: "A grade on a course that has no result yet.",
  planWarnBeforeCohort: "Before your cohort started.",
  planWarnAssuming: "This assumes you pass {courses}.",
  planWarnOther: "Something here needs a look.",

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
  /** The Progress screen (#288). */
  progress: "Progress",
  progressLens: "Show progress as",
  progressLensCompleted: "Completed",
  progressLensProjected: "If my Plan holds",
  progressSatisfied: "Satisfied",
  progressPartial: "Partial",
  progressMissing: "Missing",
  progressLoading: "Reading your progress…",
  progressFileUnreadable: "The file your work is saved in could not be read, so your progress cannot be shown.",
  progressStale:
    "The file your work is saved in changed somewhere else since this page read it, so that change was not saved. The page has been reloaded.",
  progressBackupRefused:
    "That change was not saved: a backup of the file your work is saved in could not be made first.",
  progressNotDone: "That change was not made.",
  progressAnswerUnreadable:
    "The answer could not be read, so whether that was saved is not known. The page is reading your progress again.",
  progressStoppedEarly:
    "The assignment of courses to requirements stopped early, so it may not be the best one.",
  progressProgramMissing: "{file} is not in your Workspace's requirements folder.",
  progressProgramRefused: "{file} could not be read from your Workspace.",
  progressProgramUnreadable: "{file} is not a Requirements File this version can read.",
  progressNoProgram: "You have not chosen your program yet. Choose it to see your progress.",
  progressNoRequirementsFiles:
    "There are no Requirements Files in your Workspace's requirements folder yet.",
  progressChooseProgram: "Program",
  progressChooseTrack: "Track",
  progressNoTrack: "No track",
  progressChoose: "Choose",
  progressCredits: "{counted} of {needed} credits",
  progressMet: "{count} of {needed}",
  progressCapped: "{counted} of at most {max} credits",
  progressTotalCredits: "{credits} credits in all",
  progressTicked: "Done",
  progressPinned: "pinned",
  progressCoursesHeading: "Your courses",
  progressNowhereToPin: "counts toward no requirement here",
  progressPinTo: "Counts toward",
  progressSolverDecides: "Decided for you",
  progressUnpin: "Unpin",
  progressWarnTrackUnknown: "{file} does not define the track {track}, so only its base requirements apply.",
  progressWarnCourseUnknown: "{course} is not a course this program knows.",
  progressWarnCreditsUnknown: "The program does not say how many credits {course} is worth, so it counts as none.",
  progressWarnPinIneffective: "{course} could not count toward {requirement}.",
  progressWarnPinRequirementUnknown: "{course} is pinned to {requirement}, which no program of yours has.",
  progressWarnPinNotAccepted: "{course} is pinned to {requirement}, which cannot take it.",
  progressWarnPinConflict: "{course} is pinned to {requirement}, where another pin already counts it.",
  progressWarnFileMissing: "{file} is not in your Workspace.",
  progressWarnFileUnreadable: "{file} is not a Requirements File this version can read.",
  progressWarnUnlisted: "Your Workspace's requirements folder could not be read.",
  progressWarnPinFileNotChosen: "{course} is pinned in {file}, which is not one of your programs.",
  progressWarnTickFileNotChosen: "{requirement} is ticked in {file}, which is not one of your programs.",
  progressWarnEntryDropped: "Part of the file your work is saved in could not be read and was left out ({at}).",
  progressWarnCohortUnreadable: "Your cohort could not be read from the file your work is saved in; choose it again.",
  progressWarningOther: "Something in your progress could not be worked out.",
  /** The student's Programs and Cohort, changed on the Progress screen (#331). */
  progressProgramsHeading: "Your programs",
  progressRemoveProgram: "Remove",
  progressAddProgram: "Add a second program",
  progressAdd: "Add",
  progressFileNotOffered: "{file} (not a requirements file in your Workspace)",
  progressTrackNotOffered: "{track} (not a track of this program)",
  progressCohort: "Cohort",
  progressCohortIs: "Cohort:",
  progressCohortNone: "not chosen",
  progressCohortSaid: "{semester}, {year}",
  progressCohortYear: "Academic year started",
  progressCohortSemester: "Semester started",
  progressCohortSet: "Set cohort",
  progressCohortClear: "Clear cohort",
  /** "What if I switched Track" on the Progress screen (#289): evaluated, never saved. */
  progressWhatIfStart: "What if I switched?",
  progressWhatIfHeading: "What if",
  progressWhatIfNote: "Nothing here is saved unless you make it your choice.",
  progressWhatIfAdopt: "Make this my choice",
  progressWhatIfLeave: "Back to my progress",
  progressWhatIfSame: "Change a program or track above to see what would change.",
  progressWhatIfSatisfied: "Would become satisfied:",
  progressWhatIfMissing: "Would not be met:",
  progressWhatIfDropped: "Would no longer be required:",
  progressWhatIfNoChange: "No requirement would change.",
  progressWhatIfOtherProgram: "{file} is not one of your programs now, so there is nothing to compare it with.",
  progressWhatIfNotEvaluated: "{file} cannot be read as your program now, so there is nothing to compare it with.",
  progressListSeparator: ", ",
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
    "instead. Nothing else in your saved work was affected.",
  settingsUnreadableNamed:
    "A saved preference could not be read: {setting}. It is showing its default instead, and " +
    "nothing else in your saved work was affected.",
  /** The names of the two preferences, for the Warning above to substitute. */
  settingLanguage: "language",
  settingExamSpacing: "exam spacing",

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
   * in `../timetable/TimetableScreen.tsx` now says one of these two for all four of the
   * screen's 401 sites (#197), so three of the four were reading a key that named a pane the
   * sentence is not about. Both are about this page's Launch Token, which is what they are
   * named after. They sit below the `catalog*` block only because that is where the first of
   * them was written.
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

  warningFileUnreadable: "The catalog file is not a catalog this app can read.",
  warningSchemaTooNew: "The catalog was written by a newer version of the app.",
  warningSchemaUnsupported: "The catalog's schema version is not one this app reads.",
  warningWorkspaceRefused: "The workspace would not read the catalog file.",

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
   * A save that was made and whose revision the Workspace could not hand back readably (#326). It
   * may well have landed, so unlike every other refusal sentence this does not say nothing changed.
   * One sentence for every screen, since it is about the save and not about what was saved.
   */
  saveUnconfirmed:
    "Your change may have been saved, but the app could not confirm it. Check that it is there before making it again.",
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

export type StringKey = keyof typeof english;

/**
 * Every key there is, so a test can walk them. Off the English object rather than written
 * out, because a hand-kept list's failure mode is quietly ceasing to be the list.
 */
export const STRING_KEYS = Object.keys(english) as StringKey[];

/** Typed against the English keys, so a missing Hebrew string is a compile error. */
const hebrew: Record<StringKey, string> = {
  apiUnreachable: "ה-API אינו זמין",

  appName: "מתכנן מדעי המחשב בר־אילן",

  otherLanguage: "English",

  schemeLabel: "ערכת צבעים",
  schemeSystem: "לפי הגדרות המערכת",
  schemeLight: "בהיר",
  schemeDark: "כהה",

  plan: "תוכנית",
  planLoading: "קורא את התוכנית שלך…",
  planFileUnreadable: "לא ניתן היה לקרוא את הקובץ שבו העבודה שלך שמורה, ולכן אי אפשר להציג את התוכנית.",
  planStale: "התוכנית שלך השתנתה במקום אחר מאז שהדף קרא אותה, ולכן השינוי לא בוצע. הדף קורא אותה מחדש.",
  planBackupRefused: "לא ניתן היה לגבות לפני השמירה, ולכן השינוי לא בוצע.",
  planNotDone: "השינוי לא בוצע.",
  planAnswerUnreadable: "לא ניתן היה לקרוא את התשובה, ולכן לא ידוע אם השינוי נשמר. הדף קורא את התוכנית שלך מחדש.",
  planNoCohort: "לא נבחר מחזור, ולכן התוכנית מתחילה בקורס הראשון שלך. אפשר לבחור מחזור במסך ההתקדמות.",
  planEmpty: "אין עדיין קורסים בתוכנית שלך. אפשר להוסיף קורס לסמסטר, או להתחיל מהפריסה המומלצת.",
  planSemesterSaid: "{semester} {year}",
  planSummerShow: "הצגת הקיץ",
  planSummerHide: "הסתרת הקיץ",
  planSummerShowOf: "הצגת הקיץ: {semester}",
  planAddYear: "הצגת שנה נוספת",
  planColumnCredits: "{credits} נקודות זכות",
  planColumnJoin: " · ",
  planColumnUnknown: "ללא נקודות זכות ידועות: {count}",
  planCardCredits: "{credits} נ״ז",
  planCardNoCredits: "נקודות הזכות אינן ידועות",
  planStatus: "מצב",
  planStatusPlanned: "מתוכנן",
  planStatusRegistered: "רשום",
  planStatusPassed: "עבר",
  planStatusFailed: "נכשל",
  planStatusExempt: "פטור",
  planStatusCredited: "הוכר",
  planGrade: "ציון",
  planGradeSet: "קביעה",
  planGradePass: "עובר",
  planGradeFail: "לא עובר",
  planGradeNotAGrade: "„{text}” אינו ציון: יש להקליד מספר, {pass} או {fail}, או להשאיר ריק כדי למחוק.",
  planMoveTo: "העברה אל",
  planRetake: "הוספת חזרה על הקורס",
  planRemove: "הסרה",
  planAddCourse: "הוספת קורס",
  planAddCourseHint: "מספר קורס או שם",
  planAddSubmit: "הוספה",
  planAddTo: "אל",
  planLayoutAction: "תוכנית חדשה מהפריסה המומלצת",
  planLayoutCreated: "קורסים מתוכננים שהפריסה המומלצת הוסיפה: {count}.",
  planLayoutNothing: "הפריסה המומלצת לא הוסיפה דבר: כל הקורסים שבה כבר בתוכנית שלך.",
  planLayoutSkipped: "דולגו:",
  planLayoutSkippedAttempted: "{course} (כבר בתוכנית שלך)",
  planLayoutSkippedTwice: "{course} (מופיע פעמיים בפריסה)",
  planLayoutCohortNotChosen: "יש לבחור קודם מחזור במסך ההתקדמות: הפריסה המומלצת ממוקמת ביחס למועד שבו התחלת.",
  planLayoutProgramNotChosen: "יש לבחור קודם תוכנית לימודים במסך ההתקדמות: הפריסה המומלצת היא של תוכנית הלימודים שלך.",
  planLayoutFileUnavailable: "קובץ הדרישות של תוכנית הלימודים שלך אינו בסביבת העבודה או שאי אפשר לקרוא אותו, ולכן אין פריסה מומלצת לפעול לפיה.",
  planLayoutNone: "בקובץ הדרישות של תוכנית הלימודים שלך אין פריסה מומלצת.",
  planWarnPrerequisite: "מתוכנן לפני דרישת הקדם שלו: {courses}.",
  planWarnPrerequisiteGrade: "{course} עבר בציון {grade}, מתחת ל־{minGrade} שהקורס הזה דורש.",
  planWarnPrerequisiteManual: "דרישת קדם לבדיקה עצמית: {text}",
  planWarnOfferingPattern: "לפי דפוס ההיצע שלו, הקורס אינו ניתן בסמסטר הזה.",
  planWarnYearLongSplit: "קורס שנתי שחציו בשנות לימודים שונות.",
  planWarnCreditLoad: "{credits} נקודות זכות, מעל המגבלה שלך של {limit}.",
  planWarnRequirementsMissing: "{file}: גם אם התוכנית תתקיים, הדרישות האלה יישארו פתוחות: {requirements}.",
  planWarnDeadline: "{name}: יש לעבור עד סוף הסמסטר הזה: {courses}.",
  planWarnDeadlineUnnamed: "מועד התקדמות",
  planWarnDuplicate: "{course} מופיע פעמיים בסמסטר הזה.",
  planWarnGradeRange: "הציון {value} מחוץ לטווח 0–100.",
  planWarnGradeNotCompleted: "ציון לקורס שעוד אין לו תוצאה.",
  planWarnBeforeCohort: "לפני תחילת המחזור שלך.",
  planWarnAssuming: "בהנחה ש־{courses} יעברו בהצלחה.",
  planWarnOther: "משהו כאן דורש בדיקה.",

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
  progress: "התקדמות",
  progressLens: "הצג התקדמות לפי",
  progressLensCompleted: "מה שהושלם",
  progressLensProjected: "אם התוכנית שלי תתקיים",
  progressSatisfied: "הושלם",
  progressPartial: "חלקי",
  progressMissing: "חסר",
  progressLoading: "קורא את ההתקדמות שלך…",
  progressFileUnreadable: "לא ניתן היה לקרוא את הקובץ שבו העבודה שלך שמורה, ולכן לא ניתן להציג את ההתקדמות.",
  progressStale:
    "הקובץ שבו העבודה שלך שמורה השתנה במקום אחר מאז שהדף קרא אותו, ולכן השינוי לא נשמר. הדף נטען מחדש.",
  progressBackupRefused: "השינוי לא נשמר: לא ניתן היה ליצור קודם גיבוי של הקובץ שבו העבודה שלך שמורה.",
  progressNotDone: "השינוי לא בוצע.",
  progressAnswerUnreadable:
    "לא ניתן היה לקרוא את התשובה, ולכן לא ידוע אם השינוי נשמר. הדף קורא את ההתקדמות שלך שוב.",
  progressStoppedEarly: "שיבוץ הקורסים לדרישות נעצר מוקדם, ולכן ייתכן שאינו הטוב ביותר.",
  progressProgramMissing: "{file} אינו נמצא בתיקיית הדרישות של סביבת העבודה שלך.",
  progressProgramRefused: "לא ניתן היה לקרוא את {file} מסביבת העבודה שלך.",
  progressProgramUnreadable: "{file} אינו קובץ דרישות שגרסה זו יודעת לקרוא.",
  progressNoProgram: "עדיין לא בחרת תוכנית לימודים. בחר/י אותה כדי לראות את ההתקדמות שלך.",
  progressNoRequirementsFiles: "עדיין אין קובצי דרישות בתיקיית הדרישות של סביבת העבודה שלך.",
  progressChooseProgram: "תוכנית",
  progressChooseTrack: "מסלול",
  progressNoTrack: "ללא מסלול",
  progressChoose: "בחר",
  progressCredits: "{counted} מתוך {needed} נקודות זכות",
  progressMet: "{count} מתוך {needed}",
  progressCapped: "{counted} מתוך {max} נקודות זכות לכל היותר",
  progressTotalCredits: "{credits} נקודות זכות בסך הכול",
  progressTicked: "בוצע",
  progressPinned: "מוצמד",
  progressCoursesHeading: "הקורסים שלך",
  progressNowhereToPin: "אינו נספר לאף דרישה כאן",
  progressPinTo: "נספר עבור",
  progressSolverDecides: "נקבע עבורך",
  progressUnpin: "בטל הצמדה",
  progressWarnTrackUnknown: "{file} אינו מגדיר את המסלול {track}, ולכן חלות רק דרישות הבסיס שלו.",
  progressWarnCourseUnknown: "{course} אינו קורס שהתוכנית מכירה.",
  progressWarnCreditsUnknown: "התוכנית אינה מציינת כמה נקודות זכות שווה {course}, ולכן הוא נספר כאפס.",
  progressWarnPinIneffective: "{course} לא יכול היה להיספר עבור {requirement}.",
  progressWarnPinRequirementUnknown: "{course} מוצמד ל-{requirement}, שאינה קיימת באף תוכנית שלך.",
  progressWarnPinNotAccepted: "{course} מוצמד ל-{requirement}, שאינה יכולה לקבל אותו.",
  progressWarnPinConflict: "{course} מוצמד ל-{requirement}, אך הצמדה אחרת כבר סופרת אותו.",
  progressWarnFileMissing: "{file} אינו נמצא בסביבת העבודה שלך.",
  progressWarnFileUnreadable: "{file} אינו קובץ דרישות שגרסה זו יודעת לקרוא.",
  progressWarnUnlisted: "לא ניתן היה לקרוא את תיקיית הדרישות של סביבת העבודה שלך.",
  progressWarnPinFileNotChosen: "{course} מוצמד ב-{file}, שאינו אחת התוכניות שלך.",
  progressWarnTickFileNotChosen: "{requirement} מסומנת ב-{file}, שאינו אחת התוכניות שלך.",
  progressWarnEntryDropped: "חלק מהקובץ שבו העבודה שלך שמורה לא ניתן היה לקריאה והושמט ({at}).",
  progressWarnCohortUnreadable: "לא ניתן היה לקרוא את המחזור שלך מהקובץ שבו העבודה שלך שמורה; יש לבחור אותו מחדש.",
  progressWarningOther: "משהו בהתקדמות שלך לא ניתן היה לחישוב.",
  /** The student's Programs and Cohort, changed on the Progress screen (#331). */
  progressProgramsHeading: "התוכניות שלך",
  progressRemoveProgram: "הסר",
  progressAddProgram: "הוסף תוכנית שנייה",
  progressAdd: "הוסף",
  progressFileNotOffered: "{file} (אינו קובץ דרישות בסביבת העבודה שלך)",
  progressTrackNotOffered: "{track} (אינו מסלול של תוכנית זו)",
  progressCohort: "מחזור",
  progressCohortIs: "מחזור:",
  progressCohortNone: "לא נבחר",
  progressCohortSaid: "{semester}, {year}",
  progressCohortYear: "שנת הלימודים שבה התחלת",
  progressCohortSemester: "הסמסטר שבו התחלת",
  progressCohortSet: "קבע מחזור",
  progressCohortClear: "נקה מחזור",
  /** "What if I switched Track" on the Progress screen (#289): evaluated, never saved. */
  progressWhatIfStart: "מה אם הייתי עובר/ת?",
  progressWhatIfHeading: "מה אם",
  progressWhatIfNote: "דבר כאן אינו נשמר אלא אם תבחר/י בו.",
  progressWhatIfAdopt: "בחר בזה",
  progressWhatIfLeave: "חזרה להתקדמות שלי",
  progressWhatIfSame: "שנה/י תוכנית או מסלול למעלה כדי לראות מה ישתנה.",
  progressWhatIfSatisfied: "יושלמו:",
  progressWhatIfMissing: "לא יתקיימו:",
  progressWhatIfDropped: "לא יידרשו עוד:",
  progressWhatIfNoChange: "אף דרישה לא תשתנה.",
  progressWhatIfOtherProgram: "{file} אינו אחת התוכניות שלך כעת, ולכן אין למה להשוות אותו.",
  progressWhatIfNotEvaluated: "לא ניתן לקרוא כעת את {file} כתוכנית שלך, ולכן אין למה להשוות אותו.",
  progressListSeparator: ", ",
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
    "לא ניתן היה לקרוא חלק מההעדפות השמורות שלכם, ולכן הן מוצגות כברירת המחדל. " +
    "שאר העבודה השמורה לא נפגעה.",
  settingsUnreadableNamed:
    "לא ניתן היה לקרוא העדפה שמורה: {setting}. היא מוצגת כברירת המחדל, " +
    "ושאר העבודה השמורה לא נפגעה.",
  settingLanguage: "שפה",
  settingExamSpacing: "מרווח בין בחינות",

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

  warningFileUnreadable: "הקובץ אינו קטלוג שהיישום יודע לקרוא.",
  warningSchemaTooNew: "הקטלוג נכתב בגרסה חדשה יותר של היישום.",
  warningSchemaUnsupported: "גרסת הסכימה של הקטלוג אינה נתמכת ביישום הזה.",
  warningWorkspaceRefused: "סביבת העבודה סירבה לקרוא את קובץ הקטלוג.",

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

  saveUnconfirmed: "ייתכן שהשינוי נשמר, אך היישום לא הצליח לאשר זאת. בדקו שהוא מופיע לפני שתבצעו אותו שוב.",
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
