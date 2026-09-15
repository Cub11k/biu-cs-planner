import { resolve } from "node:path";
import { DEFAULT_PORT, LOOPBACK_HOST } from "./config.ts";

/**
 * What `npx biu-cs-planner` was asked to do.
 *
 * Reading the command line is kept apart from acting on it so that every refusal below
 * is a value a test can look at, rather than a process that has already exited.
 */
export type Launch = {
  kind: "launch";
  /** The Workspace folder, absolute; the current directory unless `--workspace` says otherwise. */
  workspace: string;
  /** The address to bind. Loopback, always — see `refuseNonLoopback` below. */
  host: string;
  /** Whether to open the browser once the server is up. */
  open: boolean;
};

/** `--help`: print and exit 0. */
export type Help = { kind: "help"; text: string };

/** Something the CLI will not do. Printed to stderr, exit 1. */
export type Refusal = { kind: "refusal"; message: string };

export type Invocation = Launch | Help | Refusal;

export const USAGE = `biu-cs-planner — a local course planner for Bar-Ilan CS students

Usage: biu-cs-planner [options]

Options:
  --workspace <path>  the folder holding your Catalogs, Requirements Files and
                      State Files (default: the current directory)
  --no-open           print the URL but do not open a browser
  --host <address>    the address to bind (default: ${LOOPBACK_HOST})
  --help              show this

The server runs in the foreground on port ${DEFAULT_PORT}; if that port is taken it uses
the next free one and says so. Stop it with Ctrl-C.`;

/**
 * The addresses that are this machine and nothing else. `--host` may name one of these
 * and no other, because binding anywhere reachable needs a password and password login
 * is not built yet (docs/design.md, "Authentication"; ADR-0004).
 *
 * This is not `guard.ts`'s loopback set: that one reads the `Host` header of a request
 * that has already arrived, while this one decides which interface to listen on. The
 * two overlap without being the same question, so neither is written in terms of the
 * other.
 */
function isLoopbackAddress(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.toLowerCase() === "localhost") return true;
  if (bare === "::1" || bare === "::ffff:127.0.0.1") return true;
  // the whole 127.0.0.0/8 block is loopback, so 127.0.0.2 is as local as 127.0.0.1
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) && octetsFit(bare);
}

function octetsFit(address: string): boolean {
  return address.split(".").every((octet) => Number(octet) <= 255);
}

/**
 * Binding beyond loopback is the one flag that can make this server reachable by
 * somebody else, and the design answers it with a password. Until there is one to
 * check, the honest answer is no — a `--host 0.0.0.0` that quietly worked would put a
 * student's Workspace on the university network behind nothing at all.
 */
function refuseNonLoopback(host: string): Refusal {
  return {
    kind: "refusal",
    message:
      `biu-cs-planner: refusing to bind ${host}.\n` +
      "Serving anything but loopback needs a password, and password login is not built " +
      'yet (docs/design.md, "Authentication").\n' +
      "Leave --host off to serve 127.0.0.1 only.",
  };
}

/**
 * Reads the arguments after the program name. Unknown flags are refused rather than
 * ignored: a mistyped `--workspce` that silently planned against the wrong folder is
 * the expensive kind of quiet.
 */
export function parseArguments(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Invocation {
  let workspace: string | undefined;
  let host: string = LOOPBACK_HOST;
  let open = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    switch (argument) {
      case "--help":
      case "-h":
        return { kind: "help", text: USAGE };

      case "--no-open":
        open = false;
        break;

      case "--workspace": {
        const value = argv[++index];
        if (value === undefined || value.startsWith("-")) return missingValue("--workspace", "<path>");
        workspace = value;
        break;
      }

      case "--host": {
        const value = argv[++index];
        if (value === undefined || value.startsWith("-")) return missingValue("--host", "<address>");
        if (!isLoopbackAddress(value)) return refuseNonLoopback(value);
        host = value;
        break;
      }

      default:
        return {
          kind: "refusal",
          message: `biu-cs-planner: unknown option ${argument}.\n\n${USAGE}`,
        };
    }
  }

  return {
    kind: "launch",
    // absolute from here on, so what is printed is what the student can paste back
    workspace: resolve(cwd, workspace ?? "."),
    host,
    open,
  };
}

function missingValue(flag: string, placeholder: string): Refusal {
  return { kind: "refusal", message: `biu-cs-planner: ${flag} needs ${placeholder}.` };
}
