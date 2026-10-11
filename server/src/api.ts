import { Hono } from "hono";
import { onlyTheLauncher } from "./guard.ts";
import { DEFAULT_STATE_FILE, type Workspace, type WorkspaceChanges } from "@biu-cs-planner/app";
import { editHistories } from "./history.ts";
import { CURRENT_CATALOG_SCHEMA_VERSION } from "@biu-cs-planner/core";
import { backupsRoutes } from "./backups.api.ts";
import { catalogRoutes } from "./catalog.api.ts";
import { historyRoutes } from "./history.api.ts";
import { planRoutes } from "./plan.api.ts";
import { progressRoutes } from "./progress.api.ts";
import { timetableRoutes } from "./timetable.api.ts";
import { workspaceRoutes } from "./workspace.api.ts";

/**
 * The HTTP API. It exposes domain operations — a year, a Semester, a course number —
 * and never a file path: where a Catalog lives is the Workspace adapter's business, and
 * nothing in a request or a response names it (ADR-0002, docs/design.md).
 *
 * Every route sits behind `onlyTheLauncher`, so a route added to a route module mounted here is
 * protected by being mounted here — the launch token, the Host and Origin checks and the JSON-only
 * rule for writes are not something each new endpoint has to remember (ADR-0004).
 *
 * **Nothing here logs.** A `WorkspaceRefusedError` the routes answer with a named reason is
 * written down only under `--debug`, by the Workspace handed in here (`loggingWorkspace` in
 * `./debug.ts`, #165):
 * off by default, to stderr, with the reason code, errno and `cause`, the absolute Workspace path
 * allowed and **the launch token never, in any mode**. A route that wants to log has that rule to
 * keep, and no response ever carries what the log does.
 */
export type ApiDependencies = {
  workspace: Workspace;
  /** The launch token this server was started with; see ./token.ts. */
  token: string;
  /**
   * The Workspace's change counter. Only the reading half: starting and stopping the watch
   * belongs to whoever owns the process, not to a request.
   */
  changes: Pick<WorkspaceChanges, "changeCount">;
};

/**
 * The one route that answers without a token: a launcher needs to tell a server that is
 * already running from a port that something else holds, before it has a token to offer.
 * It says only that the app is here and which schema version it speaks.
 */
const HEALTH_PATH = "/api/health";

/**
 * The composition point: the guard, the health route, and one route module per resource, each in
 * its own `*.api.ts` beside this file with the helpers they share in `./api.shared.ts`. A route is
 * added to the module of its resource, never here, and is guarded by being mounted below the
 * `use` (#366).
 */
export function createApi({ workspace, token, changes }: ApiDependencies) {
  /**
   * The undo and redo stacks, built here and held for as long as this server runs.
   *
   * Not a dependency a caller passes, and deliberately: a server built without a history
   * would still save every edit, and the only sign would be an undo button that never lit
   * up. Nothing about the stacks has a lifecycle outside this process either — unlike the
   * watcher, which is injected because starting and stopping it belongs to whoever owns the
   * process. One history per server is also what makes two tabs share one (ADR-0013):
   * `./token.ts` is one token for all of them and there is no session to key a stack to.
   */
  const history = editHistories(workspace);

  /**
   * The port every editing route hands to the use case, for the State File the API works in.
   * The same name the use cases default to, so the stack is keyed to the file being written
   * and not to a second opinion about which file that is (`app/src/picks.ts`).
   */
  const into = history.of(DEFAULT_STATE_FILE);
  const routes = { workspace, into };

  const guarded = new Hono();
  guarded.use("/api/*", onlyTheLauncher({ token, openPaths: [HEALTH_PATH] }));

  return guarded
    .get(HEALTH_PATH, (c) =>
      c.json({ ok: true, catalogSchemaVersion: CURRENT_CATALOG_SCHEMA_VERSION } as const),
    )
    .route("/", workspaceRoutes(workspace, changes))
    .route("/", catalogRoutes(workspace))
    .route("/", progressRoutes(routes))
    .route("/", planRoutes(routes))
    .route("/", timetableRoutes(routes))
    .route("/", backupsRoutes(routes))
    .route("/", historyRoutes(routes, history));
}

/** `web` imports this type only, never the runtime (docs/design.md, "Architecture"). */
export type ApiType = ReturnType<typeof createApi>;
