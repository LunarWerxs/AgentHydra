// server/src/session-launch.ts — start a NEW interactive Claude session in a visible terminal.
//
// WHY THIS EXISTS. The orchestrator's handoff continuations used to go through the headless
// queue, and the owner's verdict after the first real run was immediate: "none of the chats
// that say 'Handoff continued in a new session' show any new session running ANYWHERE." A
// headless run is real work, but it is invisible in the desktop app and it does not register
// as a live peer session, so the orchestrator itself cannot nudge it either. An INTERACTIVE
// terminal session fixes both at once: the window is on the user's screen, and the session
// joins ~/.claude/sessions and the peer-messaging daemon, so it is orchestratable like any
// desktop chat. (A new DESKTOP-app chat cannot be created externally at all — there is no
// stable interface for it; the terminal window is the visible surface that exists.)
//
// THIS WINDOW IS MEANT TO BE SEEN — `windowsHide` is deliberately ABSENT, same posture and
// same guard exemption as session-resume.ts (scripts/checks/spawn-console-window.mjs).
//
// CREDENTIALS. A launch pinned to an instance runs on THAT instance's account:
//   · 'cli:<id>'      → CLAUDE_CONFIG_DIR points at the CLI instance's config dir. No token
//                       ever touches this process; `claude` reads its own credential file.
//   · 'desktop:<dir>' → the desktop app's OAuth token, extracted value-blind at spawn
//                       (core/accounts.ts resolveInstanceToken — the same in-process-only
//                       discipline every other token path here keeps) and passed as
//                       CLAUDE_CODE_OAUTH_TOKEN/-_SCOPES in the child's environment only.
//                       Never persisted, logged, or returned to any caller.
//
// THE PROMPT RIDES IN A FILE, not on the command line. Handoff prompts are long, multiline,
// and full of quoting hazards; a temp file plus `Get-Content -Raw` / `$(cat …)` delivers the
// exact bytes where cmd/bash quoting would mangle them. The file holds a task description,
// never a secret, and is left for the OS temp cleaner (deleting it too early would race the
// terminal still starting up).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeExe } from './config'
import { resolveInstanceToken } from './core/accounts'
import { getCliInstance } from './core/cli-instances'
import { resolveLaunchBinary } from './core/paths'

/**
 * The newest CLI the pinned desktop instance itself bundles
 * (`<dir>/claude-code/<version>/claude.exe`), or null when it has none.
 *
 * Preferring this over the machine's global `claude` is not cosmetic: measured 2026-08-25, the
 * globally installed npm CLI (2.1.220) writes a live-registry entry but hosts NO peer-messaging
 * socket, so a session launched with it is invisible to SendMessage — the orchestrator could
 * start it but never steer it. The desktop-bundled CLI (2.1.237) is the version whose peer
 * plumbing provably interoperates with the rest of the fleet on this machine.
 */
export function bundledClaudeExe(instanceDir: string): string | null {
  try {
    const root = join(instanceDir, 'claude-code')
    const best = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ v: d.name, key: d.name.split('.').map((n) => Number(n) || 0) }))
      .sort(
        (a, b) =>
          (b.key[0] ?? 0) - (a.key[0] ?? 0) ||
          (b.key[1] ?? 0) - (a.key[1] ?? 0) ||
          (b.key[2] ?? 0) - (a.key[2] ?? 0),
      )[0]
    if (!best) return null
    const exe = join(root, best.v, process.platform === 'win32' ? 'claude.exe' : 'claude')
    return existsSync(exe) ? exe : null
  } catch {
    return null
  }
}

export interface TerminalLaunchPlan {
  /** What to spawn. Empty when this platform has no known way to open a terminal. */
  argv: string[]
  /** A copyable equivalent, for the caller/UI when the spawn cannot work. */
  command: string
}

/** Pure and platform-parameterised, like session-resume's buildResumePlan, so tests can pin
 *  every platform from one machine. `promptFile` carries the initial prompt's exact bytes. */
