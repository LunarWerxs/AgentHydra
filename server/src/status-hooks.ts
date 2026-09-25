// server/src/status-hooks.ts - install, remove and keep current the Claude Code hooks that feed
// the live agent status store (agent-status.ts).
//
// WHY THIS EXISTS. Claude Code is the only party that knows, the moment it happens, that a session
// started working, stopped on a permission prompt or finished its turn, and its hooks are how it
// says so. Each hook here is one curl that forwards the hook's own JSON to this daemon; the store
// does the rest. Opt-in: nothing is written until someone asks (POST /api/agent-status/hooks or the
// status_hooks MCP tool), because ~/.claude/settings.json is the user's file.
//
// WHAT IT TOUCHES. Only hook groups whose command posts to HOOK_PATH; every other hook the user has
// stays exactly where it was. Reads and writes go through mcp-register.ts's readConfig and
// writeConfigAtomic, so an unreadable file is reported and never rewritten, and a write is a temp
// file plus a rename. The URL carries the port this daemon bound, so boot re-syncs installed hooks
// (syncStatusHooks) the same way the MCP entry is re-asserted after a port hop.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readConfig, writeConfigAtomic } from './mcp-register'

/** The route every installed hook posts to. Also the marker that says a hook group is ours. */
export const HOOK_PATH = '/api/agent-status/hook'

/** The hook events the store reads. Tool events need a matcher; the rest take none. */
export const STATUS_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
] as const
const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse'])

/** Claude Code's user settings file; CLAUDE_CONFIG_DIR relocates it, AGENTHYDRA_HOOKS_CONFIG names
 *  it outright (tests, or a layout neither covers). */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENTHYDRA_HOOKS_CONFIG?.trim()
  if (explicit) return explicit
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  return join(dir || join(homedir(), '.claude'), 'settings.json')
}

/**
 * The hook command. curl ships with Windows 10+ and every macOS/Linux; `--data-binary @-` forwards
 * the hook's stdin untouched. It must never slow or fail the agent: short timeouts, and
 * `|| exit 0` (valid in both sh and cmd) so a stopped daemon is a silent no-op rather than a hook
 * error. The route answers 204, so nothing reaches stdout for Claude Code to read as a decision.
 */
export function statusHookCommand(daemonUrl: string): string {
  const url = `${daemonUrl.replace(/\/+$/, '')}${HOOK_PATH}`
  return `curl -s --connect-timeout 1 -m 2 -X POST -H "Content-Type: application/json" --data-binary @- ${url} || exit 0`
}

function isOurGroup(group: unknown): boolean {
  const hooks = (group as { hooks?: unknown } | null)?.hooks
  return (
    Array.isArray(hooks) &&
    hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_PATH))
  )
}

/**
 * `settings` with this daemon's status hooks set to `daemonUrl`, or removed when it is null. Pure:
 * the caller decides whether to write. Other hook groups, other events and every other key are
 * left as they were; an event left with no groups is dropped, as is an emptied `hooks`.
 */
export function withStatusHooks(
  settings: Record<string, unknown>,
  daemonUrl: string | null,
): Record<string, unknown> {
  const raw = settings.hooks
  const hooks: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as object) } : {}
  for (const event of STATUS_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const kept = groups.filter((g) => !isOurGroup(g))
    if (daemonUrl) {
      const hook = { type: 'command', command: statusHookCommand(daemonUrl), timeout: 5 }
      kept.push(TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] })
    }
    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }
  const next = { ...settings, hooks }
  if (Object.keys(hooks).length === 0) delete next.hooks
  return next
}

/** Are this daemon's status hooks present, and which URL do they post to (first found)? */
export function installedHookUrl(settings: Record<string, unknown>): string | null {
  const hooks = settings.hooks as Record<string, unknown> | undefined
  for (const event of STATUS_HOOK_EVENTS) {
    const groups = hooks && Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    for (const g of groups.filter(isOurGroup)) {
      for (const h of (g as { hooks: { command?: unknown }[] }).hooks) {
        const m =
          typeof h.command === 'string' ? h.command.match(/(\S+)\/api\/agent-status\/hook/) : null
        if (m) return m[1]
      }
    }
  }
  return null
}

export interface StatusHooksResult {
  path: string
  installed: boolean
  /** The daemon URL the installed hooks post to, or null. */
  url: string | null
  action: 'installed' | 'removed' | 'updated' | 'unchanged'
  error: string | null
}

/** Install (`daemonUrl`) or remove (null) the hooks. Writes only when the file would change. */
export function setStatusHooks(
  daemonUrl: string | null,
  path = claudeSettingsPath(),
): StatusHooksResult {
  const { config, error } = readConfig(path)
  if (!config) return { path, installed: false, url: null, action: 'unchanged', error }
  const before = installedHookUrl(config)
  const next = withStatusHooks(config, daemonUrl)
  const changed = JSON.stringify(next) !== JSON.stringify(config)
  try {
    if (changed) writeConfigAtomic(path, next)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { path, installed: before !== null, url: before, action: 'unchanged', error: msg }
  }
  const after = installedHookUrl(next)
  const action = !changed ? 'unchanged' : !after ? 'removed' : before ? 'updated' : 'installed'
  return { path, installed: after !== null, url: after, action, error: null }
}

/** Read-only view for the route and the MCP tool. */
export function statusHooksState(path = claudeSettingsPath()): StatusHooksResult {
  const { config, error } = readConfig(path)
  const url = config ? installedHookUrl(config) : null
  return { path, installed: url !== null, url, action: 'unchanged', error }
}

/** Boot: re-point hooks someone installed at the URL this daemon actually bound. Never installs
 *  hooks that are not there, never throws. */
export function syncStatusHooks(daemonUrl: string, path = claudeSettingsPath()): void {
  try {
    const state = statusHooksState(path)
    if (state.installed && state.url !== daemonUrl.replace(/\/+$/, ''))
      setStatusHooks(daemonUrl, path)
  } catch (e) {
    console.error('[agenthydra] status hook sync failed:', e)
  }
}
