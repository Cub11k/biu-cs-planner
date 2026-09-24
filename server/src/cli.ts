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

/**
 * `rotate-token`: replace the launch token and stop, without starting a server.
 *
 * A command rather than a flag on the launch, because it is a different job and not a
 * variation on one: it starts nothing, opens nothing, and touches no Workspace, so every
 * launch option is meaningless beside it. A `--rotate-token` flag would have to answer
 * what `--rotate-token --workspace ~/degree` means, and any answer to that is a surprise.
 * A command is also the shape the next one already has — `docs/design.md` has
 * `biu-cs-planner url` waiting, and two commands in a flat namespace need no nesting.
 */
export type RotateToken = { kind: "rotate-token" };

/** `--help`: print and exit 0. */
export type Help = { kind: "help"; text: string };

/** Something the CLI will not do. Printed to stderr, exit 1. */
export type Refusal = { kind: "refusal"; message: string };

export type Invocation = Launch | RotateToken | Help | Refusal;

/** The commands, as opposed to the options. Recognised as the first argument only. */
const COMMANDS = new Set(["rotate-token"]);

export const USAGE = `biu-cs-planner — a local course planner for Bar-Ilan CS students

Usage: biu-cs-planner [options]
       biu-cs-planner rotate-token

Options:
  --workspace <path>  the folder holding your Catalogs, Requirements Files and
                      State Files (default: the current directory)
  --no-open           print the URL but do not open a browser
  --host <address>    the address to bind (default: ${LOOPBACK_HOST})
  --help              show this

Commands:
  rotate-token        replace the launch token, for when somebody else has seen it — it
                      is printed in the URL, so a pasted bug report or a screenshot is
                      enough. Every bookmark and every open tab stops working, which is
                      the point of it and not a side effect.

                      The token is a file in your user config directory, never in your
                      Workspace: $XDG_CONFIG_HOME or ~/.config/biu-cs-planner/token, and
                      %APPDATA%\\biu-cs-planner\\token on Windows. rotate-token prints the
                      exact path; deleting that file by hand does the same thing.

The server runs in the foreground on port ${DEFAULT_PORT}; if that port is taken it uses
the next free one and says so. Stop it with Ctrl-C.`;

/**
 * The addresses `--host` may name, each written the way Node will be asked to listen on
 * it — `[::1]` is accepted as a spelling and handed back as `::1`, which is what Node
 * can actually resolve.
 *
 * This is exactly the set `guard.ts` accepts in a `Host` header, and deliberately no
 * wider. The rest of 127.0.0.0/8 is loopback too, but a server bound to 127.0.0.2 would
 * print a `localhost` URL that reaches nothing, and every request that did arrive would
 * be refused by the guard as a name that is not loopback. An address the student can
 * bind and then cannot use is worse than one they cannot bind.
 *
 * Anything further out needs a password, and password login is not built yet
 * (docs/design.md, "Authentication"; ADR-0004).
 */
const LOOPBACK_ADDRESSES = new Set(["localhost", "127.0.0.1", "::1"]);

function loopbackAddress(host: string): string | undefined {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const canonical = bare.toLowerCase();
  return LOOPBACK_ADDRESSES.has(canonical) ? canonical : undefined;
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
      "Serving anywhere but this machine needs a password, and password login is not " +
      'built yet (docs/design.md, "Authentication").\n' +
      `--host takes ${[...LOOPBACK_ADDRESSES].join(", ")}; leave it off for 127.0.0.1.`,
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
  const [first, ...rest] = argv;
  if (first !== undefined && COMMANDS.has(first)) return command(first, rest);

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
        const loopback = loopbackAddress(value);
        if (loopback === undefined) return refuseNonLoopback(value);
        host = loopback;
        break;
      }

      default:
        // a command that arrived somewhere other than first is a word the parser knows,
        // so saying "unknown option" about it would be the one wrong thing to say
        if (COMMANDS.has(argument)) {
          return {
            kind: "refusal",
            message:
              `biu-cs-planner: ${argument} is a command, not an option.\n` +
              `Put it first and on its own: biu-cs-planner ${argument}`,
          };
        }
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

/**
 * A command takes no options. `--help` after one is still help, because that is where
 * somebody who has just read the word `rotate-token` in the usage text will look next.
 *
 * Every other argument is refused rather than ignored, and the refusal says why the
 * launch options in particular do not apply: the token is not in the Workspace and
 * rotating starts no server, so `--workspace` and `--host` would each be a silent lie
 * about what the command had just done.
 */
function command(name: string, rest: readonly string[]): Invocation {
  if (rest.some((argument) => argument === "--help" || argument === "-h")) {
    return { kind: "help", text: USAGE };
  }

  const extra = rest[0];
  if (extra !== undefined) {
    return {
      kind: "refusal",
      message:
        `biu-cs-planner: ${name} takes no options, and got ${extra}.\n` +
        "The launch token is in your user config directory, not in a Workspace, and " +
        "rotating it starts no server.",
    };
  }

  return { kind: "rotate-token" };
}

/**
 * What the terminal says after a rotation.
 *
 * It does not print the new token, and it prints no URL. Two reasons, and the second is
 * the load-bearing one:
 *
 *   - there is no port yet. Nothing is listening, and the next launch takes the default
 *     port or the next free one, so any URL printed here would be a guess.
 *   - the printed URL is how the old token got out in the first place. Reprinting a fresh
 *     secret into the same scrollback, right after the student came here because that
 *     scrollback was shared, would undo the rotation it is reporting.
 *
 * The next launch prints the URL, as it always has. This says where the token is and what
 * has just stopped working — including the words the page itself will use, so the student
 * recognises the screen when they see it.
 *
 * **It also says to stop a server that is still running**, and that is not politeness. A
 * running server read the token once at startup and holds it in memory; `bin.ts` builds the
 * guard from that string and never looks at the file again. So the old token keeps working
 * against that process until it exits, and a notice that said the old token was refused
 * "from now on" would be telling a student they were safe while the leak was still open.
 * The rotation is only as good as the restart, and the output has to say so.
 *
 * Takes the path and not the whole `Rotation`, so the token is not in reach of this text.
 */
export function rotatedNotice({
  path,
  replaced,
}: {
  path: string;
  replaced: boolean;
}): string {
  const first = replaced
    ? "biu-cs-planner: the launch token has been replaced."
    : "biu-cs-planner: a launch token has been written.";

  const consequence = replaced
    ? [
        "Stop the app with Ctrl-C if it is still running: it read the old token at startup",
        "and goes on accepting it until it exits.",
        "",
        "The old token is then refused, and so is everything holding it — every bookmark you",
        'saved, and every tab still open on the planner, which will say it "has no launch',
        'token" and show none of your picks until you open the new address.',
      ].join("\n")
    : "There was none here before, so nothing that used to work has stopped.";

  return [
    first,
    `  ${path}`,
    "",
    consequence,
    "",
    "Start it again to get the new address:",
    "  biu-cs-planner",
  ].join("\n");
}
