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
  if (config === null) delete settings[profile]
  else {
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
  return settings
}
