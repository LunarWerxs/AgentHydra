/**
 * Whether this process must SKIP the single-instance "/api/health" guard in index.ts.
 *
 * Two cases skip it:
 *  - DEVWEBUI_PORT_FIXED=1: the dev launcher pins the port, runs its own pre-flight, and
 *    its `--watch` reloads must be free to rebind the same port.
 *  - DEVWEBUI_RELAUNCH=1: the auto-update successor. Its predecessor is still alive and
 *    answering /api/health during the ~800ms handoff, so probing here would see
 *    "already running" and make the successor exit, leaving ZERO daemons. It instead
 *    takes over the port via waitForPortFree().
 *
 * The relaunch case is signalled by EITHER the `--relaunch` flag or DEVWEBUI_RELAUNCH=1, and the
 * flag is the load-bearing half on Windows: the relaunch is handed to WMI Win32_Process.Create
 * (see buildDetachedSpawn), which takes a command LINE and does NOT inherit the caller's
 * environment block. Checking the env alone would let a win32 successor fall into exactly the
 * zero-daemons race this function exists to prevent.
 *
 * Kept pure and in its own module so it can be unit-tested without importing index.ts
 * (which boots the daemon on import). This is the regression guard for the relaunch
 * zero-instances race: if the relaunch branch is ever dropped, the test fails.
 */
export function skipSingleInstanceGuard(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  return (
    env.DEVWEBUI_PORT_FIXED === "1" || env.DEVWEBUI_RELAUNCH === "1" || argv.includes("--relaunch")
  );
}
