// server/src/session-launch.ts — start a NEW interactive Claude session in a visible terminal.
//
// WHY THIS EXISTS. Continuations used to go through the headless queue, and the owner's
// verdict after the first real run was immediate: "none of the chats that say 'Handoff
// continued in a new session' show any new session running ANYWHERE." A headless run is real
// work, but it is invisible in the desktop app and it does not register as a live peer
// session, so nothing can nudge it either. An INTERACTIVE terminal session fixes both at
// once: the window is on the user's screen, and the session joins ~/.claude/sessions and the
// peer-messaging daemon, so peer messaging can reach it like any desktop chat. (A new
// DESKTOP-app chat cannot be created externally at all — there is no stable interface for
// it; the terminal window is the visible surface that exists.)
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
import { join, sep } from 'node:path'
import { GENERIC_CHAT_TITLE, isGenericChatTitle, PLUMBING_CHAT_TITLE } from './chat-title'
import { resolveClaudeExe } from './config'
import { resolveInstanceToken } from './core/accounts'
import { getCliInstance } from './core/cli-instances'
import { resolveLaunchBinary } from './core/paths'
import { db } from './db'
import { findDesktopChat, invalidateSessionMetaCache } from './instance-sessions'
import { applyNewChatDefaults } from './new-chat-defaults'
import { samePathKey } from './path-key'

/**
 * One lineage, one continuation. A done-marked session (session_marks.done = 1) was handed off,
 * migrated onward, or closed out — its successor owns the task now. Reviving the old copy sets
 * TWO sessions working (and overwriting) the same files, which the owner hit in the field
 * (2026-08-25: chats complaining their work was overridden by other chats). Every resume/import
 * path checks this ledger; callers that genuinely mean to resurrect a retired thread pass
 * force: true (after un-marking it, they own the consequences).
 */
export function isSessionSuperseded(sessionId: string): boolean {
  try {
    const row = db
      .query<{ done: number }, [string]>('select done from session_marks where session_id = ?')
      .get(sessionId)
    return !!row?.done
  } catch {
    return false
  }
}

/**
 * The newest CLI the pinned desktop instance itself bundles
 * (`<dir>/claude-code/<version>/claude.exe`), or null when it has none.
 *
 * Preferring this over the machine's global `claude` is not cosmetic: measured 2026-08-25, the
 * globally installed npm CLI (2.1.220) writes a live-registry entry but hosts NO peer-messaging
 * socket, so a session launched with it is invisible to SendMessage — a peer could
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
  resumeSessionId: string | null = null,
  permissionMode: string | null = null,
): TerminalLaunchPlan {
  // With resumeSessionId, the window CONTINUES an existing thread (--resume) with the prompt as
  // its next turn — the visible alternative to a headless queue resume, per the owner's standing
  // rule that nothing runs headless: work happens where it can be watched.
  // An UNATTENDED window must not stop on a per-command approval prompt, because nobody is
  // there to answer it. Opt-in: a caller that does not ask keeps the CLI's own default.
  const modelArgs = `${resumeSessionId ? ` --resume ${resumeSessionId}` : ''}${model ? ` --model ${model}` : ''}${effort ? ` --effort ${effort}` : ''}${permissionMode ? ` --permission-mode ${permissionMode}` : ''}`
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

/**
 * Is `cwd` trusted for the CLI config at `configDir` (null = the ambient ~/.claude.json), and
 * if it is trusted under a DIFFERENT spelling of the same path, mirror it onto the spelling
 * that is missing so the launch does not stop on a dialog.
 *
 * The CLI keys `projects` by the literal cwd string, so `D:\\PublicProjects` and
 * `D:/PublicProjects` are two records of one folder and can disagree. On this machine they DO:
 * one true, one false, which is how a launch into a long-trusted folder hangs on the trust
 * prompt. Mirroring an existing YES is a normalization, not a new grant.
 *
 * It deliberately does NOT trust a folder nobody has trusted. A launcher that answered the
 * security question on the owner's behalf would be worse than a launcher that hangs, because
 * the hang is at least visible. Returns why, so the caller can say so instead of opening a
 * window that dies quietly.
 */
