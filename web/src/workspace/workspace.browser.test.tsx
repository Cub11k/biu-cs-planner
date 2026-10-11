/// <reference types="@vitest/browser-playwright" />
/**
 * The Workspace screen as a student meets it (#238): the backups listed, one restored and undone,
 * every refusal a restore can answer with said as a restore's, a backups folder that cannot be read,
 * and a folder that is not a Workspace yet, created or refused. A browser, because what is under
 * test is a click, a request and a re-render.
 *
 * The API is a fake `fetch` that keeps the snapshots and the revision, the way `server/src/api.ts`
 * does: a restore is a save, so it moves the revision and takes a snapshot of what it replaced.
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../index.css";
import { AppShell } from "../AppShell.tsx";
import { t, type StringKey } from "../i18n/strings.ts";
import { WORKSPACE_SCREEN } from "./WorkspaceScreen.tsx";

const realFetch = globalThis.fetch;
let host: HTMLElement | undefined;
let root: Root | undefined;

let sent: Array<{ method: string; pathname: string; body: Record<string, unknown> | undefined }>;
let snapshots: number[];
let version: number;
let canUndo: boolean;
let status: { ready: boolean; missing: string[]; notAFolder?: string[] };
/** The reason the next restore is refused with, rather than made. */
let refuseRestore: string | undefined;
/** The reason the listing is refused with while set. */
let refuseList: string | undefined;
/** The reasons the next creates are refused with, one per create. */
let refuseCreates: string[];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sent = [];
  snapshots = [2_000_000_000_000, 1_900_000_000_000];
  version = 1;
  canUndo = false;
  status = { ready: true, missing: [] };
  refuseRestore = undefined;
  refuseList = undefined;
  refuseCreates = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, location.href);
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    const text = input instanceof Request ? await input.clone().text() : init?.body;
    const body = typeof text === "string" && text !== "" ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    sent.push({ method, pathname, body });

    if (pathname === "/api/history") return json({ canUndo, canRedo: false });
    if (pathname === "/api/history/undo") {
      canUndo = false;
      version += 1;
      return json({ label: "restore-backup", at: 1, version: `v${version}`, canUndo: false, canRedo: true, warnings: [] });
    }
    if (pathname === "/api/settings") return json({ settings: {}, version: `v${version}`, warnings: [] });
    if (pathname === "/api/workspace" && method === "GET") return json(status);
    if (pathname === "/api/workspace") {
      const reason = refuseCreates.shift();
      if (reason !== undefined) return json({ reason }, 409);
      status = { ready: true, missing: [] };
      return json(status);
    }
    if (pathname === "/api/backups") {
      if (refuseList !== undefined) return json({ reason: refuseList }, 409);
      return json({ snapshots: snapshots.map((takenAt) => ({ takenAt })) });
    }
    if (pathname === "/api/backups/restore") {
      if (refuseRestore !== undefined) {
        const reason = refuseRestore;
        refuseRestore = undefined;
        if (reason === "state-file-changed") version += 1; // somebody else wrote the file
        return json({ reason, warnings: [] }, 409);
      }
      const takenAt = body!.takenAt as number;
      snapshots = [2_100_000_000_000, ...snapshots];
      version += 1;
      canUndo = true;
      return json({ kind: "restored", takenAt, version: `v${version}`, warnings: [] });
    }
    throw new Error(`the fake was not arranged for ${method} ${pathname}`);
  }) as typeof fetch;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  globalThis.fetch = realFetch;
});

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(<AppShell screens={[WORKSPACE_SCREEN]} language="en" onLanguage={() => {}} />);
  return host;
}

const said = (mounted: HTMLElement): string => mounted.querySelector('[role="status"]')?.textContent ?? "";

const rows = (mounted: HTMLElement): string[] =>
  [...mounted.querySelectorAll<HTMLElement>("li[data-backup]")].map((row) => row.dataset.backup!);

async function restoreButton(mounted: HTMLElement, takenAt: number): Promise<HTMLButtonElement> {
  return vi.waitFor(() => {
    const found = mounted.querySelector<HTMLButtonElement>(`li[data-backup="${takenAt}"] button[data-restore]`);
    if (found === null || found.disabled) throw new Error("the backup was not offered");
    return found;
  });
}

async function saysSo(mounted: HTMLElement, key: StringKey): Promise<void> {
  await vi.waitFor(() => {
    if (!said(mounted).includes(t("en", key).split("{")[0]!)) throw new Error(`${key} was not said: ${said(mounted)}`);
  });
}

