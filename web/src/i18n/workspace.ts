/**
 * The Workspace screen's strings (#238): its first cut, which is the folder's own state, creating
 * the Workspace Layout, and the State File's backups and restoring one.
 *
 * One of the tables `./strings.ts` composes into one `t()`; a string is added to the file of the
 * screen it is on, in both languages. Hebrew is typed against this file's English keys, so a key
 * missing from either language fails the typecheck.
 *
 * **None of these is a sentence another screen already has, on purpose** (`docs/design.md`,
 * "Backups", "Sentences the Workspace screen must not inherit"). The reason words are shared across
 * routes; the sentences are not. `workspace-refused` on the Timetable is Picks that could not be
 * read, and `backup-refused` on every other screen is a change of the student's own that was not
 * saved — here the first is a folder and the second is a restore.
 */
export const workspaceEnglish = {
  workspace: "Workspace",
  workspaceStatusLoading: "Reading the workspace folder…",
  /** The Workspace Layout is not all there; `{folders}` are its folder names, which are not translated. */
  workspaceMissing: "This folder is not a workspace yet. Missing: {folders}.",
  /** A name the Workspace Layout needs is held by a plain file (#243), which creating cannot fix. */
  workspaceNotAFolder: "These are files where the workspace needs folders: {folders}. Move or rename them first.",
  workspaceCreate: "Create the workspace folders",
  workspaceCreated: "The workspace folders were created.",
  /**
   * `POST /api/workspace`'s `workspace-refused`, worded on PR #150 and carried on #67 and #238. "May"
   * because the errno does not travel, and no "nothing was changed", because a create is not
   * transactional and may have made some folders (#166).
   */
  workspaceCreateRefused:
    "The app could not create its folders here. Check the folder it was started in — something may already be using one of those names, or the app may not be allowed to write in it.",
  workspaceCreateNotDone: "The workspace folders were not created.",
  workspaceAnswerUnreadable: "The answer from the app could not be read, so it is not known whether the folders were created.",

  workspaceBackups: "Backups",
  workspaceBackupsAbout:
    "Each time your work is saved, a copy of what the save replaced is kept. Restoring one puts it back; your settings stay as they are, and Undo takes the restore back.",
  workspaceBackupsLoading: "Reading your backups…",
  workspaceBackupsNone: "No backups yet.",
  /** `GET /api/backups`'s `workspace-refused`: `.backups/` is there and cannot be listed. */
  workspaceBackupsUnreadable: "The backups folder could not be read, so no backups can be listed.",
  workspaceBackupsAnswerUnreadable: "The answer about your backups could not be read.",
  /** The State File could not be read, so there is no revision a restore could be based on. */
  workspaceStateFileUnreadable: "The file your work is saved in could not be read, so no backup can be restored over it.",
  workspaceRestore: "Restore",
  /** The accessible name of one backup's Restore button; `{when}` is the moment it was taken. */
  workspaceRestoreLabel: "Restore the backup from {when}",
  workspaceRestored: "Restored the backup from {when}. Undo puts back what it replaced.",
  workspaceRestoredPartly: "Some of that backup could not be read and was left out.",
  workspaceRestoreUnchanged: "Your work already matches the backup from {when}, so nothing changed.",
  workspaceRestoreStale: "Your work changed elsewhere since this page read it, so the backup was not restored. The page is reading it again.",
  workspaceRestoreFileUnreadable: "The file your work is saved in could not be read, so the backup was not restored.",
  workspaceRestoreRefused: "The workspace would not let the app read that backup or your saved work, so it was not restored.",
  /**
   * The restore's `backup-refused` (#229): a restore is a save, and a save first copies what it
   * replaces; that copy could not be written, so the restore was refused and the work is as it was.
   */
  workspaceRestoreBackupRefused:
    "A copy of your current work could not be kept first, so the backup was not restored and your work is as it was.",
  workspaceRestoreNotFound: "That backup is no longer there. The list is being read again.",
  workspaceRestoreUnreadable: "That backup could not be read as saved work, so it was not restored.",
  workspaceRestoreNotDone: "The backup was not restored.",
  workspaceRestoreAnswerUnreadable:
    "The answer to the restore could not be read, so it may have been made. The page is reading your work again.",
  /** The undo stack's name for a restore, `restore-backup` (`app/src/backups.ts`). */
  editRestoreBackup: "restoring a backup",
} as const;

