import { serve } from "@hono/node-server";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";
import { DEFAULT_PORT, LOOPBACK_HOST } from "./config.ts";

/**
 * Dev entry point. The real CLI entry — launch token, browser open, port fallback,
 * single-instance lock — is its own ticket.
 *
 * A Workspace is the folder the student names, or the current directory
 * (docs/design.md, "Storage").
 */
function workspacePathFromArgv(argv: string[]): string {
  const flag = argv.indexOf("--workspace");
  return flag !== -1 && argv[flag + 1] ? argv[flag + 1]! : process.cwd();
}

const path = workspacePathFromArgv(process.argv);
const api = createApi({ workspace: fileSystemWorkspace(path) });

serve({ fetch: api.fetch, hostname: LOOPBACK_HOST, port: DEFAULT_PORT }, (info) => {
  console.log(`biu-cs-planner API on http://${LOOPBACK_HOST}:${info.port}`);
  console.log(`Workspace: ${path}`);
});
