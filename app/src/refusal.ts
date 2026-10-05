import {
  isStateFileName,
  WORKSPACE_LAYOUT,
  type WorkspaceFolder,
  type WorkspaceRefusal,
  type WorkspaceRefusalReason,
  type WorkspaceRefusalSubject,
} from "./workspace.ts";

/**
 * The sentence `app` serves for a Workspace refusal, worded here from the refusal's reason code and
 * subject and from nothing an adapter wrote (#249).
 *
 * **Why `app` words it and not the adapter.** Until #249 the Catalog routes carried the adapter's
 * own message, so "the API exposes domain operations, never file paths" (CLAUDE.md) held only as
 * long as every adapter, and every refusal anyone added to one, remembered to word itself without
 * a path — #216 found the one adapter there is had not. The port now hands a code and a subject
 * drawn from closed sets, and the message stays on the error for a log (#165).
 *
 * **Every value is checked before it is said, and the shape is not trusted either.** The subject
 * carries what a caller named, and a refusal is very often *about* a value that is not safe to
 * repeat — `not-a-name` is raised for a name that is a path. So a State File's name is said only
 * when `isStateFileName` passes it, a year or a moment only when it is a whole number, a folder
 * only when it is one of the Workspace Layout's, and a reason only when it is one of the port's;
 * anything else is described without its value. The type says these always hold, and a cast or
 * an adapter written against an older port gets past a type, which is exactly the hole this ticket
 * closes — so the checks are made at runtime, and lookups go through `Object.hasOwn` so that a
 * reason of `"constructor"` does not find one on the prototype.
 *
 * **A ref is said only if it is the one `app` asked about.** A name that passes `isStateFileName`
 * is still free text, and an adapter refusing a Catalog read "about" a State File it named itself
 * would otherwise have a channel one sentence long. So `asked` is the ref the caller handed the
 * port, and a subject naming any other file is replaced by it; a folder or the Workspace as a
 * whole carries nothing but a member of a closed set, and is said as it is. Every value in the
 * sentence is then either the caller's own or one of this module's words.
 */
export function wordRefusal(refusal: WorkspaceRefusal, asked: WorkspaceRefusalSubject): string {
  const shape = (typeof refusal === "object" && refusal !== null ? refusal : {}) as Partial<
    Record<keyof WorkspaceRefusal, unknown>
  >;
  const reason =
    typeof shape.reason === "string" && Object.hasOwn(BECAUSE, shape.reason)
      ? BECAUSE[shape.reason as WorkspaceRefusalReason]
      : "the Workspace would not touch it";
  return `refusing ${about(isAboutAFile(shape.subject) && !sameFile(shape.subject, asked) ? asked : shape.subject)}: ${reason}`;
}

/** Whether a subject names one file, which is free text the caller has to have handed in. */
const isAboutAFile = (subject: unknown): boolean => {
  const kind = (subject as { kind?: unknown } | null | undefined)?.kind;
  return kind !== "folder" && kind !== "workspace";
};

/** Whether a subject is the very file `app` asked about: same kind, same name, year or moment. */
const sameFile = (subject: unknown, asked: WorkspaceRefusalSubject): boolean => {
  if (typeof subject !== "object" || subject === null) return false;
  const fields = subject as Record<string, unknown>;
  switch (asked.kind) {
    case "catalog":
      return fields.kind === "catalog" && fields.academicYear === asked.academicYear;
    case "state":
      return fields.kind === "state" && fields.name === asked.name;
    case "backup":
      return (
        fields.kind === "backup" && fields.name === asked.name && fields.takenAt === asked.takenAt
      );
    default:
      return false;
  }
};

/** What follows the colon, one per reason; total, so a new reason needs words before it compiles. */
const BECAUSE: Record<WorkspaceRefusalReason, string> = {
  "outside-workspace": "it resolves outside the Workspace",
  unreadable: "it is there and cannot be read",
  "not-a-folder": "it is there and is not a folder",
  unwritable: "it could not be written",
  "not-a-workspace": "the Workspace Layout is not there to write into",
  "not-created": "it could not be made",
  "not-json": "it is not a kind of file a Workspace holds",
  "not-a-name": "a State File's name is a name, never a path",
  "not-a-year": "an Academic Year is a whole number",
  "not-a-moment": "a snapshot's moment is a whole number of milliseconds",
  "not-a-catalog": "a State File is read and saved only with the revision a guarded save needs",
  "mixed-snapshots": "snapshots are pruned one State File at a time",
};

const FOLDER: Record<WorkspaceFolder, string> = {
  catalogs: "the folder holding the Workspace's Catalogs",
  requirements: "the folder holding the Workspace's Requirements Files",
  backups: "the folder holding the Workspace's snapshots",
};

/** Whether a value is a moment `Date` can spell: a whole number inside its range. */
const isMoment = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Math.abs(value as number) <= 8.64e15;

const stateFile = (name: unknown): string =>
  typeof name === "string" && isStateFileName(name)
    ? `the State File ${JSON.stringify(name)}`
    : "a State File whose name is not one";

function about(subject: unknown): string {
  const fields = (typeof subject === "object" && subject !== null ? subject : {}) as Record<
    string,
    unknown
  >;
  switch (fields.kind) {
    case "catalog":
      return Number.isSafeInteger(fields.academicYear)
        ? `the Catalog for the Academic Year ${String(fields.academicYear)}`
        : "a Catalog whose Academic Year is not one";
    case "state":
      return stateFile(fields.name);
    case "backup":
      return (
        `the snapshot of ${stateFile(fields.name)} ` +
        (isMoment(fields.takenAt)
          ? `taken at ${new Date(fields.takenAt).toISOString()}`
          : "taken at a moment that is not one")
      );
    case "folder":
      return typeof fields.folder === "string" &&
        (WORKSPACE_LAYOUT as string[]).includes(fields.folder)
        ? FOLDER[fields.folder as WorkspaceFolder]
        : "a folder of the Workspace";
    default:
      return "the Workspace";
  }
}
