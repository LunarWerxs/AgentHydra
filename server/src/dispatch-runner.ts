// server/src/dispatch-runner.ts — the DETACHED per-run supervisor for a dispatched `claude` CLI run.
//
// WHY this process exists: a dispatch run must OUTLIVE the daemon (quitting AgentHydra, or an
// auto-update relaunch, tree-kills the daemon — see server-lib/detached-spawn.mjs). If the daemon
// spawned `claude` directly it would (a) be a daemon descendant reaped by `taskkill /T`, and (b) hold
// `claude`'s stdout pipe, which breaks the instant the daemon dies. So dispatch.ts instead spawns
// THIS runner detached (`buildDetachedSpawn`), and the runner owns `claude`: it re-parents `claude`
// as ITS child (not the daemon's), captures `claude`'s stdout/stderr, and appends them to a per-run
// log file that the daemon TAILS. When the daemon dies, the runner + `claude` keep running to
// completion, still writing the log; the next daemon reattaches by re-reading the log + a terminal
// marker (see dispatch.ts reattachRuns). Verified end-to-end 2026-07-12.
//
// Run as: `bun dispatch-runner.ts <specPath>` from a source checkout, or as the compiled exe's
// `__dispatch_runner <specPath>` subcommand (server/src/main.ts) — a compiled binary can't spawn
// sibling .ts files by path, so it re-spawns itself. Spec written by dispatch.ts, JSON.
//
// The log is an append-only stream: `claude`'s raw stdout lines (stream-json) verbatim, plus two
// kinds of runner marker lines the daemon recognizes:
//   {"__dispatch":"stderr","text":"…"}   the aggregated child stderr (rate-limit sniffing + a meta event)
//   {"__dispatch":"exit","code":N}       the child has exited; the daemon finalizes status from N
// The secret for the run's account is read from the DB HERE (by account_id in the spec), so it is
// NEVER written to the spec file on disk.

import { Database } from 'bun:sqlite'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolveCliConfigDirToken, resolveInstanceToken } from './core/accounts'
import { DEFAULT_OAUTH_SCOPES } from './usage'

// The runner is launched DETACHED via WMI (Win32_Process.Create — see dispatch.ts) so it escapes the
// Bun daemon's job object; that also means it does NOT inherit the daemon's process env. So it is
// fully self-contained: everything it needs (child argv, cwd, account, and the DB PATH to read the
// account secret from) comes from the spec file, never from env. Its own process.env is the user's
// profile env (HOME/APPDATA/PATH), which is what `claude` needs to find its config + auth.
interface RunSpec {
  itemId: string
  /** Full child command line: [claudeExe, ...flags, prompt]. Contains no secret. */
  childArgv: string[]
  cwd: string
  /** Account whose credential to inject (secret read from the DB here, not carried in the spec). */
  accountId: string | null
  /** Run under a signed-in DESKTOP instance: its --user-data-dir. The runner extracts that
   *  instance's OAuth token value-blind at spawn time (core/accounts.ts resolveInstanceToken) —
   *  the spec carries only the path, never a credential. Wins over accountId when both are set. */
  desktopDir: string | null
  /** Run under a signed-in CLI instance: its CLAUDE_CONFIG_DIR (same value-blind discipline,
   *  via resolveCliConfigDirToken). Wins over accountId when both are set. */
  cliConfigDir: string | null
  /** Absolute path to the sqlite DB, so the runner can read the account secret without the daemon's env. */
  dbPath: string
  /** Non-secret env overrides (e.g. FAKE_SESSION_ID / FAKE_SLEEP_MS for the test stand-in). */
  envExtra: Record<string, string>
  logPath: string
  statusPath: string
}

/** Append one line (adds the trailing newline). Synchronous so ordering + durability hold even if
 *  the runner is killed mid-run — the daemon reads whatever reached disk. */
function logLine(logPath: string, text: string): void {
  try {
    appendFileSync(logPath, `${text}\n`)
  } catch {
    // best-effort: a transient FS error on one line must not abort the whole run
  }
}

function writeStatus(spec: RunSpec, extra: Record<string, unknown>): void {
  try {
    writeFileSync(spec.statusPath, JSON.stringify({ runnerPid: process.pid, ...extra }))
  } catch {
    // best-effort
  }
}

/** Injects an OAuth token + its scopes, clearing any ambient credential first so the run never
 *  silently falls back to whatever the profile env happened to carry. */
function injectOauth(env: Record<string, string>, token: string, scopes: string | null): void {
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  env.CLAUDE_CODE_OAUTH_TOKEN = token
  // Scopes MUST ride along or `claude` silently stops handling slash-command prompts (exit 0,
  // nothing useful) — see DEFAULT_OAUTH_SCOPES in ./usage.ts for the full write-up.
  env.CLAUDE_CODE_OAUTH_SCOPES = scopes?.trim() || DEFAULT_OAUTH_SCOPES
}

/** Build the child env: the runner's inherited env (the daemon's env at spawn), the non-secret
 *  overrides, then the run's credential. Instance-derived identity (desktopDir / cliConfigDir)
 *  resolves the token value-blind from that instance's own storage and FAILS THE RUN when it
 *  can't (a signed-out instance must surface as "signed out", never silently run as Ambient);
 *  the sqlite accountId path keeps its historical lenient behavior. */
