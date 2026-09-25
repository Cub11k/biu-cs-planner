import { WorkspaceRefusedError, type Workspace, type WorkspaceStatus } from "./workspace.ts";

/**
 * What the app knows about the folder before it touches it. Reading the status never
 * writes: on first run the student is offered the layout and nothing is created until
 * they accept (docs/design.md, "Storage").
 *
 * **No refusal arm, and this is the argument that it needs none** (#141's fourth point).
 * Every filesystem call behind `status` in `server/src/workspace.fs.ts` is already answered
 * rather than raised: `missingFolders` asks `usableFolder` for each part of the layout, that
 * asks `usablePath`, and that reaches the disk only through `realPathOrAbsent`, whose whole
 * body is a `try` returning `undefined` on anything. A part it cannot resolve — for want of a
 * file, a mode bit or a symlink loop alike — is reported *missing*, which is a status and not
 * a failure. `app/src/workspace.memory.ts` filters an array. So the layout probe this shares
 * with `createWorkspace` cannot refuse on the reading side, and the hole #141 was filed for is
 * on the writing side only.
 *
 * That is an argument about the two adapters there are, not a promise the port makes: `status`
 * in `./workspace.ts` documents no refusal, so it documents no absence of one either. Giving
 * this a refusal arm anyway would add a branch no test can enter honestly, and would answer a
 * *read* of the status with "the Workspace refused", which is a sentence about a write. If the
 * port grows the promise in writing, this comment is what should point at it.
 */
export async function workspaceStatus(workspace: Workspace): Promise<WorkspaceStatus> {
  return workspace.status();
}

/**
 * Why the layout was not created. One reason, because the port makes one refusal here:
 * `create` turns everything the filesystem can answer `mkdir` with into a single
 * `WorkspaceRefusedError` naming the folder it got stuck on.
 *
 * **The same word `app/src/catalog.ts` and `app/src/edit.ts` use for the same caught class**,
 * rather than a reason of this use case's own. `server/src/api.ts` already answers
 * `workspace-refused` with a named 409, and a second word for one class is a second thing
 * every reader has to know about this port. What differs between the three is the request,
 * which the page made and therefore already knows: this reason reaches it only as the answer
 * to a create.
 */
export type CreateRefusal = "workspace-refused";

/**
 * What creating the layout did. Shaped as `app/src/edit.ts`'s `EditOutcome` is — a `kind`, and
 * a `reason` when refused — rather than as a third spelling: `server/src/api.ts` reads
 * `result.kind === "refused"` on three routes already, so this route joins them instead of
 * teaching the file a fourth discriminant (#141).
 *
 * `status` rides on the success arm so the route answers exactly what it answered before — a
 * created Workspace is still `{ ready: true, missing: [] }` on the wire — and no caller has to
 * ask again for what the create just established.
 *
 * **No `warnings`**, unlike `EditOutcome`: those come from parsing a file that was read, and a
 * create reads nothing. An always-empty array would be a field a page must render nothing from.
 */
export type CreateOutcome =
  | { kind: "created"; status: WorkspaceStatus }
  | { kind: "refused"; reason: CreateRefusal };

/**
 * Creates the layout, after the student has accepted it, and **answers** a refusal rather
 * than throwing one.
 *
 * This threw until #141. `create` has named its refusal since #121, and nothing here caught
 * it: it left the route, reached Hono's default handler and became a 500 with no body of this
 * app's own — the one answer this API has no arm for, given to the **first thing a student
 * ever does with the app**. Reachable without contriving anything: one part of the layout
 * standing there as a plain file while another is genuinely missing makes `status` report
 * not-ready, so the student is offered the layout, they accept, and `mkdir` meets the file with
 * `EEXIST`. A read-only folder, a full disk or a mode bit arrive here the same way.
 *
 * **Only `WorkspaceRefusedError` is caught, and everything else still propagates.** A blanket
 * catch would report a bug in this app as a fact about the student's folder, which is #111's
 * lesson from the other side: the refusal must not claim the app knows something it does not.
 *
 * And what it does claim is deliberately thin. The adapter knows which folder it got stuck on
 * and the errno it got, and neither travels: the errno stays on the error's `cause`, where a
 * log can reach it and a response cannot, and the folder is in a sentence written for a
 * maintainer. So the student is told that the layout could not be created and to look at the
 * folder — not *why*, because from `EEXIST` alone the app cannot tell something in the way from
 * a permission it lacks, and naming the wrong one sends them to fix what is not broken.
 */
export async function createWorkspace(workspace: Workspace): Promise<CreateOutcome> {
  try {
    await workspace.create();
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      return { kind: "refused", reason: "workspace-refused" };
    }
    throw error;
  }
  return { kind: "created", status: await workspace.status() };
}
