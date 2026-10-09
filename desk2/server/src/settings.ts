// ~/.hydra-desk-2/settings.json: the DeskSettings with SPEC.md's defaults underneath.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeskSettings, Effort, PermissionMode } from '@shared/protocol'
import { isOrchestratorModel } from '@shared/orchestrator'
import { renameOver, writeFlushed } from './write-flushed'

export const DEFAULT_SETTINGS: DeskSettings = {
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: 'bypassPermissions',
  defaultAccountId: 'auto',
  delegateToCliMayte: true,
  idleCloseMinutes: 30,
  notifications: true,
  projectFolders: [],
  projectRoots: [],
  hiddenProjects: [],
  babysitter: true,
  orchestrator: false,
  orchestratorModel: 'opus',
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

type Check = (v: unknown) => boolean
const CHECKS: { [K in keyof DeskSettings]: [Check, string] } = {
  defaultModel: [(v) => v === null || (typeof v === 'string' && v.length > 0), 'a model id or null'],
  defaultEffort: [(v) => v === null || EFFORTS.includes(v as Effort), `null or one of ${EFFORTS.join(', ')}`],
  defaultPermissionMode: [(v) => MODES.includes(v as PermissionMode), `one of ${MODES.join(', ')}`],
  defaultAccountId: [(v) => typeof v === 'string' && v.length > 0, "'auto' or an account id"],
  delegateToCliMayte: [(v) => typeof v === 'boolean', 'true or false'],
  idleCloseMinutes: [(v) => typeof v === 'number' && Number.isFinite(v) && v >= 1, 'a number of minutes, at least 1'],
  notifications: [(v) => typeof v === 'boolean', 'true or false'],
  projectFolders: [isPathList, 'a list of folder paths'],
  projectRoots: [isPathList, 'a list of folder paths'],
  hiddenProjects: [isPathList, 'a list of folder paths'],
  babysitter: [(v) => typeof v === 'boolean', 'true or false'],
  orchestrator: [(v) => typeof v === 'boolean', 'true or false'],
  orchestratorModel: [isOrchestratorModel, "'opus', 'sonnet', 'haiku' or a full model id such as claude-opus-5-5"],
}

function isPathList(v: unknown): boolean {
  return Array.isArray(v) && v.every((p) => typeof p === 'string' && p.length > 0)
}

/** Checks a partial DeskSettings from a PUT. Returns the reason it is invalid, or null when it is fine. */
export function validateSettingsPatch(patch: unknown): string | null {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return 'settings must be a JSON object'
  for (const [key, value] of Object.entries(patch)) {
    const check = CHECKS[key as keyof DeskSettings]
    if (!check) return `unknown setting: ${key}`
    if (!check[0](value)) return `${key} must be ${check[1]}`
  }
  return null
}

export function settingsPath(home: string): string {
  return join(home, 'settings.json')
}

/** Reads settings.json over the defaults; a missing file, bad JSON or an invalid field falls back to the default. */
export function loadSettings(home: string): DeskSettings {
  const settings = { ...DEFAULT_SETTINGS }
  const file = settingsPath(home)
  if (!existsSync(file)) return settings
  let saved: unknown
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`[settings] ignoring unreadable ${file}: ${(err as Error).message}`)
    return settings
  }
  if (typeof saved !== 'object' || saved === null) return settings
  for (const [key, value] of Object.entries(saved)) {
    const check = CHECKS[key as keyof DeskSettings]
    if (check?.[0](value)) (settings as Record<string, unknown>)[key] = value
  }
  return settings
}

export function saveSettings(home: string, settings: DeskSettings): void {
  mkdirSync(home, { recursive: true })
  const file = settingsPath(home)
  const tmp = `${file}.tmp`
  writeFlushed(tmp, `${JSON.stringify(settings, null, 2)}\n`)
  renameOver(tmp, file)
}

export interface SettingsStore {
  get(): DeskSettings
  /** Validates, merges and persists a partial DeskSettings. Throws SettingsError when it is invalid. */
  update(patch: unknown): DeskSettings
}

export class SettingsError extends Error {}

export function createSettingsStore(home: string): SettingsStore {
  let current = loadSettings(home)
  return {
    get: () => ({ ...current }),
    update(patch) {
      const problem = validateSettingsPatch(patch)
      if (problem) throw new SettingsError(problem)
      current = { ...current, ...(patch as Partial<DeskSettings>) }
      saveSettings(home, current)
      return { ...current }
    },
  }
}