async function buildChildEnv(
  spec: RunSpec,
): Promise<{ env: Record<string, string> } | { error: string }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...spec.envExtra,
  }
  if (spec.desktopDir) {
    const resolved = await resolveInstanceToken(spec.desktopDir).catch(() => null)
    if (!resolved) {
      return {
        error: `couldn't resolve a login token from the desktop instance at ${spec.desktopDir} — is it still signed in?`,
      }
    }
    injectOauth(env, resolved.token, resolved.scopes)
    return { env }
  }
  if (spec.cliConfigDir) {
    let resolved: { token: string; scopes: string } | null = null
    try {
      resolved = resolveCliConfigDirToken(spec.cliConfigDir)
    } catch {
      resolved = null
    }
    if (!resolved) {
      return {
        error: `couldn't resolve a login token from the CLI instance at ${spec.cliConfigDir} — run its sign-in (/login) again?`,
      }
    }
    injectOauth(env, resolved.token, resolved.scopes)
    return { env }
  }
  if (spec.accountId) {
    let acct: { auth_type: string; secret: string } | null = null
    try {
      const rdb = new Database(spec.dbPath, { readonly: true })
      acct = rdb
        .query<{ auth_type: string; secret: string }, [string]>(
          'select auth_type, secret from accounts where id = ?',
        )
        .get(spec.accountId)
      rdb.close()
    } catch {
      acct = null
    }
    if (!acct) {
      return {
        error:
          "couldn't read the selected dispatch account's credential — re-add that account before running it",
      }
    }
    if (acct.auth_type === 'api_key') {
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      env.ANTHROPIC_API_KEY = acct.secret
    } else {
      injectOauth(env, acct.secret, null)
    }
  }
  return { env }
}

async function main(specPath: string | undefined): Promise<void> {
  if (!specPath) process.exit(2)
  const spec: RunSpec = JSON.parse(readFileSync(specPath, 'utf8'))
  const startedAt = new Date().toISOString()

  // Resolve the run's credential BEFORE spawning: an instance-derived identity that can't
  // resolve (signed out, deleted profile) fails the run loudly here, with the reason in the
  // log — it must never silently run as Ambient instead.
  const built = await buildChildEnv(spec)
  if ('error' in built) {
    logLine(spec.logPath, JSON.stringify({ __dispatch: 'stderr', text: built.error }))
    logLine(
      spec.logPath,
      JSON.stringify({ __dispatch: 'exit', code: -1, at: new Date().toISOString() }),
    )
    writeStatus(spec, { childPid: null, startedAt, state: 'exited', code: -1 })
    process.exit(0)
  }

  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(spec.childArgv, {
      cwd: spec.cwd,
      env: built.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  } catch (err) {
    // Never even launched: leave a terminal marker so the daemon finalizes as failed.
    logLine(
      spec.logPath,
      JSON.stringify({ __dispatch: 'stderr', text: `spawn failed: ${String(err)}` }),
    )
    logLine(
      spec.logPath,
      JSON.stringify({ __dispatch: 'exit', code: -1, at: new Date().toISOString() }),
    )
    writeStatus(spec, { childPid: null, startedAt, state: 'exited', code: -1 })
    process.exit(0)
  }

  writeStatus(spec, { childPid: proc.pid ?? null, startedAt, state: 'running' })

  const pumpStdout = (async () => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        // append the child's stream-json line verbatim (the daemon parses it exactly as before)
        logLine(spec.logPath, buf.slice(0, idx))
        buf = buf.slice(idx + 1)
        idx = buf.indexOf('\n')
      }
    }
    if (buf.trim()) logLine(spec.logPath, buf.trim())
  })()

  const pumpStderr = (async () => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
    }
    const errText = buf.trim()
    if (errText)
      logLine(spec.logPath, JSON.stringify({ __dispatch: 'stderr', text: errText.slice(0, 4000) }))
  })()

  const exitCode = await proc.exited
  await Promise.allSettled([pumpStdout, pumpStderr])
  // terminal marker LAST, after all stdout/stderr reached the log, so a tailing daemon never
  // finalizes before it has seen the full output.
  logLine(
    spec.logPath,
    JSON.stringify({ __dispatch: 'exit', code: exitCode, at: new Date().toISOString() }),
  )
  writeStatus(spec, { childPid: proc.pid ?? null, startedAt, state: 'exited', code: exitCode })
  process.exit(0)
}

/** The runner's whole lifecycle, error-fenced: any throw still leaves a terminal exit marker in
 *  the log so the daemon can finalize the run instead of leaving it stuck 'running'. */
export async function runDispatchRunner(specPath: string | undefined): Promise<void> {
  try {
    await main(specPath)
  } catch (err) {
    try {
      if (specPath) {
        const spec: RunSpec = JSON.parse(readFileSync(specPath, 'utf8'))
        logLine(
          spec.logPath,
          JSON.stringify({ __dispatch: 'stderr', text: `runner error: ${String(err)}` }),
        )
        logLine(
          spec.logPath,
          JSON.stringify({ __dispatch: 'exit', code: -1, at: new Date().toISOString() }),
        )
        writeStatus(spec, {
          childPid: null,
          startedAt: new Date().toISOString(),
          state: 'exited',
          code: -1,
        })
      }
    } catch {
      // nothing more we can do
    }
    process.exit(0)
  }
}

if (import.meta.main) {
  await runDispatchRunner(process.argv[2])
}
