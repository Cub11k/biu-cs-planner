/**
 * Asking the API about the Workspace and sending the Workspace screen's two acts (#238): whether the
 * folder is a Workspace and creating its Workspace Layout, and the State File's backups and putting
 * one back.
 *
 * Beside the screen rather than inside it, as `../plan/plan.ts` is, so every answer the API can give
 * is testable against a fake fetch. The shapes are read off the contract and never redeclared here:
 * `web` reaches the domain through the typed client alone (CLAUDE.md).
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import { askApi, type Transport } from "../body.ts";
import type { ApiClient } from "../changes.ts";

type StatusRoute = ApiClient["api"]["workspace"]["$get"];
type CreateRoute = ApiClient["api"]["workspace"]["$post"];
type BackupsRoute = ApiClient["api"]["backups"]["$get"];
type RestoreRoute = ApiClient["api"]["backups"]["restore"]["$post"];
type SettingsRoute = ApiClient["api"]["settings"]["$get"];

/** Whether the folder is a Workspace, and which parts of the Workspace Layout are missing or not folders. */
export type WorkspaceStatus = Extract<InferResponseType<StatusRoute>, { ready: unknown }>;

export type StatusResult = { kind: "served"; status: WorkspaceStatus } | Transport;

/** Why the Workspace Layout was not created: the one word `POST /api/workspace` refuses with. */
export type CreateRefusal = Extract<InferResponseType<CreateRoute>, { reason: unknown }>["reason"];

export type CreateResult =
  | { kind: "created"; status: WorkspaceStatus }
  | { kind: "refused"; reason: CreateRefusal | undefined }
  | Transport;

/** A served status checks the list it is drawn from: an answer without it is not a status (#275). */
const served = (body: WorkspaceStatus): WorkspaceStatus | undefined =>
  typeof body.ready === "boolean" && Array.isArray(body.missing) ? body : undefined;

/** Whether this folder is a Workspace yet. The route has no refusal arm (`workspaceStatus` in `app`). */
export function fetchWorkspaceStatus(client: ApiClient): Promise<StatusResult> {
  return askApi<StatusResult, unknown, WorkspaceStatus>(() => client.api.workspace.$get(), {
    refused: () => ({ kind: "unreadable-answer" }),
    served: (body) => {
      const status = served(body);
      return status === undefined ? undefined : { kind: "served", status };
    },
  });
}

/** Creates the Workspace Layout, which only the student's own click asks for (docs/design.md, "Storage"). */
export function createWorkspace(client: ApiClient): Promise<CreateResult> {
  return askApi<CreateResult, { reason?: CreateRefusal }, WorkspaceStatus>(() => client.api.workspace.$post(), {
    refused: ({ reason }) => ({ kind: "refused", reason }),
    served: (body) => {
      const status = served(body);
      return status === undefined ? undefined : { kind: "created", status };
    },
  });
}

/** One snapshot of the State File, named by the moment it was taken (ADR-0002). */
export type Snapshot = Extract<InferResponseType<BackupsRoute>, { snapshots: unknown }>["snapshots"][number];

/** Why the backups could not be listed: `.backups/` is there and cannot be read. */
export type ListRefusal = Extract<InferResponseType<BackupsRoute>, { reason: unknown }>["reason"];

/** Why the State File's revision could not be had, so no restore can be based on one. */
export type StateFileRefusal = Extract<InferResponseType<SettingsRoute>, { reason: unknown }>["reason"];

/** Why a restore was not made: every refusal of a save, and the two of the snapshot's own. */
export type RestoreRefusal = Extract<InferResponseType<RestoreRoute>, { reason: unknown }>["reason"];

type ServedRestore = Extract<InferResponseType<RestoreRoute>, { takenAt: unknown }>;

/** The revision of the State File a restore is based on; absent when there is no State File. */
export type BackupsVersion = string | undefined;

export type BackupsResult =
  | {
      kind: "served";
      snapshots: Snapshot[];
      version: BackupsVersion;
      /** The restore this answer is the account of, on a restore's own answer only. */
      restored?: { takenAt: number; moved: boolean; warned: boolean };
    }
  /** The listing was refused. */
  | { kind: "refused"; of: "backups"; reason: ListRefusal | undefined }
  /** The State File could not be read, so there is no revision to restore over. */
  | { kind: "refused"; of: "state-file"; reason: StateFileRefusal | undefined }
  /** The restore was refused, and nothing was written unless the reason says it may have been. */
  | { kind: "refused"; of: "restore"; reason: RestoreRefusal | undefined }
  | Transport;

/**
 * The backups, newest first, and the revision of the State File a restore of one is based on.
 *
 * **Two reads, because the listing carries no revision** and a restore is a save that must carry
 * one (ADR-0013). The revision is the one `GET /api/settings` serves, which reads the State File
 * and nothing else; the settings themselves are not looked at. Asked together, so the screen draws
 * once; a refusal of either is the answer, the listing's first.
 */
export async function fetchBackups(client: ApiClient): Promise<BackupsResult> {
  const [listed, revision] = await Promise.all([
    askApi<BackupsResult | { kind: "listed"; snapshots: Snapshot[] }, { reason?: ListRefusal }, { snapshots: Snapshot[] }>(
      () => client.api.backups.$get(),
      {
        refused: ({ reason }) => ({ kind: "refused", of: "backups", reason }),
        served: (body) => (Array.isArray(body.snapshots) ? { kind: "listed", snapshots: body.snapshots } : undefined),
      },
    ),
    askApi<BackupsResult | { kind: "read"; version: BackupsVersion }, { reason?: StateFileRefusal }, { version?: string }>(
      () => client.api.settings.$get(),
      {
        refused: ({ reason }) => ({ kind: "refused", of: "state-file", reason }),
        served: (body) => ({ kind: "read", version: body.version }),
      },
    ),
  ]);
  if (listed.kind !== "listed") return listed;
  if (revision.kind !== "read") return revision;
  return { kind: "served", snapshots: listed.snapshots, version: revision.version };
}

/**
 * Puts one snapshot back, based on the revision on screen. Its served answer is the listing on
 * screen with the revision the restore wrote — a restore takes a snapshot of its own, which the
 * screen's re-read after it lists.
 */
export function restoreBackup(
  client: ApiClient,
  takenAt: number,
  basedOn: BackupsVersion,
  shown: Snapshot[],
): Promise<BackupsResult> {
  const request = { json: { takenAt, ...(basedOn === undefined ? {} : { basedOn }) } } as InferRequestType<RestoreRoute>;
  return askApi<BackupsResult, { reason?: RestoreRefusal }, ServedRestore>(() => client.api.backups.restore.$post(request), {
    refused: ({ reason }) => ({ kind: "refused", of: "restore", reason }),
    served: (body) =>
      typeof body.version === "string"
        ? {
            kind: "served",
            snapshots: shown,
            version: body.version,
            restored: {
              takenAt: body.takenAt,
              moved: body.kind === "restored",
              warned: Array.isArray(body.warnings) && body.warnings.length > 0,
            },
          }
        : undefined,
  });
}
