# Localhost auth: launch token in an Authorization header

Any website open in the browser can send requests to a localhost server, and other OS users can reach it too. The server therefore binds only to `127.0.0.1`, checks `Host` and `Origin`, and requires `Authorization: Bearer <token>` on every request.

- **Delivery:** the CLI hands the token to the page in the URL fragment when it opens the browser. The page keeps the token in `localStorage`, which is per port. A custom header forces a CORS preflight, so cross-site forged requests fail even without the Origin check.
- **Storage:** the token lives in the user config directory, never the Workspace, and stays stable across restarts.
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
