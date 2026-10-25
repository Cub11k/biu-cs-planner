import { expect, it } from "vitest";
import { createApiClient } from "../api.ts";
import { createWorkspace, fetchBackups, fetchWorkspaceStatus, restoreBackup } from "./workspace.ts";

/**
 * The half of the Workspace screen that lives in `web` without a browser (#238): what the typed
 * client sends and makes of every answer.
 */
const TOKEN = "Zm9vYmFyLXRoaXMtaXMtd2hhdC1hLXJlYWwtdG9rZW4tbG9va3MtbGlrZQ";

function client(answer: (request: Request) => Response | Promise<Response>) {
  const sent: Request[] = [];
  const fetchImpl = (async (input, init) => {
    const request = new Request(new URL(String(input), "http://localhost:8900"), init);
    sent.push(request);
    return answer(request);
  }) as typeof fetch;
  return { sent, api: createApiClient(() => TOKEN, fetchImpl) };
}

const path = (request: Request): string => `${request.method} ${new URL(request.url).pathname}`;

it("lists the backups and the State File's revision in one read, not from the settings (#412)", async () => {
  const { sent, api } = client(() => Response.json({ snapshots: [{ takenAt: 2 }, { takenAt: 1 }], version: "v1" }));

  expect(await fetchBackups(api)).toEqual({ kind: "served", snapshots: [{ takenAt: 2 }, { takenAt: 1 }], version: "v1" });
  expect(sent.map(path)).toEqual(["GET /api/backups"]);
  expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
});

it("tells a listing it could not have from a State File it could not read", async () => {
  const listing = client(() => Response.json({ reason: "workspace-refused", of: "backups" }, { status: 409 }));
  expect(await fetchBackups(listing.api)).toEqual({ kind: "refused", of: "backups", reason: "workspace-refused" });

  const file = client(() => Response.json({ reason: "workspace-refused", of: "state-file" }, { status: 409 }));
  expect(await fetchBackups(file.api)).toEqual({ kind: "refused", of: "state-file", reason: "workspace-refused" });

  const noList = client(() => Response.json({ version: "v1" }));
  expect(await fetchBackups(noList.api)).toEqual({ kind: "unreadable-answer" });
});

it("restores by the moment and the revision, and keeps the listing it was sent from", async () => {
  const { sent, api } = client(() =>
    Response.json({ kind: "restored", takenAt: 1, version: "v2", warnings: [{ kind: "entry-dropped", at: "pins[0]" }] }),
  );

  expect(await restoreBackup(api, 1, "v1", [{ takenAt: 1 }])).toEqual({
    kind: "served",
    snapshots: [{ takenAt: 1 }],
    version: "v2",
    restored: { takenAt: 1, moved: true, warned: true, overUnreadable: false },
  });
  expect(path(sent[0]!)).toBe("POST /api/backups/restore");
  expect(await sent[0]!.json()).toEqual({ takenAt: 1, basedOn: "v1" });

  // no State File: the revision is left out, which is the claim there is none
  await restoreBackup(api, 1, undefined, []);
  expect(await sent[1]!.json()).toEqual({ takenAt: 1 });
});

it("reads a restore's refusals by reason, and an unchanged restore as one that moved nothing", async () => {
  const refused = client(() => Response.json({ reason: "backup-refused", warnings: [] }, { status: 409 }));
  expect(await restoreBackup(refused.api, 1, "v1", [])).toEqual({ kind: "refused", of: "restore", reason: "backup-refused" });

  const unchanged = client(() => Response.json({ kind: "unchanged", takenAt: 1, version: "v1", warnings: [] }));
  expect(await restoreBackup(unchanged.api, 1, "v1", [])).toMatchObject({ restored: { moved: false, warned: false } });

  const over = client(() => Response.json({ kind: "restored", takenAt: 1, version: "v2", warnings: [], replacedUnreadable: true }));
  expect(await restoreBackup(over.api, 1, "v1", [])).toMatchObject({ restored: { moved: true, overUnreadable: true } });

  const gone = client(() => {
    throw new TypeError("fetch failed");
  });
  expect(await restoreBackup(gone.api, 1, "v1", [])).toEqual({ kind: "unreachable" });
});

it("reads the folder's status, and a create's refusal as the create's own", async () => {
  const status = { ready: false, missing: ["backups"] };
  const read = client(() => Response.json(status));
  expect(await fetchWorkspaceStatus(read.api)).toEqual({ kind: "served", status });

  const created = client(() => Response.json({ ready: true, missing: [] }));
  expect(await createWorkspace(created.api)).toEqual({ kind: "created", status: { ready: true, missing: [] } });
  expect(path(created.sent[0]!)).toBe("POST /api/workspace");

  const refused = client(() => Response.json({ reason: "workspace-refused" }, { status: 409 }));
  expect(await createWorkspace(refused.api)).toEqual({ kind: "refused", reason: "workspace-refused" });

  const unauthorized = client(() => Response.json({ error: "unauthorized" }, { status: 401 }));
  expect(await fetchWorkspaceStatus(unauthorized.api)).toEqual({ kind: "unauthorized" });
});
