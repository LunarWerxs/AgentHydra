import type { ClaudeNativeProfileConfig, ClaudeNativeSettings } from './api'

/** Browser equivalent of the server's normalized absolute Windows profile key. */
export function normalizeClaudeNativeProfileKey(profile: string): string {
  const path = profile.replace(/\//g, '\\')
  const drive = /^([a-z]:)\\/i.exec(path)
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(path)
  if (!drive && !unc) throw Error('An absolute Windows profile directory is required')
  const root = drive ? drive[1] : `\\\\${unc![1]}\\${unc![2]}`
  const rest = path.slice(drive ? drive[0].length : unc![0].length)
  const segments: string[] = []
  for (const segment of rest.split(/\\+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return [root, ...segments].join('\\').toLowerCase()
}

const FIRST_PORT = 1024
const LAST_PORT = 65535
const DEFAULT_PORT = 19300

/**
 * Automatic startup is independent of native-control policy. Turning it off must retain
 * an existing manual connection; removing native control is a separate explicit action.
 * Port allocation avoids saved profiles. The server remains authoritative about conflicts.
 */
export function automaticClaudeNativeConfig(
  settings: ClaudeNativeSettings,
  profile: string,
  enabled: boolean,
  preferredPort = DEFAULT_PORT,
): ClaudeNativeProfileConfig | null {
  const existing = settings[normalizeClaudeNativeProfileKey(profile)]
  if (existing) return { ...existing, launchDebugger: enabled }
  if (!enabled) return null

  const used = new Set(Object.values(settings).map((config) => config.port))
  let port =
    Number.isInteger(preferredPort) && preferredPort >= FIRST_PORT && preferredPort <= LAST_PORT
      ? preferredPort
      : DEFAULT_PORT
  for (let remaining = LAST_PORT - FIRST_PORT + 1; remaining > 0; remaining--) {
    if (!used.has(port)) return { port, mode: 'native-only', launchDebugger: true }
    port = port === LAST_PORT ? FIRST_PORT : port + 1
  }
  throw Error('No unused debugger port is available')
}
