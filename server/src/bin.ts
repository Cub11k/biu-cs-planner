import { serve, type ServerType } from "@hono/node-server";
import { watchWorkspace } from "@biu-cs-planner/app";
import { Hono } from "hono";
import { createApi } from "./api.ts";
import { parseArguments, type Launch } from "./cli.ts";
import { onAFreePort } from "./port.ts";
import { openInBrowser } from "./browser.ts";
import { launchToken, launchUrl } from "./token.ts";
import { builtUiRoot, serveBuiltUi } from "./ui.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";
import { DEFAULT_PORT } from "./config.ts";

/**
 * `npx biu-cs-planner`. This is the file esbuild bundles into `dist/cli.js`, and the
 * only place the pieces are wired together: the API, the built UI next to this bundle,
 * the launch token, a port, and the browser.
 *
 * It runs in the foreground and prints the URL whether or not it opens a browser, so
 * the student can always copy it (docs/design.md, "CLI and distribution").
 */
async function main(argv: readonly string[]): Promise<void> {
  const invocation = parseArguments(argv);

  if (invocation.kind === "help") {
    console.log(invocation.text);
    return;
  }
  if (invocation.kind === "refusal") {
    console.error(invocation.message);
    process.exitCode = 1;
    return;
  }

  await start(invocation);
}

async function start({ workspace, host, open }: Launch): Promise<void> {
  const token = await launchToken();
  const folder = fileSystemWorkspace(workspace);
  // watched for as long as the process runs, so a Catalog dropped in by hand reaches the
  // page without a manual reload (docs/design.md, "Storage"). Nothing stops it by hand:
  // Ctrl-C ends the process, and see server/src/serve.ts for why no handler intercepts it.
  const changes = await watchWorkspace(folder);
  const api = createApi({ workspace: folder, changes, token });

  // the API first, so a route of its own is never shadowed by a file
  const app = new Hono().route("/", api).get("*", serveBuiltUi(builtUiRoot()));

  const { port } = await onAFreePort(
    (candidate) => listen(app.fetch, host, candidate),
    DEFAULT_PORT,
  );

  if (port !== DEFAULT_PORT) {
    console.log(`Port ${DEFAULT_PORT} was taken, so this run is on ${port}.`);
  }

  const url = launchUrl(port, token);
  console.log(`biu-cs-planner: ${url}`);
  console.log(`Workspace: ${workspace}`);
  console.log("Press Ctrl-C to stop.");

  if (open) openInBrowser(url);
}

/**
 * One attempt at one port. The adapter reports a taken port through the server's `error`
 * event rather than by throwing, so the two outcomes are turned back into one promise
 * for `onAFreePort` to loop over.
 */
type FetchHandler = Parameters<typeof serve>[0]["fetch"];

function listen(
  fetch: FetchHandler,
  hostname: string,
  port: number,
): Promise<ServerType> {
  return new Promise((resolveListening, rejectListening) => {
    const server: ServerType = serve({ fetch, hostname, port }, () => {
      server.off("error", failed);
      resolveListening(server);
    });

    const failed = (error: Error): void => {
      server.close();
      rejectListening(error);
    };

    server.once("error", failed);
  });
}

/**
 * Anything that got past the refusals above — a port range entirely in use, a permission
 * the operating system will not give — is still the student's problem to read, not a
 * stack trace. The contract is the same one `main` keeps: a line on stderr, exit 1.
 */
try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : `biu-cs-planner: ${String(error)}`);
  process.exitCode = 1;
}