export function ensureProjectTrusted(
  cwd: string,
  configDir: string | null,
): { trusted: boolean; mirrored: boolean; reason?: string } {
  const file = join(configDir ?? homedir(), '.claude.json')
  if (!existsSync(file)) return { trusted: false, mirrored: false, reason: 'no-cli-config' }
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { trusted: false, mirrored: false, reason: 'cli-config-unreadable' }
  }
  const projects = (cfg.projects ?? {}) as Record<string, Record<string, unknown>>
  // Same folder, any spelling: slashes normalized, case-folded (Windows paths are
  // case-insensitive), trailing separators dropped.
  const canon = (p: string) =>
    p
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase()
  const target = canon(cwd)
  const siblings = Object.keys(projects).filter((k) => canon(k) === target)
  // Both spellings must already say yes before this can claim there is nothing to do. Checking
  // only the caller's spelling is what let the original version return 'trusted, nothing to
  // mirror' for a folder whose forward-slash key did not exist, and then hang on the dialog.
  const forwardKey = cwd.replace(/\\/g, '/')
  const backslashKey = cwd.replace(/\//g, '\\')
  const yes = (k: string) => projects[k]?.hasTrustDialogAccepted === true
  if (yes(cwd) && yes(forwardKey) && yes(backslashKey)) return { trusted: true, mirrored: false }
  const trustedElsewhere = siblings.find((k) => projects[k]?.hasTrustDialogAccepted === true)
  if (!trustedElsewhere)
    return {
      trusted: false,
      mirrored: false,
      reason: siblings.length ? 'folder-not-trusted' : 'folder-unknown',
    }
  // Mirror the YES onto every spelling of this folder, INCLUDING the two it may not have yet.
  // Writing only the keys that already exist is not enough and was the bug in the first cut of
  // this: measured on the owner's config, every forward-slash key is false and every backslash
  // key is true, because the CLI resolves cwd to FORWARD slashes and reads trust under that
  // key while something else wrote the backslash form. A folder recorded only with backslashes
  // therefore has no forward-slash key, the mirror skipped it, and the dialog kept appearing.
  // Adding that one key by hand turned a launch that had hung three times into one that
  // registered in seven seconds.
  try {
    const donor = projects[trustedElsewhere]
    const forward = cwd.replace(/\\/g, '/')
    const backslash = cwd.replace(/\//g, '\\')
    for (const k of new Set([...siblings, cwd, forward, backslash])) {
      projects[k] = { ...(projects[k] ?? donor), hasTrustDialogAccepted: true }
    }
    cfg.projects = projects
    writeFileSync(file, JSON.stringify(cfg, null, 2))
    return { trusted: true, mirrored: true }
  } catch {
    return { trusted: false, mirrored: false, reason: 'cli-config-unwritable' }
  }
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
 * is chosen by the CLI itself; within seconds the session appears in ~/.claude/sessions,
 * where anything reading the live registry picks it up.
 */
type InstanceEnvResolution =
  | { ok: true; env: Record<string, string>; exe: string | null }
  | { ok: false; reason: string }

/** Turn an `instanceRef` ("cli:<id>" / "desktop:<dir>" / null) into the env vars and (optional
 *  override) executable a launch needs. Pulled out of launchTerminalSession so the three-way ref
 *  dispatch isn't inline in the middle of the launch sequence — same await ordering, same checks,
 *  just named. */
async function resolveInstanceEnv(ref: string | null): Promise<InstanceEnvResolution> {
  const env: Record<string, string> = {}
  let exe: string | null = null
  if (ref?.startsWith('cli:')) {
    const configDir = getCliInstance(ref.slice('cli:'.length))?.configDir
    if (!configDir) return { ok: false, reason: 'cli-instance-not-found' }
    env.CLAUDE_CONFIG_DIR = configDir
  } else if (ref?.startsWith('desktop:')) {
    const dir = ref.slice('desktop:'.length)
    const grant = await resolveInstanceToken(dir)
    // A pinned launch must never silently fall back to the ambient login — the exact rule
    // dispatch.ts enforces pre-launch, for the exact reason (wrong account pays).
    if (!grant) return { ok: false, reason: 'instance-token-unavailable' }
    env.CLAUDE_CODE_OAUTH_TOKEN = grant.token
    if (grant.scopes) env.CLAUDE_CODE_OAUTH_SCOPES = grant.scopes
    exe = bundledClaudeExe(dir) // see bundledClaudeExe: the peer-capable CLI wins
  } else if (ref) {
    return { ok: false, reason: `malformed instance ref (${ref})` }
  }
  return { ok: true, env, exe }
}

export async function launchTerminalSession(opts: {
  cwd: string
  prompt: string
  instanceRef?: string | null
  model?: string | null
  effort?: string | null
  /** Continue THIS existing thread (--resume) instead of starting a new session. The caller
   *  must have stopped any live process for it first (two-writers rule). */
  resumeSessionId?: string | null
  /** Resume a done-marked (superseded) lineage anyway. See isSessionSuperseded. */
  force?: boolean
  /** Start the session in this permission mode. An UNATTENDED window needs
   *  'bypassPermissions' or it stops on the first shell approval with nobody to answer. */
  permissionMode?: string | null
}): Promise<TerminalLaunchResult> {
  if (opts.resumeSessionId && !opts.force && isSessionSuperseded(opts.resumeSessionId))
    return {
      ok: false,
      reason:
        'superseded: this session is done-marked (handed off/migrated) — resuming it would duplicate its successor’s work; pass force to override',
      command: '',
    }
  // TWO WRITERS, ONE TRANSCRIPT — refused in the primitive, so every caller inherits it. The
  // interactive route checked this itself, but the auto-resume monitor's terminal branch calls
  // straight in here and did not, so an unattended resume could open a second writer on a chat
  // that is live in the desktop app right now (found by an adversarial audit, 2026-08-26). There
  // is deliberately NO force escape: superseded is a judgement call the owner may overrule,
  // while two processes appending to one transcript is never the thing anyone wanted.
  if (opts.resumeSessionId && liveSessionEntry(opts.resumeSessionId))
    return {
      ok: false,
      reason:
        'session-live: that thread already has a running process (it is open in an app or a terminal) — resuming it here would put two writers on one transcript',
      command: '',
    }
  const ref = opts.instanceRef?.trim() || null
  const resolved = await resolveInstanceEnv(ref)
  if (!resolved.ok) return { ok: false, reason: resolved.reason, command: '' }
  const { env, exe } = resolved

  // THE TRUST PRE-FLIGHT. Without it the window opens, asks 'do you trust this folder', and
  // waits forever on a keypress nobody can give, while this function has already returned
  // ok:true. Found 2026-08-27 starting a reviewer: a hang that is invisible from the API is
  // worse than a refusal, because nothing anywhere says the launch did not take.
  const trust = ensureProjectTrusted(opts.cwd, env.CLAUDE_CONFIG_DIR ?? null)
  if (!trust.trusted)
    return {
      ok: false,
      reason:
        `folder-not-trusted (${trust.reason}): the CLI would stop on its trust prompt for ` +
        `${opts.cwd} and wait for a keypress. Open that folder once in this account's app or ` +
        `CLI and accept, then relaunch. AgentHydra deliberately will not answer that question ` +
        'for you.',
      command: '',
    }
  if (trust.mirrored)
    console.log(
      `[agenthydra] mirrored an existing trust decision onto ${opts.cwd} (the CLI keys trust by the literal path string, so slash style can hide a yes)`,
    )

  // Owner rule 2026-08-30 (new-chat-defaults.ts): a NEW session that names no model starts on
  // Opus + the ultracode keyword. A resume is not a new chat; an explicit model passes through.
  const spec = applyNewChatDefaults({
    newChat: !opts.resumeSessionId,
    model: opts.model,
    prompt: opts.prompt,
  })
  const dir = join(tmpdir(), 'agenthydra-launch')
  mkdirSync(dir, { recursive: true })
  const promptFile = join(dir, `prompt-${crypto.randomUUID()}.txt`)
  writeFileSync(promptFile, spec.prompt)

  const plan = buildTerminalLaunchPlan(
    process.platform,
    exe ?? resolveClaudeExe(),
    promptFile,
    spec.model,
    opts.effort?.trim() || null,
    opts.resumeSessionId?.trim() || null,
    opts.permissionMode?.trim() || null,
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

/**
 * Does this session ALREADY render as a live (non-archived) chat inside `instanceDir`?
 *
 * Pure, so the duplicate-row rule can be pinned by tests without a store, a running app, or a
 * spawn. Residency is decided by where the chat's own metadata FILE sits, not by comparing a
 * directory name: the default install and the isolated instances then obey one rule, and a
 * trailing separator or slash style cannot change the answer.
 */
export function alreadyRendersIn(
  rendered: { archived: boolean; path: string } | null,
  instanceDir: string,
): boolean {
  if (!rendered || rendered.archived) return false
  const norm = (s: string) =>
    s
      .replace(/[\\/]+/g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase()
  return norm(rendered.path).startsWith(`${norm(instanceDir)}\\`)
}

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
  // Slash STYLE must not decide the answer (found live 2026-08-29: a forward-slash caller read
  // a RUNNING instance as not running). path-key.ts is the one definition of that comparison.
  return (await listInstances()).some((i) => i.isRunning && samePathKey(i.dir, instanceDir))
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
  /** False when the entry was already in the requested state (nothing written). */
  changed: boolean
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
    // BOTH shapes: `local_<cliSessionId>.json` for an imported chat, or the app's own filename
    // with the CLI id inside for one the owner started. Filename-only matching meant archiving
    // silently did nothing for almost every real chat (found by the self-test).
    let found: string | null = null
    try {
      found = findChatMetaPath(profile, sessionId)
    } catch {
      continue
    }
    if (!found) continue
    try {
      const meta = JSON.parse(readFileSync(found, 'utf8'))
      // Already in the requested state: report the hit without rewriting the file, so a
      // periodic sweep is idempotent instead of churning every metadata file every pass.
      if (meta.isArchived === archived) {
        hits.push({ profile, wasRunning: false, changed: false })
        continue
      }
      meta.isArchived = archived
      writeFileSync(found, JSON.stringify(meta))
      invalidateSessionMetaCache() // the index now holds the flag we just replaced
      hits.push({
        profile,
        wasRunning: await isInstanceRunning(profile).catch(() => false),
        changed: true,
      })
    } catch {
      // An unwritable/corrupt metadata file: skip it rather than fail the others.
    }
  }
  if (hits.length === 0) return { ok: false, hits, reason: 'no-desktop-chat-found' }
  return { ok: true, hits }
}

/**
 * Read-only probe of a chat's desktop entries: does any store carry it, and is every carried
 * entry archived? The archive janitor uses this to PROPOSE retiring a chat instead of flipping
 * flags itself (action-gate law 2026-08-26: the AI checks before any archive) — so the probe
 * must never write. `archived` is true only when ALL found entries are archived; one visible
 * entry anywhere means the chat still shows somewhere.
 */
export function desktopChatArchiveState(
  sessionId: string,
  roots?: string[],
): { found: boolean; archived: boolean } {
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
  // The cached index answers this for the real store in microseconds and matches both on-disk
  // shapes. The walk below stays for injected roots (tests) and as the fallback when a chat is
  // genuinely absent from the index. Without this, the archive janitor asked one uncached
  // full-store walk PER done-marked chat, which is what made the janitor take 8.5 seconds.
  if (!roots) {
    // The index is built from these exact stores, under both naming shapes, so a MISS is an
    // answer and not a reason to go looking again. That distinction is the whole cost here:
    // most done-marked chats no longer exist in any store, and treating each miss as "walk
    // everything to be sure" is what made the archive sweep 1.7 seconds by itself.
    const hit = findDesktopChat(sessionId)
    return hit ? { found: true, archived: hit.archived } : { found: false, archived: false }
  }
  let found = false
  let allArchived = true
  for (const profile of searchRoots) {
    const store = join(profile, 'claude-code-sessions')
    if (!existsSync(store)) continue
    try {
      const p = findChatMetaPath(profile, sessionId)
      if (p) {
        found = true
        try {
          const meta = JSON.parse(readFileSync(p, 'utf8'))
          if (meta.isArchived !== true) allArchived = false
        } catch {
          allArchived = false // unreadable = assume visible; a false "visible" only re-proposes
        }
      }
    } catch {
      // an unreadable store contributes nothing
    }
  }
  return { found, archived: found && allArchived }
}

/**
 * The title janitor: give every desktop chat that has NO real name the best title the scanner
 * knows for it. "Untitled" / "General coding session" happens whenever a chat is created by
 * plumbing (imports, migrations) rather than by a person — the desktop derives nothing at
 * import time, and generic bootstrap turns earn generic AI titles. The owner's requirement is
 * standing, not one-time: names are MANAGED, continuously. Runs from the watcher tick.
 *
 * Never overwrites an existing non-empty title (a person's rename outranks everything), and
 * writes only when the scanner has something better than an id or a generic label. Metadata
 * writes show in a RUNNING app after its next restart — the standing caveat.
 */
// One definition of generic/plumbing, shared with the naming contract (chat-title.ts) so
// the janitor and the routes cannot drift apart on what counts as a non-name.
const GENERIC_TITLE = GENERIC_CHAT_TITLE
const PLUMBING_TITLE = PLUMBING_CHAT_TITLE

/** If `path`'s stored title is empty/generic/plumbing AND the scanner has something real for it,
 *  write the better title in place and report the rename. Returns null when nothing needed
 *  fixing (a real title already, or no better replacement) - one unreadable metadata file must
 *  not stop the sweep, so a parse failure returns null too. */
function renameIfUntitled(
  path: string,
  filename: string,
  lookupTitle: (cliSessionId: string) => string | null,
): { sessionId: string; title: string } | null {
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8'))
    const current = typeof meta.title === 'string' ? meta.title.trim() : ''
    if (current && !GENERIC_TITLE.test(current) && !PLUMBING_TITLE.test(current)) return null
    const sid =
      typeof meta.cliSessionId === 'string' && meta.cliSessionId
        ? meta.cliSessionId
        : filename.slice('local_'.length, -'.json'.length)
    const better = lookupTitle(sid)?.trim()
    if (!better || GENERIC_TITLE.test(better) || PLUMBING_TITLE.test(better) || better === sid)
      return null
    meta.title = better
    meta.titleSource = 'tool'
    writeFileSync(path, JSON.stringify(meta))
    return { sessionId: sid, title: better }
  } catch {
    // one unreadable metadata file must not stop the sweep
    return null
  }
}

/** Every `local_*.json` metadata file directly under one user's session directory, renamed where
 *  untitled/generic/plumbing and the scanner knows something better. */
function sweepUserDir(
  dir: string,
  lookupTitle: (cliSessionId: string) => string | null,
): Array<{ sessionId: string; title: string }> {
  const out: Array<{ sessionId: string; title: string }> = []
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('local_') || !f.endsWith('.json')) continue
    const hit = renameIfUntitled(join(dir, f), f, lookupTitle)
    if (hit) out.push(hit)
  }
  return out
}

