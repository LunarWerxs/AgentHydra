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
//   --version | -v                → print the app version and exit
//   --instances | --instance-mode → the lightweight instance launcher (./instance-mode.ts)
//   --mcp                         → the MCP stdio server (./mcp.ts)
//   __dispatch_runner <specPath>  → the detached per-run supervisor (./dispatch-runner.ts)
//   __fake_claude <prompt>        → the AGENTHYDRA_FAKE stand-in for `claude` (./fake-claude.ts)
//
// Imports are dynamic per-branch ON PURPOSE: the runner/fake modes must never open the daemon's
// sqlite DB or bind ports, and --version must answer instantly.

const [mode, ...rest] = process.argv.slice(2)

if (mode === '--version' || mode === '-v') {
  const { VERSION } = await import('./config')
  console.log(VERSION)
  process.exit(0)
} else if (mode === '--instances' || mode === '--instance-mode') {
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
  await import('./index')
}
