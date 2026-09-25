# Localhost auth: launch token in an Authorization header

Any website open in the browser can send requests to a localhost server, and other OS users can reach it too. The server therefore binds only to `127.0.0.1`, checks `Host` and `Origin`, and requires `Authorization: Bearer <token>` on every request.

- **Delivery:** the CLI hands the token to the page in the URL fragment when it opens the browser. The page keeps the token in `localStorage`, which is per port. A custom header forces a CORS preflight, so cross-site forged requests fail even without the Origin check.
- **Storage:** the token lives in the user config directory, never the Workspace, and stays stable across restarts. One token per installation, with no expiry and nothing that retires it on its own, so the URL the launcher prints stays a working bookmark.
- **Rotation:** `biu-cs-planner rotate-token` replaces the file, and replacing the file is the whole of the revocation — there is no expiry to wait for and no list of retired tokens to add to. It is the other half of the stability above rather than a feature of its own: stability is what makes a leak permanent, and the launcher prints the token inside a URL, which is what ends up in a screenshot or a pasted bug report. **A terminal command and not a button in the page:** a page holding a leaked token would be authorising its own replacement, and a wrong click there could lock the student out of their own planner — reaching the terminal proves more than holding the token does. The command prints the file's path, and neither the new token nor a URL: nothing is listening yet, so a port would be a guess, and reprinting a fresh secret into the scrollback that leaked the last one would undo the rotation it is reporting.
- **Fallback:** a browser without a token gets a single-use pairing code printed in the terminal.
- **Beyond loopback:** binding to another interface requires a password (scrypt hash, rate-limited login).

## Considered Options

- **Cookie session:** browsers send localhost cookies to every port on the host, so other local apps would receive them. It would also need separate CSRF defenses.
- **Jupyter-style token in the query string only:** bookmarks break, and the token leaks into history and logs.
- **Password always:** weaker than a random token, and it adds friction to opening a personal planner.
- **TLS on localhost:** loopback traffic can't be sniffed by other non-admin users, and certificate trust is painful.
- **Unix socket or named pipe:** browsers cannot connect to either.

## Consequences

A process running as the same user can read the Workspace files directly. That is out of scope.

**Revocation completes at the next restart, not at the command.** A server that is already up read the token once at startup and holds it in memory: `bin.ts` hands that string to `createApi`, the guard digests it once, and nothing looks at the file again. So the retired token goes on opening that process until it exits, which is why `rotate-token`'s output says to stop the app with Ctrl-C rather than claiming the old token is already refused. From the next start every bookmark and every tab still holding the old token is refused, which is the point of it and not a side effect. Whether a running server should notice that its own token file has changed is not decided here — it is open on issue #128. Nor is what a tab holding a retired token should say: it does not find out on its own, and the message it does show is wrong about the cause, on issue #126.
