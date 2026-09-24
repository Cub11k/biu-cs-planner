/**
 * A taken port is not a reason to fail. The design fixes the default at 8900 so the URL
 * stays bookmarkable, and says that if it is taken the server moves to the next free one
 * and says so (docs/design.md, "CLI and distribution") — a second Workspace open in
 * another terminal is an ordinary Tuesday, not an error.
 *
 * Listening is a parameter so this can be tested against a real socket, a fake, or the
 * Hono adapter, none of which this module needs to know about.
 */

/** How far past the preferred port to look before giving up. */
export const PORT_ATTEMPTS = 20;

export type Listening<S> = { listening: S; port: number };

/**
 * The first port from `preferred` upwards that something else is not already holding.
 *
 * Only "address in use" moves to the next port. A refused permission or an address that
 * does not exist on this machine would repeat identically 20 times, so it is thrown at
 * once with its own message rather than buried under a wall of retries.
 */
export async function onAFreePort<S>(
  listen: (port: number) => Promise<S>,
  preferred: number,
  attempts: number = PORT_ATTEMPTS,
): Promise<Listening<S>> {
  let lastError: unknown;

  for (let port = preferred; port < preferred + attempts; port += 1) {
    try {
      return { listening: await listen(port), port };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      lastError = error;
    }
  }

  throw new Error(
    `biu-cs-planner: ports ${preferred} to ${preferred + attempts - 1} are all in use.`,
    { cause: lastError },
  );
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}