export function buildTerminalLaunchPlan(
  platform: NodeJS.Platform,
  exe: string,
  promptFile: string,
  model: string | null,
  effort: string | null = null,
): TerminalLaunchPlan {
  const modelArgs = `${model ? ` --model ${model}` : ''}${effort ? ` --effort ${effort}` : ''}`
  if (platform === 'win32') {
    // PowerShell (not cmd) runs the claude line: `Get-Content -Raw` hands the multiline prompt
    // over as ONE argv element, which cmd cannot do. -NoExit keeps the window (and any startup
    // error) on screen, the same reason session-resume uses `cmd /k`.
    const ps = `& '${exe.replaceAll("'", "''")}'${modelArgs} (Get-Content -Raw '${promptFile.replaceAll("'", "''")}')`
    return {
      argv: ['cmd', '/c', 'start', '', 'powershell', '-NoExit', '-Command', ps],
      command: ps,
    }
  }
  const sh = `"${exe}"${modelArgs} "$(cat '${promptFile}')"`
  if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(sh)}`
    return { argv: ['osascript', '-e', script], command: sh }
  }
  if (platform === 'linux') {
    return { argv: ['x-terminal-emulator', '-e', 'bash', '-lc', `${sh}; exec bash`], command: sh }
  }
  return { argv: [], command: sh }
}

export interface TerminalLaunchResult {
  ok: boolean
  /** Why the terminal did not open, when it did not. */
  reason?: string
  /** The launch line (minus environment), for the copy fallback. */
  command: string
}

/**
 * Open a visible terminal running a NEW `claude` session in `cwd` with `prompt` as its first
 * message, on the account `instanceRef` names (or the ambient login when null). The session id
 * is chosen by the CLI itself; within seconds the session appears in ~/.claude/sessions, which
 * is where the orchestrator watcher (and anyone else) picks it up.
 */
export async function launchTerminalSession(opts: {
  cwd: string
  prompt: string
  instanceRef?: string | null
  model?: string | null
  effort?: string | null
}): Promise<TerminalLaunchResult> {
  const env: Record<string, string> = {}
  const ref = opts.instanceRef?.trim() || null
  let exe: string | null = null
  if (ref?.startsWith('cli:')) {
    const configDir = getCliInstance(ref.slice('cli:'.length))?.configDir
    if (!configDir) return { ok: false, reason: 'cli-instance-not-found', command: '' }
    env.CLAUDE_CONFIG_DIR = configDir
  } else if (ref?.startsWith('desktop:')) {
    const dir = ref.slice('desktop:'.length)
    const grant = await resolveInstanceToken(dir)
    // A pinned launch must never silently fall back to the ambient login — the exact rule
    // dispatch.ts enforces pre-launch, for the exact reason (wrong account pays).
    if (!grant) return { ok: false, reason: 'instance-token-unavailable', command: '' }
    env.CLAUDE_CODE_OAUTH_TOKEN = grant.token
    if (grant.scopes) env.CLAUDE_CODE_OAUTH_SCOPES = grant.scopes
    exe = bundledClaudeExe(dir) // see bundledClaudeExe: the peer-capable CLI wins
  } else if (ref) {
    return { ok: false, reason: `malformed instance ref (${ref})`, command: '' }
  }

  const dir = join(tmpdir(), 'agenthydra-launch')
  mkdirSync(dir, { recursive: true })
  const promptFile = join(dir, `prompt-${crypto.randomUUID()}.txt`)
  writeFileSync(promptFile, opts.prompt)

  const plan = buildTerminalLaunchPlan(
    process.platform,
    exe ?? resolveClaudeExe(),
    promptFile,
    opts.model?.trim() || null,
    opts.effort?.trim() || null,
  )
  if (plan.argv.length === 0) return { ok: false, reason: 'no-terminal', command: plan.command }
  // The child gets a SANITIZED environment: every CLAUDE*/ANTHROPIC* variable the daemon itself
  // inherited is dropped before the pinned credentials go in. Measured 2026-08-25: a daemon that
  // had been (re)started from inside a Claude session leaked that session's CLAUDE_CODE_* vars
  // into the launched terminal — the new session came up marked as a CHILD session (transcript
  // saving off, never registered as a live peer), on the WRONG account, with bypass-permissions
  // inherited. Exactly the trap AI_USAGE_SELFCHECK.md documents: spawned-claude runs must start
  // from a clean env or the parent's environment masks everything.
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue
    if (/^(CLAUDE|ANTHROPIC)/i.test(k)) continue
    cleanEnv[k] = v
  }
  try {
    Bun.spawn(plan.argv, {
      // No windowsHide: see the header. This window is the point.
      cwd: opts.cwd,
      env: { ...cleanEnv, ...env },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return { ok: true, command: plan.command }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'spawn-failed',
      command: plan.command,
    }
  }
}

// --- importing a finished session INTO the desktop app -----------------------
// `claude://resume?session=<id>` is the desktop app's own one-way import: it renders the
// session as a real chat in the app's sidebar. Verified live 2026-08-25 on an isolated
// instance: invoking the instance's binary with its --user-data-dir plus the URL makes
// Electron's single-instance lock forward the link to the RUNNING app, which imports and
// shows the chat (on the right account, since the profile dir picks the account).
//
// TWO HARD RULES, both from REFERENCE.md's warning and one measurement:
//   · NEVER import a session that is currently LIVE (an alive-pid registry entry): the import
//     rewrites the transcript under an active writer.
//   · A freshly imported chat registers a live session process but does NOT drain queued peer
//     messages until a human first interacts with it (measured). So finish all headless work
//     FIRST and import LAST — import is how finished work lands on the user's screen, not a
//     channel for driving further work.

