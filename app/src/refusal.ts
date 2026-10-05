import {
  isStateFileName,
  WORKSPACE_LAYOUT,
  type WorkspaceFolder,
  type WorkspaceRefusal,
  type WorkspaceRefusalReason,
  type WorkspaceRefusalSubject,
} from "./workspace.ts";

/**
 * The sentence `app` serves for a Workspace refusal, worded here from the refusal's reason code
 * and subject and from nothing an adapter wrote (#249).
 *
 * **Why `app` words it and not the adapter.** Until #249 the Catalog routes carried the adapter's
 * own message, so "the API exposes domain operations, never file paths" (CLAUDE.md) held only as
 * long as every adapter, and every refusal anyone added to one, remembered to word itself without
 * a path — #216 found the one adapter there is had not. The port now hands a code and a subject
 * drawn from closed sets, and the message stays on the error for a log (#165).
 *
 * **No value the adapter supplies is ever said; only which member of a closed set it picked.**
 * The reason is said only when it is one of the port's, looked up with `Object.hasOwn` so that
 * `"constructor"` does not find a member on the prototype. The subject is used only for its
 * `kind`: a folder of the Workspace Layout or the Workspace as a whole is said as such, and a
 * subject naming a file — a Catalog, a State File, a snapshot — is said as **`asked`**, the ref
 * the caller handed the port. A name that passes `isStateFileName` is still free text, so an
 * adapter refusing a Catalog read "about" a State File it named itself would otherwise have a
 * channel one sentence long.
 *
 * **The refusal is read once, field by field, and never trusted to hold still.** The type says
 * it is plain data, and a cast or an adapter written against an older port gets past a type, which
 * is the hole this closes. A subject with getters could answer a check with one value and the
 * sentence with another — measured on PR #280, where a year read three times said a path on its
 * third read — so each field is read exactly once into a local, and a read that throws is the
 * fallback sentence and not a crashed request: a refusal is a Warning, never a 500.
 *
 * **`asked` is checked too**, because it can be the very value a refusal is about: `not-a-name`
 * is raised for a name that is a path. A State File's name is said only when `isStateFileName`
 * passes it and a year or a moment only when it is a whole number; otherwise it is described
 * without its value.
 */
export function wordRefusal(
  refusal: WorkspaceRefusal | undefined,
  asked: WorkspaceRefusalSubject,
): string {
  let reason: unknown;
  let kind: unknown;
  let folder: unknown;
  try {
    const fields: unknown = refusal;
    if (typeof fields === "object" && fields !== null) {
      reason = (fields as { reason?: unknown }).reason;
      const subject = (fields as { subject?: unknown }).subject;
      if (typeof subject === "object" && subject !== null) {
        kind = (subject as { kind?: unknown }).kind;
        if (kind === "folder") folder = (subject as { folder?: unknown }).folder;
      }
    }
  } catch {
    // whatever was read before the throw stands; a subject that could not be read is said as
    // the file asked about, which is what any subject naming a file is said as anyway
    kind = undefined;
    folder = undefined;
  }

  const because =
    typeof reason === "string" && Object.hasOwn(BECAUSE, reason)
      ? BECAUSE[reason as WorkspaceRefusalReason]
      : "the Workspace would not touch it";
  return `refusing ${aboutSubject(kind, folder, asked)}: ${because}`;
}

/**
 * What follows the colon, one per reason. Total over the union, so a new reason needs words
 * before it compiles.
 */
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
  "not-a-catalog": "only a Catalog is read or written whole, and this is not one",
  "mixed-snapshots": "snapshots are pruned one State File at a time",
};

const FOLDER: Record<WorkspaceFolder, string> = {
  catalogs: "the folder holding the Workspace's Catalogs",
  requirements: "the folder holding the Workspace's Requirements Files",
  backups: "the folder holding the Workspace's snapshots",
};

/** The subject in words: its kind picks one of these, and only `asked` supplies a value. */
function aboutSubject(kind: unknown, folder: unknown, asked: WorkspaceRefusalSubject): string {
  if (kind === "workspace") return "the Workspace";
  if (kind === "folder") {
    return typeof folder === "string" && (WORKSPACE_LAYOUT as string[]).includes(folder)
      ? FOLDER[folder as WorkspaceFolder]
      : "a folder of the Workspace";
  }
  return aboutAsked(asked);
}

/** Whether a value is a moment `Date` can spell: a whole number inside its range. */
const isMoment = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Math.abs(value as number) <= 8.64e15;

const stateFile = (name: unknown): string =>
  typeof name === "string" && isStateFileName(name)
    ? `the State File ${JSON.stringify(name)}`
    : "a State File whose name is not one";

/** The ref the caller asked about, with each value said only once it has been checked. */
function aboutAsked(asked: WorkspaceRefusalSubject): string {
  switch (asked.kind) {
    case "catalog":
      return Number.isSafeInteger(asked.academicYear)
        ? `the Catalog for the Academic Year ${String(asked.academicYear)}`
        : "a Catalog whose Academic Year is not one";
    case "state":
      return stateFile(asked.name);
    case "backup":
      return (
        `the snapshot of ${stateFile(asked.name)} ` +
        (isMoment(asked.takenAt)
          ? `taken at ${new Date(asked.takenAt).toISOString()}`
          : "taken at a moment that is not one")
      );
    case "folder":
      return aboutSubject("folder", asked.folder, asked);
    case "workspace":
      return "the Workspace";
  }
}
