import { Hono } from "hono";
import { createWorkspace, workspaceStatus, type Workspace, type WorkspaceChanges } from "@biu-cs-planner/app";
import { capped } from "./api.shared.ts";

/**
 * The Workspace routes: whether the folder is one, creating its layout, and the change count the
 * page polls (see `ApiDependencies` in `./api.ts` for why `changes` is only the reading half).
 */
export function workspaceRoutes(workspace: Workspace, changes: Pick<WorkspaceChanges, "changeCount">) {
  return new Hono()
    /**
     * Is this folder a Workspace yet, and what is missing if not?
     *
     * One answer and no refusal arm, which `workspaceStatus` in `app/src/setup.ts` is where the
     * argument for lives: the Workspace Layout probe behind it reports a part it cannot resolve as
     * *missing* rather than raising, so the hole the POST below had is not open here (#141).
     */
    .get("/api/workspace", async (c) => c.json(await workspaceStatus(workspace)))

    /**
     * Creating the Workspace Layout is an explicit act, which is why it is a POST and not a side
     * effect of the GET above: nothing is written until the student asks.
     *
     * **A refused create is the same named 409 the other write routes answer with.** Until #141
     * this route was an unnamed 500: `createWorkspace` threw, the route had no arm for it, and
     * Hono's default handler answered with no body of this app's own. It was the only such route
     * anyone had found, and the property "the API has no unnamed 500 path" is load-bearing for
     * #90's and #109's arguments — but that property is an argument made route by route and not
     * something a test asserts over all of them, so this comment claims only its own. The body is
     * the import route's to the character — `{ "reason": "workspace-refused" }` — because it is
     * the same refusal out of the same port, and a page that can read one can read the other.
     *
     * A created Workspace still answers with its status and nothing wrapped around it, so the
     * successful shape on the wire is untouched by the arm above it.
     */
    .post("/api/workspace", capped, async (c) => {
      const created = await createWorkspace(workspace);
      // A conflict with the state of the folder, exactly as an import into one that is not a
      // Workspace is: the request is well formed and the folder will not have it.
      if (created.kind === "refused") return c.json({ reason: created.reason }, 409);

      return c.json(created.status);
    })

    /**
     * How the page hears that the Workspace changed under it (docs/design.md, "Storage").
     * One integer, moved once per settled burst of filesystem events; `web` remembers the
     * last one it saw and reloads what it is showing when this one differs. A count, not a
     * version: it restarts at 0 with the server, and nothing may compare a file against it.
     *
     * **Why a number a page asks for, rather than the server pushing one.** `web` reaches
     * the domain only through this API and the typed client (CLAUDE.md, ADR-0002), and it
     * must gain no second source of truth — so whatever carries the notification has to be
     * a route on this contract. Of the three ways to do that:
     *
     *   polling  one `GET` on the same typed client, the same launch token in the same
     *            `Authorization` header, the same guard, and nothing held open. Costs one
     *            request every couple of seconds on loopback, which reads an integer that
     *            is already in memory and touches no disk: the watcher, not the poll, is
     *            what looks at the folder.
     *   SSE      `EventSource` cannot send an `Authorization` header, so the launch token
     *            would have to move into the query string — logged, and in the Referer —
     *            which is the arrangement ADR-0004 turned down. Reading a stream through
     *            `fetch` instead keeps the header but holds a response open for the life of
     *            the page, which is a connection the server has to be able to drop before
     *            Ctrl-C can end it.
     *   websocket an upgrade needs a per-runtime adapter (`@hono/node-ws` and the `ws`
     *            dependency on Node, Bun's and Deno's own elsewhere). That is a Node-only
     *            API in the one place the design says to avoid one and a runtime dependency
     *            in a server that is meant to bundle with none (docs/design.md, "CLI and
     *            distribution", "Supply chain"), and a browser `WebSocket` cannot send the
     *            header either.
     *
     * A localhost app that reloads a hand-dropped Catalog does not need sub-second news, so
     * the cheapest mechanism that keeps the one edge and the one token wins. Pushing can be
     * added behind this same counter later without `web` learning anything new.
     */
    .get("/api/workspace/changes", (c) => c.json({ changeCount: changes.changeCount() }));
}
