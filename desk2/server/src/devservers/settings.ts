// <home>/devservers/settings.json: the dev servers' settings (DevWebSettings) plus the internal `firstScanDone` latch.
// On the very first run the matching keys are taken from DevWebUI's old settings.json (read only; that file also holds
// an install id and sync data, which are never copied).

import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { DevWebRuntimePref, DevWebSettings, DevWebSkipOs } from '@shared/devwebui'
import { DevServerError } from './contract'
import { parseJsonText, writeJsonAtomic } from './project-file'
import { dataDir } from './registry'
import { OS_SKIP } from './scan'

export const settingsPath = (home: string): string => path.join(dataDir(home), 'settings.json')

const RUNTIMES: DevWebRuntimePref[] = ['auto', 'node', 'bun']
const OSES: DevWebSkipOs[] = ['windows', 'mac', 'linux']
const BOOLS = ['freePortOnStart', 'autoStartOnLaunch', 'monitorResources', 'autoScan', 'skipWindows', 'skipMac', 'skipLinux'] as const

export function defaultSettings(platform: NodeJS.Platform = process.platform): DevWebSettings {
  return {
    runtime: 'auto',
    freePortOnStart: false,
    autoStartOnLaunch: false,
    monitorResources: true,
    linkHost: '',
    autoScan: false,
    scanExclude: [],
    skipWindows: platform === 'win32',
    skipMac: platform === 'darwin',
    skipLinux: platform === 'linux',
    osSkip: { windows: [...OS_SKIP.windows], mac: [...OS_SKIP.mac], linux: [...OS_SKIP.linux] },
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const uniq = (list: unknown[], lower: boolean): string[] => [...new Set(list.map((s) => String(s).trim()).filter(Boolean).map((s) => (lower ? s.toLowerCase() : s)))]

/** The keys of `src` that are valid settings, quietly dropping the rest (a hand-edited or imported file). */
function lenient(src: unknown): Partial<DevWebSettings> {
  const out: Partial<DevWebSettings> = {}
  if (!isObject(src)) return out
  if (RUNTIMES.includes(src.runtime as DevWebRuntimePref)) out.runtime = src.runtime as DevWebRuntimePref
  for (const k of BOOLS) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean
  if (typeof src.linkHost === 'string') out.linkHost = src.linkHost.trim()
  if (Array.isArray(src.scanExclude)) out.scanExclude = uniq(src.scanExclude, false)
  if (isObject(src.osSkip)) {
    const os = src.osSkip
    const base = defaultSettings().osSkip
    out.osSkip = { windows: base.windows, mac: base.mac, linux: base.linux }
    for (const k of OSES) if (Array.isArray(os[k])) out.osSkip[k] = uniq(os[k] as unknown[], true)
  }
  return out
}

function readJson(file: string): unknown {
  try {
    return parseJsonText(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function readSettings(home: string, importFrom: string | null): { settings: DevWebSettings; firstScanDone: boolean } {
  const file = settingsPath(home)
  let raw = readJson(file)
  if (raw === null && importFrom) {
    // First run: only the settings keys carry over, and the latch stays off so the first scan still happens here.
    const old = lenient(readJson(path.join(importFrom, 'settings.json')))
    if (Object.keys(old).length) {
      const settings = { ...defaultSettings(), ...old }
      try {
        writeSettings(home, settings, false)
      } catch {
        // floor-ok: the import is tried again on the next start
      }
      return { settings, firstScanDone: false }
    }
  }
  if (!isObject(raw)) raw = {}
  const o = raw as Record<string, unknown>
  return { settings: { ...defaultSettings(), ...lenient(o) }, firstScanDone: o.firstScanDone === true }
}

export function writeSettings(home: string, s: DevWebSettings, firstScanDone: boolean): void {
  mkdirSync(dataDir(home), { recursive: true })
  writeJsonAtomic(settingsPath(home), { ...s, firstScanDone })
}

/** Validates a PATCH body: a wrong type is a 400 naming the key, an unknown key is ignored. Text lists are trimmed and de-duplicated. */
export function cleanSettingsPatch(patch: unknown, current?: DevWebSettings): Partial<DevWebSettings> {
  if (!isObject(patch)) throw new DevServerError('the settings change must be an object', 400)
  const out: Partial<DevWebSettings> = {}
  if (patch.runtime !== undefined) {
    if (!RUNTIMES.includes(patch.runtime as DevWebRuntimePref)) throw new DevServerError('runtime must be auto, node or bun', 400)
    out.runtime = patch.runtime as DevWebRuntimePref
  }
  for (const k of BOOLS) {
    if (patch[k] === undefined) continue
    if (typeof patch[k] !== 'boolean') throw new DevServerError(`${k} must be true or false`, 400)
    out[k] = patch[k] as boolean
  }
  if (patch.linkHost !== undefined) {
    if (typeof patch.linkHost !== 'string') throw new DevServerError('linkHost must be text', 400)
    const host = patch.linkHost.trim()
    if (host.length > 253 || /[\s/\\?#@]/.test(host)) throw new DevServerError('linkHost must be a host name or address, such as my-pc or 192.168.1.20', 400)
    out.linkHost = host
  }
  if (patch.scanExclude !== undefined) {
    if (!Array.isArray(patch.scanExclude) || patch.scanExclude.some((x) => typeof x !== 'string')) throw new DevServerError('scanExclude must be a list of folder names or paths', 400)
    out.scanExclude = uniq(patch.scanExclude, false).slice(0, 500)
  }
  if (patch.osSkip !== undefined) {
    const os = patch.osSkip
    if (!isObject(os)) throw new DevServerError('osSkip must map windows, mac and linux to folder name lists', 400)
    // The lists the patch leaves out stay as they are now, not as the defaults.
    const next = { ...(current?.osSkip ?? defaultSettings().osSkip) }
    for (const k of OSES) {
      if (os[k] === undefined) continue
      if (!Array.isArray(os[k]) || (os[k] as unknown[]).some((x) => typeof x !== 'string')) throw new DevServerError(`osSkip.${k} must be a list of folder names`, 400)
      next[k] = uniq(os[k] as unknown[], true).slice(0, 500)
    }
    out.osSkip = next
  }
  return out
}
