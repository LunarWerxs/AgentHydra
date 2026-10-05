/**
 * Shared free-port finder for the LunarWerx daemons. Walks upward from `preferred`,
 * actually binding a throwaway net.Server at each candidate (the only race-free way
 * to know a port is free), and resolves the first one that binds, so a daemon never
 * dies on a busy port; it just moves over. Promoted verbatim from DevWebUI's
 * server/src/ports.ts; RepoYeti's inline Bun.serve bind-loop adopts it too.
 *
 * Runtime-agnostic (Bun + Node). Synced from the shared kit, do not edit in
 * an app. (Reimagine intentionally does NOT use this: its launcher force-kills the
 * old instance and retries the SAME port, see the comment in its server.js.)
 */
import net from "node:net";

/**
 * Pass `host` when the real server will bind a specific interface (e.g. RepoYeti's
 * 127.0.0.1), probing the wildcard address can miss a squatter that holds only the
 * loopback IPv4 port. Omitted, the probe binds the wildcard (DevWebUI's behavior).
 */
export function findFreePort(preferred, attempts = 50, host = undefined) {
  return new Promise((resolve, reject) => {
    let port = preferred;
    let tries = 0;
    const tryNext = () => {
      if (port > 65535) {
        reject(new RangeError(`findFreePort: no free port between ${preferred} and 65535`));
        return;
      }
      const srv = net.createServer();
      srv.once("error", (err) => {
        srv.close();
        // EADDRINUSE / EACCES → step to the next port; anything else is fatal.
        const portBusy = err.code === "EADDRINUSE" || err.code === "EACCES";
        if (portBusy && tries < attempts) {
          tries++;
          port++;
          tryNext();
        } else if (portBusy) {
          // Ran out of attempts before crossing 65535, same logical failure as the
          // overflow guard above, so report it the same descriptive way (not a raw
          // EADDRINUSE the caller would have to decode).
          reject(
            new RangeError(`findFreePort: no free port found in ${attempts} attempts from ${preferred}`),
          );
        } else {
          reject(err); // unexpected OS error, surface it as-is
        }
      });
      srv.once("listening", () => srv.close(() => resolve(port)));
      if (host) srv.listen(port, host);
      else srv.listen(port);
    };
    tryNext();
  });
}
