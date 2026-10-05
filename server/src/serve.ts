import { serve } from "@hono/node-server";
import { watchWorkspace } from "@biu-cs-planner/app";
import { createApi } from "./api.ts";
import { loggingWorkspace } from "./debug.ts";
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
  const value = flag === -1 ? undefined : argv[flag + 1];
  // a flag is not a path: `--workspace --debug` plans in the current directory, as with no value
  return value !== undefined && value !== "" && !value.startsWith("-") ? value : process.cwd();
}

const path = workspacePathFromArgv(process.argv);
const token = await launchToken();
// `--debug` as the real CLI takes it: every Workspace refusal on stderr, off otherwise (#165)
const workspace = process.argv.includes("--debug")
  ? loggingWorkspace(fileSystemWorkspace(path), (line) => console.error(line), token)
  : fileSystemWorkspace(path);

/**
 * The folder is watched from here on, and until the process ends.
 *
 * Nothing calls `changes.stop()`, because there is no shutdown path here to call it from:
 * the server runs in the foreground of a terminal and `Ctrl-C` with no handler ends the
 * process outright. A `SIGINT` handler is deliberately not added — one that closed the
 * watcher but forgot the listening socket would leave a server that cannot be stopped,
 * which is what the smoke legs in `.github/workflows/ci.yml` fail on, and it would also
 * replace the exit status those legs read. `stop` is for a caller that does have a
 * shutdown path, and for the tests that assert the watcher lets go.
 *
 * `persistent: false` in the adapter keeps the watcher from being the thing that holds the
 * loop open on Node and Bun. Deno ignores it, so there the watcher outlives everything
 * until the process dies — measured, and harmless: the listening socket holds the loop open
 * anyway, and `SIGINT` ends the process whatever is still attached to it.
 */
const changes = await watchWorkspace(workspace);
const api = createApi({ workspace, changes, token });

serve({ fetch: api.fetch, hostname: LOOPBACK_HOST, port: DEFAULT_PORT }, (info) => {
  // The URL, token and all, is the one thing the student needs off this screen: the
  // page takes the token out of the fragment and keeps it, so it is printed once.
  console.log(`biu-cs-planner: ${launchUrl(info.port, token)}`);
  console.log(`Workspace: ${path}`);
});