/** Every user directory under one profile's session store, walked org by org. Isolated so an
 *  unreadable store contributes nothing rather than aborting the whole sweep. */
function sweepProfileStore(
  store: string,
  lookupTitle: (cliSessionId: string) => string | null,
): Array<{ sessionId: string; title: string }> {
  const out: Array<{ sessionId: string; title: string }> = []
  try {
    for (const org of readdirSync(store, { withFileTypes: true })) {
      if (!org.isDirectory()) continue
      for (const user of readdirSync(join(store, org.name), { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        out.push(...sweepUserDir(join(store, org.name, user.name), lookupTitle))
      }
    }
  } catch {
    // an unreadable store just contributes nothing
  }
  return out
}

export function sweepUntitledDesktopChats(
  lookupTitle: (cliSessionId: string) => string | null,
  roots?: string[],
): {
  fixed: number
  profiles: string[]
  /** Every chat renamed, with the profile it lives in. The COUNT was enough while the only
   *  follow-up was restarting the app; naming them lets the caller hand the ones in running
   *  instances to the reviewer, which renames through the app instantly instead. */
  renamed: Array<{ profile: string; sessionId: string; title: string }>
} {
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
  let fixed = 0
  // Profiles that had at least one rename: a RUNNING app keeps showing the old name until it
  // restarts, so the janitor hands these to the sidebar-visibility restart (owner rule: names
  // appear automatically, not at some future restart).
  const renamedProfiles = new Set<string>()
  const renamed: Array<{ profile: string; sessionId: string; title: string }> = []
  for (const profile of searchRoots) {
    const store = join(profile, 'claude-code-sessions')
    if (!existsSync(store)) continue
    for (const hit of sweepProfileStore(store, lookupTitle)) {
      fixed++
      renamedProfiles.add(profile)
      renamed.push({ profile, sessionId: hit.sessionId, title: hit.title })
    }
  }
  return { fixed, profiles: [...renamedProfiles], renamed }
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
  /** Import a done-marked (superseded) lineage anyway. See isSessionSuperseded. */
  force?: boolean
  /** Seam for tests; the default asks the cached desktop-chat index. */
  findRendered?: (sessionId: string) => { archived: boolean; path: string } | null
}): Promise<{
  ok: boolean
  reason?: string
  titled?: boolean
  titleDurable?: boolean
  /** True when no import was performed because the chat already renders in that instance. */
  alreadyRendered?: boolean
}> {
  // THE NAMING LAW HOLDS AT THE CHOKEPOINT (owner directive 2026-08-29), not only at the
  // routes: adversarial review found the queue's auto-import landing chats with a null or
  // generic title because it never passed through the route contract. Every caller now
  // supplies a real name or the import refuses - there is no bypass flag on purpose.
  if (isGenericChatTitle(opts.title))
    return {
      ok: false,
      reason:
        'title-required: a chat must not land with a generic or missing name (owner rule); resolve a real title first',
    }
  if ((opts.isLive ?? sessionIsLive)(opts.sessionId))
    return { ok: false, reason: 'session-live: refusing to import under an active writer' }
  if (!opts.force && isSessionSuperseded(opts.sessionId))
    return {
      ok: false,
      reason:
        'superseded: this session is done-marked (handed off/migrated) — importing it would revive a retired lineage; pass force to override',
    }
  if (!existsSync(opts.instanceDir)) return { ok: false, reason: 'instance-dir-not-found' }
  // The import spawn targets the RUNNING app via Electron's single-instance lock. Aimed at an
  // instance that is NOT running it does not fail — it BOOTS that instance, which is exactly
  // the owner's "never open accounts on your own" rule broken by a side door (and how a wrong
  // display-name-derived path silently started a sixth desktop app on 2026-08-25). Refuse.
  const running = await (opts.isInstanceRunning ?? defaultInstanceRunning)(opts.instanceDir)
  if (!running)
    return { ok: false, reason: 'instance-not-running: importing would boot that instance' }
  // IMPORTING A CHAT THAT IS ALREADY ON SCREEN CREATES A SECOND ROW WITH THE SAME NAME, and
  // that is how a surfaced chat becomes permanently unreachable. Every UI operation here aims
  // by rendered name - the courier's delivery, the UI archive, rename - and every one of them
  // correctly REFUSES an ambiguous name rather than risk driving the wrong chat. So the second
  // import does not merely waste a spawn: it disables the delivery that was the entire point of
  // surfacing, and the chat then sits dormant forever with its prompt staged and unsendable.
  // Measured 2026-08-31: three surfaces of one chat produced three identical rows, and the
  // resume never reached it once. The import exists to MAKE a row; when one already exists the
  // caller's next step (deliver into it) is what it actually wanted, so report success and let
  // it proceed. Matching on the metadata file's own location rather than a dir-name guess keeps
  // the default install and the isolated instances on one rule.
  const rendered = (opts.findRendered ?? findDesktopChat)(opts.sessionId)
  if (alreadyRendersIn(rendered, opts.instanceDir))
    return { ok: true, alreadyRendered: true, titled: false, titleDurable: false }
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
  const titled = await stampImportedChat(opts.instanceDir, opts.sessionId, opts.title)
  // The stamp just written measurably LOSES to the running app (and the guard above means the
  // app is always running here): the app re-saves this chat's metadata from memory — where the
  // import handler put 'acceptEdits' — on its first boot, which erases the stamp from disk and
  // leaves the file lying about the mode at the app's next restart too. The bounded watch keeps
  // the disk copy converged so that restart makes the stamp permanent; fire-and-forget, because
  // an import must not block minutes on a babysitter (see reassertChatAutomation).
  void reassertChatAutomation(opts.instanceDir, opts.sessionId)
  // `titleDurable` is the honest half of the answer. Writing the metadata file works, and then a
  // RUNNING app overwrites it from memory the moment that chat next boots - measured 2026-08-26:
  // five chats imported with correct titles all came back `title: undefined`, which the sidebar
  // renders as "General coding session", seconds after each was first messaged. So a title written
  // from outside a running instance is a hint, not a fact, and reporting `titled: true` for it was
  // a false success. The durable channel is the app's OWN rename (the reviewer's session-management
  // tool); the title janitor is the slow fallback for instances that are closed or later restart.
  return { ok: true, titled, titleDurable: !running }
}

/**
 * Wait for the app to create an imported chat's metadata file, then stamp it: automation posture
 * always, title only when one was supplied. Returns whether a title was written.
 *
 * Split out of importSessionToDesktop so it can be tested without a real desktop binary and a real
 * spawn, which is why the bug below survived: every existing import test stops at a guard well
 * before this code, so nothing ever executed it.
 *
 * THE BUG: this used to begin `if (!title) return`, which sat BEFORE applyDesktopChatAutomation.
 * So an import with no title never got stamped, kept the app's `acceptEdits` default, and
 * deadlocked on its first shell call with nobody there to approve it - precisely the failure the
 * stamp exists to prevent, reached by skipping the stamp. `POST /api/sessions/:id/import` passes
 * `body.title ?? null` and migrate passes a title that can be empty, so both routes could hit it.
 * Measured 2026-08-28 moving 13 chats between accounts. The posture is mandatory; the title is not.
 */
export async function stampImportedChat(
  instanceDir: string,
  sessionId: string,
  rawTitle?: string | null,
  deadlineMs = 20_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const title = rawTitle?.trim()
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const outcome = title
      ? applyDesktopChatTitle(instanceDir, sessionId, title)
      : ('not-found' as const)
    // Runs every pass, and its boolean doubles as the "has the app created the file yet?" probe
    // for the untitled case, which has no title outcome to read.
    const stamped = applyDesktopChatAutomation(instanceDir, sessionId)
    if (outcome !== 'not-found' || stamped) return outcome === 'titled'
    if (Date.now() >= deadline) return false
    await sleep(500)
  }
}