/** Pure and platform-parameterised, like the launch plan above. `binary` is the desktop
 *  binary ('Claude' is the darwin open -na marker resolveLaunchBinary returns). */
export function buildImportPlan(
  platform: NodeJS.Platform,
  binary: string,
  instanceDir: string,
  sessionId: string,
): string[] {
  const url = `claude://resume?session=${sessionId}`
  const dataDir = `--user-data-dir=${instanceDir}`
  if (platform === 'darwin' && binary === 'Claude')
    return ['open', '-na', 'Claude', '--args', dataDir, url]
  return [binary, dataDir, url]
}

async function defaultInstanceRunning(instanceDir: string): Promise<boolean> {
  const { listInstances } = await import('./core/instances')
  const needle = instanceDir.replace(/[\\/]+$/, '').toLowerCase()
  return (await listInstances()).some(
    (i) => i.isRunning && i.dir.replace(/[\\/]+$/, '').toLowerCase() === needle,
  )
}

/** The live registry entry (with an alive pid) for this session, or null. Exported for the
 *  migrate flow, which needs the pid to stop a live chat the user asked to move. */
export function liveSessionEntry(sessionId: string): { pid: number } | null {
  try {
    const dir = join(homedir(), '.claude', 'sessions')
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const reg = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        if (reg?.sessionId !== sessionId || typeof reg?.pid !== 'number') continue
        try {
          process.kill(reg.pid, 0)
          return { pid: reg.pid }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EPERM') return { pid: reg.pid }
        }
      } catch {
        // one unreadable entry says nothing about the others
      }
    }
  } catch {
    // no registry dir — nothing can be live
  }
  return null
}

function sessionIsLive(sessionId: string): boolean {
  return liveSessionEntry(sessionId) !== null
}

// --- archiving a desktop chat by its metadata file ---------------------------
// The desktop keeps one metadata file per chat — `claude-code-sessions/<org>/<user>/
// local_<cliSessionId>.json` — with an `isArchived` boolean. Flipping it IS the archive, with
// one measured caveat that callers must repeat honestly: a RUNNING app keeps its chat list in
// memory, so the change shows only after that instance next restarts (and a running app may
// re-save the file and undo the flip). For a chat in a closed instance it is reliable and
// immediate-on-next-open.

export interface DesktopArchiveHit {
  /** Instance dir (or the default profile) whose store carried this chat. */
  profile: string
  /** The instance's app was running when the flag was written — the caveat applies. */
  wasRunning: boolean
}

export async function archiveDesktopChat(
  sessionId: string,
  archived: boolean,
  roots?: string[],
  isInstanceRunning: (dir: string) => Promise<boolean> = defaultInstanceRunning,
): Promise<{ ok: boolean; hits: DesktopArchiveHit[]; reason?: string }> {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const searchRoots = roots ?? [
    join(appData, 'Claude'),
    ...((): string[] => {
      const root = join(homedir(), '.claude-instances')
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(root, d.name))
      } catch {
        return []
      }
    })(),
  ]
  const hits: DesktopArchiveHit[] = []
  for (const profile of searchRoots) {
    const store = join(profile, 'claude-code-sessions')
    if (!existsSync(store)) continue
    // Filename IS the key (local_<cliSessionId>.json), two levels down (org/user).
    let found: string | null = null
    try {
      for (const org of readdirSync(store, { withFileTypes: true })) {
        if (!org.isDirectory()) continue
        for (const user of readdirSync(join(store, org.name), { withFileTypes: true })) {
          if (!user.isDirectory()) continue
          const p = join(store, org.name, user.name, `local_${sessionId}.json`)
          if (existsSync(p)) {
            found = p
            break
          }
        }
        if (found) break
      }
    } catch {
      continue
    }
    if (!found) continue
    try {
      const meta = JSON.parse(readFileSync(found, 'utf8'))
      meta.isArchived = archived
      writeFileSync(found, JSON.stringify(meta))
      hits.push({
        profile,
        wasRunning: await isInstanceRunning(profile).catch(() => false),
      })
    } catch {
      // An unwritable/corrupt metadata file: skip it rather than fail the others.
    }
  }
  if (hits.length === 0) return { ok: false, hits, reason: 'no-desktop-chat-found' }
  return { ok: true, hits }
}

