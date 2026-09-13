/**
 * A fixed default port keeps the URL bookmarkable; if it is taken the server
 * moves to the next free port and says so (docs/design.md, "CLI and distribution").
 * 8900 echoes BIU's 89- Computer Science course prefix.
 */
export const DEFAULT_PORT = 8900;

/** The server binds loopback only (docs/design.md, "Authentication"). */
export const LOOPBACK_HOST = "127.0.0.1";