/**
 * The desktop metadata FILE for a session id, searched across every instance's store. This is
 * the roll-proof visibility test: a desktop chat that continues rolls onto a NEW cliSessionId
 * while its metadata file keeps the ORIGINAL id in its name — so any lookup keyed by
 * cliSessionId (sessionMetaMap) reports the original id as missing and, unguarded, the
 * visibility sweep re-imports an already-visible chat forever (found live 2026-08-25: the
 * architect chat re-imported and re-titled every cycle).
 */
/**
 * Does this session live in a desktop app, and which one? THE question the surface-purity guard
 * asks before every headless run, so it has to be right in both of the two ways a chat can be
 * resident - which are genuinely different on disk:
 *
 *   A) IMPORTED chats (claude://resume) are filed under the CLI id: `local_<cliSessionId>.json`.
 *      findDesktopEntryFile matches those by FILENAME.
 *   B) Chats CREATED in the app are filed under the app's OWN id, and the CLI transcript id
 *      lives INSIDE the file as `cliSessionId`. A filename lookup cannot see those at all.
 *
 * Measured on the owner's fleet 2026-08-26: 1,343 desktop chats, of which 1,325 - 98.7%, this
 * very session among them - are findable only by (B). A guard built on the filename alone was
 * therefore blind to almost every chat it existed to protect, while looking like it worked
 * because the handful of chats it was TESTED against were imported ones. sessionMetaMap is the
 * content-keyed index (cached, 15s) and is checked first because it is both cheaper and the
 * common case; the filename walk stays as the roll-proof second opinion.
 */
