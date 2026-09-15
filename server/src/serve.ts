import { serve } from "@hono/node-server";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";
import { launchToken, launchUrl } from "./token.ts";
import { DEFAULT_PORT, LOOPBACK_HOST } from "./config.ts";

/**
 * Dev entry point. The real CLI entry — browser open, port fallback, single-instance
 * lock — is its own ticket; the launch token is not, and lives in ./token.ts.
 *
 * A Workspace is the folder the student names, or the current directory
 * (docs/design.md, "Storage").
 */
function workspacePathFromArgv(argv: string[]): string {
  const flag = argv.indexOf("--workspace");
  return flag !== -1 && argv[flag + 1] ? argv[flag + 1]! : process.cwd();
}

const path = workspacePathFromArgv(process.argv);
const token = await launchToken();
const api = createApi({ workspace: fileSystemWorkspace(path), token });

serve({ fetch: api.fetch, hostname: LOOPBACK_HOST, port: DEFAULT_PORT }, (info) => {
  // The URL, token and all, is the one thing the student needs off this screen: the
  // page takes the token out of the fragment and keeps it, so it is printed once.
  console.log(`biu-cs-planner: ${launchUrl(info.port, token)}`);
  console.log(`Workspace: ${path}`);
});
