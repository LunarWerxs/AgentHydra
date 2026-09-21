import { win32 } from 'node:path'
import { getSetting, setSetting } from './db'

export interface ClaudeNativeProfileConfig {
  port: number
  mode: 'native-only' | 'prefer-native'
  /** Use a verified managed executable copy to start the local debugger on the next launch. */
  launchDebugger?: boolean
}

export type ClaudeNativeSettings = Record<string, ClaudeNativeProfileConfig>

const SETTINGS_KEY = 'claude_native_profiles'

export function normalizeClaudeNativeProfile(profileDir: string): string {
  if (
    typeof profileDir !== 'string' ||
    !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(profileDir)
  ) {
    throw Error('Native Claude configuration requires an absolute Windows profile directory')
  }
  return win32
    .normalize(profileDir)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

export function parseClaudeNativeProfileConfig(raw: unknown): ClaudeNativeProfileConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('Invalid native Claude configuration')
  const config = raw as Record<string, unknown>
  if (
    Object.keys(config).some((key) => !['port', 'mode', 'launchDebugger'].includes(key)) ||
    ('launchDebugger' in config && typeof config.launchDebugger !== 'boolean') ||
    !Number.isInteger(config.port) ||
    Number(config.port) < 1 ||
    Number(config.port) > 65535 ||
    (config.mode !== 'native-only' && config.mode !== 'prefer-native')
  ) {
    throw Error('Native Claude configuration requires port 1–65535 and a supported mode')
  }
  return {
    port: Number(config.port),
    mode: config.mode,
    ...('launchDebugger' in config ? { launchDebugger: config.launchDebugger as boolean } : {}),
  }
}

export function getClaudeNativeSettings(): ClaudeNativeSettings {
  const raw = getSetting(SETTINGS_KEY)
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Error('Invalid native Claude settings map')
  const result: ClaudeNativeSettings = {}
  for (const [profileDir, config] of Object.entries(parsed)) {
    const normalized = normalizeClaudeNativeProfile(profileDir)
    if (Object.hasOwn(result, normalized))
      throw Error('Duplicate native Claude profile configuration')
    result[normalized] = parseClaudeNativeProfileConfig(config)
  }
  return result
}

export function getClaudeNativeProfileConfig(profileDir: string): ClaudeNativeProfileConfig | null {
  const settings = getClaudeNativeSettings()
  let profile: string
  try {
    profile = normalizeClaudeNativeProfile(profileDir)
  } catch {
    return null
  }
  return settings[profile] ?? null
}

export function setClaudeNativeProfileConfig(
  profileDir: string,
  config: ClaudeNativeProfileConfig | null,
): ClaudeNativeSettings {
  const profile = normalizeClaudeNativeProfile(profileDir)
  const settings = getClaudeNativeSettings()
  const optedOut = getOptedOutProfiles()
  if (config === null) {
    delete settings[profile]
    // "Use standard controls" is a person's choice; the auto-enable below must never undo it.
    optedOut.add(profile)
  } else {
    optedOut.delete(profile)
    const validated = parseClaudeNativeProfileConfig(config)
    if (
      Object.entries(settings).some(
        ([other, value]) => other !== profile && value.port === validated.port,
      )
    ) {
      throw Error('Native Claude port is already registered to another profile')
    }
    settings[profile] = validated
  }
  setSetting(SETTINGS_KEY, JSON.stringify(settings))
  setSetting(OPTED_OUT_KEY, JSON.stringify([...optedOut]))
  return settings
}

const OPTED_OUT_KEY = 'claude_native_opted_out'
const AUTO_PORT_FIRST = 19300
const AUTO_PORT_LAST = 19999

function getOptedOutProfiles(): Set<string> {
  const raw = getSetting(OPTED_OUT_KEY)
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * NATIVE CONTROL IS THE DEFAULT FOR EVERY DESKTOP PROFILE (owner, 2026-09-20). A profile with no
 * configuration gets `native-only` + `launchDebugger` on the first unused port, so a new account
 * never falls back to Lua/UIA the way #38 did after being skipped by the 2026-09-19 rollout. A
 * profile a person switched to standard controls is left alone. Returns the config in force, or
 * null when the profile is opted out, the path is not a profile, or no port is free.
 */
export function ensureClaudeNativeProfileConfig(
  profileDir: string,
): ClaudeNativeProfileConfig | null {
  let profile: string
  try {
    profile = normalizeClaudeNativeProfile(profileDir)
  } catch {
    return null
  }
  const settings = getClaudeNativeSettings()
  if (settings[profile]) return settings[profile]
  if (getOptedOutProfiles().has(profile)) return null
  const used = new Set(Object.values(settings).map((c) => c.port))
  for (let port = AUTO_PORT_FIRST; port <= AUTO_PORT_LAST; port++) {
    if (used.has(port)) continue
    const config: ClaudeNativeProfileConfig = { port, mode: 'native-only', launchDebugger: true }
    setClaudeNativeProfileConfig(profile, config)
    return config
  }
  return null
}