export async function desktopHomeFor(sessionId: string): Promise<string | null> {
  try {
    const { instanceDirForLabel, sessionMetaMap } = await import('./instance-sessions')
    const hit = sessionMetaMap().get(sessionId)
    // The DIR, not the raw label: the index stores an instance LABEL ('default' | dir name)
    // while the filename-walk fallback below returns a real dir, and callers match dirs.
    // Live-drill-confirmed 2026-08-30: the label leaked out of the index path and the gate's
    // home-instance matching (and the /automation route's stamp) failed on every indexed chat.
    if (hit) return instanceDirForLabel(hit.instance)
  } catch {
    // No readable metadata store: fall through to the filename walk rather than answering "no".
  }
  const file = await findDesktopEntryFile(sessionId)
  return file ? file.instanceDir : null
}

/** The org/user walk for one instance's store in {@link findDesktopEntryFile}, split out so the
 *  caller's own complexity reflects only "try the cache, then try each instance", not this
 *  directory shape too. Behaviour is unchanged - same walk, same return, same swallowed errors. */
function findDesktopEntryInStore(
  store: string,
  sessionId: string,
): { path: string; cliSessionId: string | null } | null {
  try {
    for (const org of readdirSync(store, { withFileTypes: true })) {
      if (!org.isDirectory()) continue
      for (const user of readdirSync(join(store, org.name), { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        const p = join(store, org.name, user.name, `local_${sessionId}.json`)
        if (!existsSync(p)) continue
        let cli: string | null = null
        try {
          const d = JSON.parse(readFileSync(p, 'utf8')) as { cliSessionId?: string }
          cli = typeof d.cliSessionId === 'string' ? d.cliSessionId : null
        } catch {
          // Shape unknown: the file existing is still visibility.
        }
        return { path: p, cliSessionId: cli }
      }
    }
  } catch {
    // No store in this instance.
  }
  return null
}

export async function findDesktopEntryFile(
  sessionId: string,
): Promise<{ instanceDir: string; path: string; cliSessionId: string | null } | null> {
  // The cached index is keyed by BOTH the filename id and the cliSessionId, so it already
  // answers the roll-proof question this function was written for - without a process scan
  // (listInstances) and a full store walk per call. The visibility sweep asks this once per
  // completed queue row, which is where that cost showed up.
  const hit = findDesktopChat(sessionId)
  if (hit?.path) {
    const marker = `${sep}claude-code-sessions${sep}`
    const cut = hit.path.indexOf(marker)
    if (cut > 0)
      return {
        instanceDir: hit.path.slice(0, cut),
        path: hit.path,
        cliSessionId: hit.cliSessionId,
      }
  }
  const { listInstances } = await import('./core/instances')
  for (const inst of await listInstances()) {
    const store = join(inst.dir, 'claude-code-sessions')
    const found = findDesktopEntryInStore(store, sessionId)
    if (found) return { instanceDir: inst.dir, path: found.path, cliSessionId: found.cliSessionId }
  }
  return null
}

/**
 * Stamp the automation posture onto a desktop chat's metadata: `bypassPermissions`.
 *
 * A chat the app creates for an IMPORT lands on the app's default, `acceptEdits` - which
 * auto-approves file edits but still raises an approval prompt for every SHELL command. Under
 * the zero-click law that is a deadlock, not a safeguard: measured 2026-08-26, five imported
 * chats were messaged, each woke, each ran one Bash call, and all five froze for minutes at a
 * prompt nobody could ever click (alive, ~300MB, no CPU). The owner's own chats run
 * `bypassPermissions` for exactly this reason, and the retired auto-revive set it on its own
 * runs because "a revive that stalls on a permission prompt is only a new flavour of dead".
 *
 * Best-effort, and honest about it: like the title, a value written from outside a RUNNING app
 * can be overwritten when that chat next boots. It costs one small write and removes the most
 * common way a revived chat dies quietly.
 *
 * HOW IT LOSES, measured twice (a 2026-08-27 experiment, then live 2026-08-29 01:58 UTC when
 * seeded chat 95fe512c froze at its FIRST PowerShell prompt ~15s after seeding): the running
 * app's IN-MEMORY chat record is authoritative. The import handler
 * creates that record with 'acceptEdits', every chat boot re-saves it over this file, and the
 * engine takes its mode from the record, not from disk — so a file stamp is invisible to the
 * app until the one moment it re-reads the store, which is ITS OWN boot. That is why this
 * write alone cannot prevent the first-wake deadlock, and why two convergence mechanisms sit
 * beside it: reassertChatAutomation (bounded watch after each import, so the app's re-saves
 * stop erasing the stamp from disk) and reassertAutomationStamps (the app-restart quit→reopen
 * window, the one write that provably enters app memory — same window 4499079 proved for
 * archive flags). Once a restart has read the stamp, the app itself re-saves
 * 'bypassPermissions' forever after, and the chat is durably unattended.
 */
export function applyDesktopChatAutomation(instanceDir: string, sessionId: string): boolean {
  const metaPath = findChatMetaPath(instanceDir, sessionId)
  if (!metaPath) return false
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    meta.permissionMode = 'bypassPermissions'
    writeFileSync(metaPath, JSON.stringify(meta))
    invalidateSessionMetaCache() // the index now holds the value we just replaced
    return true
  } catch {
    return false
  }
}

/**
 * Keep an imported chat's automation stamp true ON DISK across the app's re-saves: a bounded
 * watch that rewrites `bypassPermissions` whenever the running app flips the metadata back.
 *
 * Why a watcher at all, given the app's memory wins while it runs (see
 * applyDesktopChatAutomation): because the DISK copy is what the app loads at its next boot.
 * Without this, the chat's first wake re-saves 'acceptEdits' over the stamp and the file then
 * testifies to the wrong mode forever — so even an app restart, the one event that could have
 * made the stamp durable, reads the clobbered value and the chat stays deadlock-prone for
 * life (measured 2026-08-29 01:58 UTC: seeded chat 95fe512c booted ~15s after seeding, froze
 * at its first shell prompt, and the dossier read 'acceptEdits' back off disk). With it, the
 * file converges back to 'bypassPermissions' after every flip, and the next app boot (owner
 * restart or app update) makes the stamp permanent.
 *
 * Bounded three ways, so it can never fight the app forever or scan a store forever: a hard
 * time window, a cap on restores (a tug-of-war that reaches the cap is the app's to win), and
 * a cap on consecutive ticks where no metadata file resolves (an import that never produced a
 * chat leaves nothing to guard). Non-throwing; returns how many times it restored the stamp.
 */
export async function reassertChatAutomation(
  instanceDir: string,
  sessionId: string,
  opts?: {
    windowMs?: number
    intervalMs?: number
    maxRestores?: number
    maxMisses?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  },
): Promise<number> {
  const windowMs = opts?.windowMs ?? 10 * 60_000
  const intervalMs = opts?.intervalMs ?? 1_500
  const maxRestores = opts?.maxRestores ?? 8
  const maxMisses = opts?.maxMisses ?? 40
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts?.now ?? Date.now
  const deadline = now() + windowMs
  let restores = 0
  let misses = 0
  // Resolved once and then read directly each tick: findChatMetaPath falls back to a full
  // store walk on a cache miss, and a watcher must stay cheap enough to forget about.
  let metaPath: string | null = null
  while (now() < deadline && restores < maxRestores) {
    await sleep(intervalMs)
    try {
      if (!metaPath || !existsSync(metaPath)) metaPath = findChatMetaPath(instanceDir, sessionId)
      if (!metaPath) {
        if (++misses >= maxMisses) return restores
        continue
      }
      misses = 0
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (meta.permissionMode === 'bypassPermissions') continue
      meta.permissionMode = 'bypassPermissions'
      writeFileSync(metaPath, JSON.stringify(meta))
      invalidateSessionMetaCache()
      restores++
      console.log(
        `[agenthydra] re-asserted bypassPermissions on ${sessionId} (the app's re-save had reverted it)`,
      )
    } catch {
      // a contended or half-written pass says nothing about the next tick
    }
  }
  return restores
}

/**
 * Stamp `bypassPermissions` onto every IMPORT-SHAPE chat in one profile's store whose file
 * says otherwise. Import shape means the file is named after the CLI id
 * (`local_<cliSessionId>.json`) — the one shape only OUR imports and seeds produce; a chat
 * the app created for itself is filed under the app's own id and is left strictly alone,
 * because an 'acceptEdits' there could be the owner's deliberate choice in the UI.
 *
 * This is the durable half of the stamp (owner rule 2026-08-28: every new chat runs
 * bypassPermissions). Written from outside, the stamp only ever reaches the app's
 * authoritative in-memory record when the app READS the store, which is its own boot — so the
 * caller is the archive-visibility restart, in the same quit→reopen window where 4499079
 * proved a daemon write cannot lose. It also heals every import clobbered before this
 * mechanism existed (census 2026-08-27: 26 of 30 imports fleet-wide had lost the stamp).
 * Idempotent, non-throwing; returns how many files it changed.
 */
export function reassertAutomationStamps(profileDir: string): number {
  const store = join(profileDir, 'claude-code-sessions')
  let stamped = 0
  try {
    for (const org of readdirSync(store, { withFileTypes: true })) {
      if (!org.isDirectory()) continue
      for (const user of readdirSync(join(store, org.name), { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        const dir = join(store, org.name, user.name)
        for (const f of readdirSync(dir)) {
          if (!f.startsWith('local_') || !f.endsWith('.json')) continue
          try {
            const p = join(dir, f)
            const meta = JSON.parse(readFileSync(p, 'utf8'))
            if (typeof meta.cliSessionId !== 'string' || f !== `local_${meta.cliSessionId}.json`)
              continue // app-created shape, or unreadable identity: not ours to touch
            if (meta.permissionMode === 'bypassPermissions') continue
            meta.permissionMode = 'bypassPermissions'
            writeFileSync(p, JSON.stringify(meta))
            stamped++
          } catch {
            // one unreadable metadata file says nothing about the others
          }
        }
      }
    }
  } catch {
    return stamped // no store in this profile
  }
  if (stamped > 0) invalidateSessionMetaCache()
  return stamped
}

/**
 * The metadata file for one chat inside one instance's store, or null - matching BOTH of the
 * shapes a chat can have on disk.
 *
 * `local_<cliSessionId>.json` is only how IMPORTED chats are filed. A chat created in the app is
 * filed under the app's own id and carries the CLI id inside as `cliSessionId`, which is 98.7%
 * of the owner's real chats. Every lookup here was filename-only, which meant archiving a chat
 * the owner had actually started returned "no-desktop-chat-found" and quietly did nothing -
 * found by a self-test on its first real run, in the same week the identical blindness was
 * fixed in the surface guard.
 */
/** The imported-shape / created-in-app-shape check for one org/user leaf directory, split out of
 *  {@link findChatMetaPath}'s walk so that function's own complexity reflects only the walk, not
 *  this per-directory shape test too. Behaviour is unchanged. */
function findChatMetaPathInDir(dir: string, sessionId: string): string | null {
  // Fast path: the imported shape, one existsSync.
  const direct = join(dir, `local_${sessionId}.json`)
  if (existsSync(direct)) return direct
  // Then the created-in-app shape, which costs a directory read and a parse per file.
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('local_') || !f.endsWith('.json')) continue
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { cliSessionId?: string }
      if (meta.cliSessionId === sessionId) return join(dir, f)
    } catch {
      // one unreadable metadata file says nothing about the others
    }
  }
  return null
}

export function findChatMetaPath(instanceDir: string, sessionId: string): string | null {
  // Cached index first: it already knows this file's path under either naming shape, and the
  // walk below re-reads every metadata file in the store when the filename does not match.
  const hit = findDesktopChat(sessionId)
  if (hit?.path?.startsWith(instanceDir)) return hit.path
  const store = join(instanceDir, 'claude-code-sessions')
  try {
    for (const org of readdirSync(store, { withFileTypes: true })) {
      if (!org.isDirectory()) continue
      for (const user of readdirSync(join(store, org.name), { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        const found = findChatMetaPathInDir(join(store, org.name, user.name), sessionId)
        if (found) return found
      }
    }
  } catch {
    return null
  }
  return null
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
    invalidateSessionMetaCache() // the index now holds the value we just replaced
    return 'titled'
  } catch {
    return 'failed'
  }
}