it("lists the backups newest first, restores one on the revision on screen, and lists the new snapshot", async () => {
  const mounted = mount();
  (await restoreButton(mounted, 1_900_000_000_000)).click();

  await vi.waitFor(() => {
    if (rows(mounted).length !== 3) throw new Error("the snapshot the restore took was not listed");
  });
  expect(sent.find((request) => request.pathname === "/api/backups/restore")?.body).toEqual({
    takenAt: 1_900_000_000_000,
    basedOn: "v1",
  });
  expect(rows(mounted)).toEqual(["2100000000000", "2000000000000", "1900000000000"]);
  await saysSo(mounted, "workspaceRestored");
});

it("is undone from the shell, which names it as a restore", async () => {
  const mounted = mount();
  (await restoreButton(mounted, 2_000_000_000_000)).click();

  const undo = await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLButtonElement>('button[data-history="undo"]');
    if (found === null || found.disabled) throw new Error("undo was never offered");
    return found;
  });
  undo.click();

  await vi.waitFor(() => {
    if (!said(mounted).includes(t("en", "undoneEdit", { edit: t("en", "editRestoreBackup") })))
      throw new Error("the undo was not named");
  });
  expect(sent.find((request) => request.pathname === "/api/history/undo")?.body).toEqual({ basedOn: "v2" });
});

/**
 * #238's 2026-10-04 note: `backup-refused` on the restore path is a restore that was not made, said
 * as one — not the sentence another screen says about a change of its own that was not saved.
 */
it("says a restore refused for want of a backup is a restore not made, in its own words", async () => {
  const mounted = mount();
  refuseRestore = "backup-refused";
  (await restoreButton(mounted, 2_000_000_000_000)).click();

  await saysSo(mounted, "workspaceRestoreBackupRefused");
  for (const borrowed of ["picksBackupRefused", "planBackupRefused", "historyBackupRefused"] as const) {
    expect(said(mounted)).not.toContain(t("en", borrowed));
  }
  // nothing was written, so the listing on screen is still the folder's
  expect(rows(mounted)).toEqual(["2000000000000", "1900000000000"]);
});

it.each([
  ["state-file-changed", "workspaceRestoreStale"],
  ["backup-not-found", "workspaceRestoreNotFound"],
  ["backup-unreadable", "workspaceRestoreUnreadable"],
  ["workspace-refused", "workspaceRestoreRefused"],
] as const)("says a restore refused as %s as a restore's refusal", async (reason, key) => {
  const mounted = mount();
  refuseRestore = reason;
  (await restoreButton(mounted, 2_000_000_000_000)).click();
  await saysSo(mounted, key);
});

it("reads the listing again after a stale restore, and bases the next one on what it read", async () => {
  const mounted = mount();
  refuseRestore = "state-file-changed";
  (await restoreButton(mounted, 2_000_000_000_000)).click();
  await saysSo(mounted, "workspaceRestoreStale");

  (await restoreButton(mounted, 2_000_000_000_000)).click();
  await vi.waitFor(() => {
    if (rows(mounted).length !== 3) throw new Error("the second restore was not made");
  });
  const restores = sent.filter((request) => request.pathname === "/api/backups/restore");
  expect(restores.map((request) => request.body?.basedOn)).toEqual(["v1", "v2"]);
});

it("says a backups folder that cannot be listed is the backups folder, not the student's Picks", async () => {
  refuseList = "workspace-refused";
  const mounted = mount();
  await saysSo(mounted, "workspaceBackupsUnreadable");
  expect(said(mounted)).not.toContain(t("en", "picksUnreadable"));
  expect(mounted.querySelector("button[data-restore]")).toBeNull();
});

it("offers a folder that is not a Workspace its folders, says a refused create without claiming nothing changed, and creates", async () => {
  status = { ready: false, missing: ["requirements", "backups"] };
  refuseCreates = ["workspace-refused"];
  const mounted = mount();

  const create = await vi.waitFor(() => {
    const found = mounted.querySelector<HTMLButtonElement>("button[data-workspace-create]");
    if (found === null) throw new Error("creating was not offered");
    return found;
  });
  expect(mounted.querySelector("[data-workspace-not-ready]")?.textContent).toContain("requirements, backups");
  create.click();
  await saysSo(mounted, "workspaceCreateRefused");
  expect(said(mounted)).not.toContain(t("en", "picksUnreadable"));

  create.click();
  await vi.waitFor(() => {
    if (mounted.querySelector("[data-workspace-not-ready]") !== null) throw new Error("the folder still reads as not ready");
  });
  await saysSo(mounted, "workspaceCreated");
});
