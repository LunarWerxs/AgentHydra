// server/src/main.ts — the ONE entrypoint for every process mode, source or compiled.
//
// A `bun build --compile` binary cannot spawn sibling .ts files by path (import.meta.dir is a
// virtual embedded-fs path inside the exe), so every process this app used to reach as
// `bun <file>.ts` is a SUBCOMMAND of this entry instead: the compiled exe re-spawns ITSELF with a
// mode argv (see dispatch.ts runnerArgv). process.argv.slice(2) carries the real CLI args
// identically in both modes — plain bun fills argv[0..1] with [bunPath, scriptPath], a compiled
// exe fills them with a fixed placeholder pair — so this dispatch is mode-agnostic.
//
// Modes:
//   (none)                        → the daemon (./index.ts — serves the UI + API)
//   --version | -v                → print the app version and exit (add --json for build metadata)
//   --spend [--json] [--period=]   → token/dollar totals from the stored analytics (./analytics.ts)
//   --instances | --instance-mode → the lightweight instance launcher (./instance-mode.ts)
//   --mcp                         → the MCP stdio server (./mcp.ts)
//   __dispatch_runner <specPath>  → the detached per-run supervisor (./dispatch-runner.ts)
//   __fake_claude <prompt>        → the AGENTHYDRA_FAKE stand-in for `claude` (./fake-claude.ts)
//
// Imports are dynamic per-branch ON PURPOSE: the runner/fake modes must never open the daemon's
// sqlite DB or bind ports, and --version must answer instantly.

const [mode, ...rest] = process.argv.slice(2)

if (mode === '--version' || mode === '-v') {
  // --json prints a schema-versioned object instead of the bare version, for scripts and CI. Still
  // no database and still no port: it imports one module that reads a bundled constant, and at most
  // shells out to `git rev-parse` when running from a checkout. See ./build-info.ts.
  if (rest.includes('--json')) {
    const { buildInfo } = await import('./build-info')
    console.log(JSON.stringify(buildInfo()))
  } else {
    const { VERSION } = await import('./config')
    console.log(VERSION)
  }
  process.exit(0)
} else if (mode === '--spend') {
  // Scriptable spend, straight to stdout. Reads the totals the daemon already computed rather than
  // re-scanning, so it is instant and answers the same numbers the UI shows; a store the daemon has
  // never warmed reports zero sessions and says so in `coverage` rather than pretending.
  //
  // This DOES open the database (unlike --version, which must not), because there is nowhere else
  // the numbers live. It never binds a port.
  const { spendReport } = await import('./analytics')
  const { isSessionPeriod, periodCutoffMs } = await import('./types')
  const raw = rest.find((a) => a.startsWith('--period='))?.slice('--period='.length)
  const period = isSessionPeriod(raw) ? raw : '30d'
  const report = spendReport({ sinceMs: periodCutoffMs(period) })
  if (rest.includes('--json')) {
    console.log(JSON.stringify(report))
  } else {
    const usd = (n: number | null) => (n === null ? '     —' : `$${n.toFixed(2)}`.padStart(10))
    console.log(`AgentHydra spend, last ${period} (list prices; a plan is not billed per token)`)
    console.log(`  sessions ${report.sessions}   total ${usd(report.totalCostUsd)}`)
    if (report.unpricedModels.length)
      console.log(`  unpriced: ${report.unpricedModels.join(', ')} — the total is a floor`)
    for (const b of report.byModel) console.log(`  ${usd(b.costUsd)}  ${b.key}`)
    console.log(`  coverage ${report.coverage.sessions}/${report.coverage.total} sessions scanned`)
  }
  process.exit(0)
} else if (mode === '--instances' || mode === '--instance-mode') {
  // Armed BEFORE the import: a hang inside instance-mode.ts's own module graph (import-time code,
  // same as the daemon's db.ts/scheduler.ts below) is in scope, and arming has to precede it. See
  // ./boot-watchdog.ts; instance mode gets the short deadline since it's meant to be quick.
  const { armBootWatchdog, INSTANCE_MODE_BOOT_DEADLINE_MS } = await import('./boot-watchdog')
  armBootWatchdog(INSTANCE_MODE_BOOT_DEADLINE_MS)
  await import('./instance-mode')
} else if (mode === '--mcp') {
  const { runMcp } = await import('./mcp')
  await runMcp()
} else if (mode === '__dispatch_runner') {
  const { runDispatchRunner } = await import('./dispatch-runner')
  await runDispatchRunner(rest[0])
} else if (mode === '__fake_claude') {
  const { runFakeClaude } = await import('./fake-claude')
  await runFakeClaude(rest[0])
} else {
  // Default: the daemon. Unknown args are ignored, matching index.ts's own historical behavior.
  //
  // Arm the startup watchdog HERE, before importing index.ts, not inside it: importing index.ts is
  // what pulls in db.ts (schema open + migrations) and, transitively via http-app.ts, scheduler.ts
  // (which arms its own poll timer at module load) - both run as import-time side effects, before a
  // single line of index.ts's own body executes, so arming from inside index.ts would already be
  // too late to cover them. See ./boot-watchdog.ts's module docstring.
  const { armBootWatchdog, DEFAULT_BOOT_DEADLINE_MS } = await import('./boot-watchdog')
  armBootWatchdog(DEFAULT_BOOT_DEADLINE_MS)
  await import('./index')
}
