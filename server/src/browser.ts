import { spawn } from "node:child_process";

/**
 * Opening the student's browser. Neither Node nor Bun has an API for it, so this is the
 * platform's own command — and it is the only reason the package would otherwise reach
 * for a dependency, which the zero-runtime-dependency rule rules out
 * (docs/design.md, "Supply chain").
 */
export type BrowserCommand = { command: string; args: string[] };

/**
 * `start` is a `cmd` builtin rather than a program, and its first quoted argument is the
 * window title — hence the empty `""`, without which a quoted URL would become the title
 * and no browser would open.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): BrowserCommand {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

export type Spawner = typeof spawn;

/**
 * Opens the URL and forgets about it: detached and unreferenced, so the browser does not
 * hold the terminal, and silent on failure because the URL has already been printed.
 * A machine with no `xdg-open` is a machine where the student copies the line instead —
 * not a reason for the server not to run.
 *
 * Nothing goes through a shell, so the URL is an argument and never a command.
 */
export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawner: Spawner = spawn,
): void {
  const { command, args } = browserCommand(platform, url);
  try {
    const child = spawner(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // the URL is on screen either way
  }
}