export async function importSessionToDesktop(opts: {
  sessionId: string
  instanceDir: string
  /** Title for the imported chat. The import itself creates the chat as "Untitled" (the app
   *  derives nothing from the transcript at import time — measured: three migrated threads all
   *  landed as "Untitled"/generic), so the caller passes the thread's real title and it is
   *  written into the chat's metadata once the app has created the file. Shows immediately if
   *  the app re-reads, otherwise on that instance's next restart. */
  title?: string | null
  isLive?: (sessionId: string) => boolean
  /** Seam for tests; the default asks the instance manager. */
  isInstanceRunning?: (dir: string) => Promise<boolean>
}): Promise<{ ok: boolean; reason?: string; titled?: boolean }> {
  if ((opts.isLive ?? sessionIsLive)(opts.sessionId))
    return { ok: false, reason: 'session-live: refusing to import under an active writer' }
  if (!existsSync(opts.instanceDir)) return { ok: false, reason: 'instance-dir-not-found' }
  // The import spawn targets the RUNNING app via Electron's single-instance lock. Aimed at an
  // instance that is NOT running it does not fail — it BOOTS that instance, which is exactly
  // the owner's "never open accounts on your own" rule broken by a side door (and how a wrong
  // display-name-derived path silently started a sixth desktop app on 2026-08-25). Refuse.
  const running = await (opts.isInstanceRunning ?? defaultInstanceRunning)(opts.instanceDir)
  if (!running)
    return { ok: false, reason: 'instance-not-running: importing would boot that instance' }
  const binary = await resolveLaunchBinary()
  if (!binary) return { ok: false, reason: 'desktop-binary-not-found' }
  const argv = buildImportPlan(process.platform, binary, opts.instanceDir, opts.sessionId)
  try {
    // A GUI hand-off spawn: windowsHide deliberately absent (this file is exempt from the
    // console-window guard for exactly this class of spawn).
    Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'spawn-failed' }
  }
  const title = opts.title?.trim()
  if (!title) return { ok: true }
  // Wait for the app to create the chat's metadata file, then write the title into it.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const outcome = applyDesktopChatTitle(opts.instanceDir, opts.sessionId, title)
    if (outcome !== 'not-found') return { ok: true, titled: outcome === 'titled' }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: true, titled: false }
}

/**
 * One attempt to write a title into a chat's desktop metadata (`{ title, titleSource }`, the
 * same field pair the app's own rename writes). 'not-found' means the app has not created the
 * metadata file yet — the import waiter retries on that; 'failed' means the file exists but
 * could not be updated (contended/corrupt), which is terminal for titling but not for the
 * import itself.
 */
export function applyDesktopChatTitle(
  instanceDir: string,
  sessionId: string,
  title: string,
): 'titled' | 'not-found' | 'failed' {
  const store = join(instanceDir, 'claude-code-sessions')
  let metaPath: string | null = null
  try {
    for (const org of readdirSync(store, { withFileTypes: true })) {
      if (!org.isDirectory()) continue
      for (const user of readdirSync(join(store, org.name), { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        const p = join(store, org.name, user.name, `local_${sessionId}.json`)
        if (existsSync(p)) {
          metaPath = p
          break
        }
      }
      if (metaPath) break
    }
  } catch {
    return 'not-found' // store not created yet
  }
  if (!metaPath) return 'not-found'
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    meta.title = title
    meta.titleSource = 'tool'
    writeFileSync(metaPath, JSON.stringify(meta))
    return 'titled'
  } catch {
    return 'failed'
  }
}
