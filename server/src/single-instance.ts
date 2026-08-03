/**
 * Whether this process must SKIP the single-instance "/api/health" guard in index.ts.
 *
 * Two cases skip it:
 *  - AGENTHYDRA_PORT_FIXED=1: the dev launcher pins the port and runs its own pre-flight.
 *  - AGENTHYDRA_RELAUNCH=1: the auto-update successor. Its predecessor is still alive and
 *    answering /api/health during the ~800ms handoff, so probing here would see
 *    "already running" and make the successor exit, leaving ZERO daemons. It instead
 *    takes over the port via waitForPortFree().
 *
 * Both names are also accepted in their pre-rename `CCMANAGERUI_*` spelling, and that is
 * load-bearing exactly once: the LAST CC Manager UI release is the process that spawns the first
 * AgentHydra one, and it sets `CCMANAGERUI_RELAUNCH=1`. Without the fallback that upgrade lands in
 * the zero-daemons race described above.
 *
 * Kept pure and in its own module so it can be unit-tested without importing index.ts
 * (which boots the daemon on import) or config.ts (whose import migrates the config dir). This is
 * the regression guard for the relaunch zero-instances race: if the RELAUNCH branch is ever
 * dropped, the test fails.
 */
export function skipSingleInstanceGuard(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = (suffix: string) =>
    env[`AGENTHYDRA_${suffix}`] === '1' || env[`CCMANAGERUI_${suffix}`] === '1'
  return on('PORT_FIXED') || on('RELAUNCH')
}