export const workspaceHebrew: Record<keyof typeof workspaceEnglish, string> = {
  workspace: "סביבת עבודה",
  workspaceStatusLoading: "קורא את תיקיית סביבת העבודה…",
  workspaceMissing: "התיקייה הזו אינה עדיין סביבת עבודה. חסרות: {folders}.",
  workspaceNotAFolder: "אלה קבצים במקום שבו סביבת העבודה צריכה תיקיות: {folders}. העבירו אותם או שנו את שמם קודם.",
  workspaceCreate: "יצירת תיקיות סביבת העבודה",
  workspaceCreated: "תיקיות סביבת העבודה נוצרו.",
  workspaceCreateRefused:
    "לא ניתן היה ליצור את תיקיות האפליקציה כאן. בדקו את התיקייה שממנה הופעלה האפליקציה — ייתכן שאחד מהשמות האלה כבר בשימוש, או שאין לאפליקציה הרשאת כתיבה בה.",
  workspaceCreateNotDone: "תיקיות סביבת העבודה לא נוצרו.",
  workspaceAnswerUnreadable: "לא ניתן היה לקרוא את התשובה מהאפליקציה, ולכן לא ידוע אם התיקיות נוצרו.",

  workspaceBackups: "גיבויים",
  workspaceBackupsAbout:
    "בכל פעם שהעבודה שלך נשמרת, נשמר עותק של מה שהשמירה החליפה. שחזור של עותק מחזיר אותו; ההגדרות שלך נשארות כפי שהן, ו״ביטול״ מבטל את השחזור.",
  workspaceBackupsLoading: "קורא את הגיבויים שלך…",
  workspaceBackupsNone: "אין עדיין גיבויים.",
  workspaceBackupsUnreadable: "לא ניתן היה לקרוא את תיקיית הגיבויים, ולכן אי אפשר להציג גיבויים.",
  workspaceBackupsAnswerUnreadable: "לא ניתן היה לקרוא את התשובה על הגיבויים שלך.",
  workspaceStateFileUnreadable: "לא ניתן היה לקרוא את הקובץ שבו העבודה שלך שמורה, ולכן אי אפשר לשחזר אליו גיבוי.",
  workspaceRestore: "שחזור",
  workspaceRestoreLabel: "שחזור הגיבוי מ-{when}",
  workspaceRestored: "הגיבוי מ-{when} שוחזר. ״ביטול״ מחזיר את מה שהוחלף.",
  workspaceRestoredPartly: "חלק מהגיבוי לא ניתן היה לקריאה והושמט.",
  workspaceRestoreUnchanged: "העבודה שלך כבר זהה לגיבוי מ-{when}, ולכן דבר לא השתנה.",
  workspaceRestoreStale: "העבודה שלך השתנתה במקום אחר מאז שהדף קרא אותה, ולכן הגיבוי לא שוחזר. הדף קורא אותה מחדש.",
  workspaceRestoreFileUnreadable: "לא ניתן היה לקרוא את הקובץ שבו העבודה שלך שמורה, ולכן הגיבוי לא שוחזר.",
  workspaceRestoreRefused: "סביבת העבודה לא אפשרה לאפליקציה לקרוא את הגיבוי או את העבודה השמורה, ולכן הוא לא שוחזר.",
  workspaceRestoreBackupRefused: "לא ניתן היה לשמור קודם עותק של העבודה הנוכחית, ולכן הגיבוי לא שוחזר והעבודה שלך נשארה כפי שהייתה.",
  workspaceRestoreNotFound: "הגיבוי הזה כבר אינו קיים. הרשימה נקראת מחדש.",
  workspaceRestoreUnreadable: "לא ניתן היה לקרוא את הגיבוי הזה כעבודה שמורה, ולכן הוא לא שוחזר.",
  workspaceRestoreNotDone: "הגיבוי לא שוחזר.",
  workspaceRestoreAnswerUnreadable: "לא ניתן היה לקרוא את התשובה לשחזור, ולכן ייתכן שהוא בוצע. הדף קורא את העבודה שלך מחדש.",
  editRestoreBackup: "שחזור גיבוי",
};
