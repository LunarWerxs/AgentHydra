import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CODEX_HOME, CONFIG_DIR, resolveCodexExe } from '../config'
import type { CodexInstance } from '../types'
import { localCodexAccount } from './codex-account'
import {
  type CodexDesktopRuntime,
  codexDesktopUserDataDir,
  codexPathKey,
  defaultCodexDesktopUserDataDir,
  focusCodexDesktop,
  isCodexDesktopRunning,
  listCodexDesktopProcesses,
  openCodexDesktop,
  quitCodexDesktop,
} from './codex-desktop'
import { instanceNumbers, instanceRef } from './instance-numbers'
import { CODEX_LAUNCH_EFFORTS, type LaunchOptionsInput, launchOptionError } from './launch-options'
import { isPathInside, normalizePath } from './paths'
import type { CMActionResult } from './shared'

const CODEX_INSTANCES_ROOT = join(CONFIG_DIR, 'codex-instances')
const STORE_PATH = join(CONFIG_DIR, 'codex-instances.json')
const NAME_MAX = 60

/** The store deliberately does NOT hold `num`: the number registry (core/instance-numbers.ts) owns
 *  it, so there is exactly one place it can be assigned from and no stale mirror to reconcile. */
type StoredCodexInstance = Omit<
  CodexInstance,
  | 'num'
  | 'loggedIn'
  | 'account'
  | 'desktopUserDataDir'
  | 'isDesktopRunning'
  | 'desktopPid'
  | 'isExternal'
  | 'isDefault'
>

interface Store {
  instances: StoredCodexInstance[]
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    if (parsed && Array.isArray(parsed.instances)) return { instances: parsed.instances }
  } catch {
    // Missing/corrupt state behaves like an empty registry.
  }
  return { instances: [] }
}

function writeStore(store: Store): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
}

export function isCodexLoggedIn(codexHome: string): boolean {
  try {
    return existsSync(join(codexHome, 'auth.json'))
  } catch {
    return false
  }
}

/** An instance row before its number is stamped on. Every builder below produces this shape; the
 *  number is attached in ONE place (numbered/withNumbers) so a row can never escape without one. */
type UnnumberedCodexInstance = Omit<CodexInstance, 'num'>

/** Stamp the permanent number onto a whole list in a single registry read/write. */
function withNumbers(rows: UnnumberedCodexInstance[]): CodexInstance[] {
  const numbers = instanceNumbers(rows.map((r) => instanceRef('codex', r.id)))
  return rows.map((row) => ({ ...row, num: numbers.get(instanceRef('codex', row.id)) ?? 0 }))
}

function hydrate(
  instance: StoredCodexInstance,
  runtime: CodexDesktopRuntime | null = null,
): UnnumberedCodexInstance {
  return {
    ...instance,
    loggedIn: isCodexLoggedIn(instance.codexHome),
    // Eager, because it is cheap here: auth.json is plain JSON and the identity is a base64 payload
    // decode, so the Codex table gets an email/plan on first paint with no extra request. The live
    // usage route refreshes the plan from the server-computed value (see codex-account.ts).
    account: localCodexAccount(instance.codexHome),
    desktopUserDataDir: codexDesktopUserDataDir(instance.codexHome),
    isDesktopRunning: runtime !== null,
    desktopPid: runtime?.pid ?? null,
    isExternal: false,
    isDefault: false,
  }
}

/** Stable synthetic id for the default install. Not a uuid, so it can never collide with a stored
 *  row and is recognizable in a usage cache key (`codex:default`). */
export const DEFAULT_CODEX_INSTANCE_ID = 'default'

/** Synthetic id for a Codex Desktop discovered running from an unrecognized profile. */
const externalIdFor = (userDataDir: string): string => `external:${codexPathKey(userDataDir)}`

/**
 * The rows this app did not create: the DEFAULT Codex install, plus any Codex Desktop running from
 * a profile that belongs to no stored instance.
 *
 * Why this exists: before it, `listCodexInstances` returned only rows created through this app, so a
 * user with a perfectly normal Codex Desktop running saw an empty table and the message "No Codex
 * instances found" (owner-reported 2026-08-07). The Claude side already lists such installs via
 * `CMInstance.isExternal`; this is the same rule for Codex.
 *
 * The default install is listed WHETHER OR NOT it is running, because its identity lives in
 * CODEX_HOME on disk and is readable either way — the same reason the Claude table resolves stopped
 * instances. Its profile path is taken from the running process when there is one (authoritative,
 * no platform guessing) and from the documented default otherwise.
 */
function discoveredInstances(
  runtimes: CodexDesktopRuntime[],
  claimed: Set<string>,
): UnnumberedCodexInstance[] {
  const out: UnnumberedCodexInstance[] = []

  const defaultProfile = defaultCodexDesktopUserDataDir()
  const defaultKey = codexPathKey(defaultProfile)
  const defaultRuntime = runtimes.find((r) => codexPathKey(r.desktopUserDataDir) === defaultKey)
  if (!claimed.has(codexPathKey(CODEX_HOME))) {
    out.push({
      id: DEFAULT_CODEX_INSTANCE_ID,
      name: basename(CODEX_HOME),
      codexHome: CODEX_HOME,
      loggedIn: isCodexLoggedIn(CODEX_HOME),
      account: localCodexAccount(CODEX_HOME),
      desktopUserDataDir: defaultRuntime?.desktopUserDataDir ?? defaultProfile,
      isDesktopRunning: defaultRuntime !== undefined,
      desktopPid: defaultRuntime?.pid ?? null,
      isExternal: true,
      isDefault: true,
      createdAt: 0,
    })
  }

  for (const runtime of runtimes) {
    const key = codexPathKey(runtime.desktopUserDataDir)
    if (key === defaultKey) continue // already the default row above
    // A profile we launched sits at <codexHome>/desktop, so the parent IS the CODEX_HOME. For a
    // profile someone else chose that inference can be wrong, which is why the row is flagged
    // external: it is listed and readable, never renamed or deleted.
    const codexHome = dirname(runtime.desktopUserDataDir)
    if (claimed.has(codexPathKey(codexHome))) continue
    claimed.add(codexPathKey(codexHome))
    out.push({
      id: externalIdFor(runtime.desktopUserDataDir),
      name: basename(codexHome),
      codexHome,
      loggedIn: isCodexLoggedIn(codexHome),
      account: localCodexAccount(codexHome),
      desktopUserDataDir: runtime.desktopUserDataDir,
      isDesktopRunning: true,
      desktopPid: runtime.pid,
      isExternal: true,
      isDefault: false,
      createdAt: 0,
    })
  }

  return out
}

export interface ListCodexInstancesOptions {
  listDesktopProcesses?: () => Promise<CodexDesktopRuntime[]>
}

export async function listCodexInstances(
  options: ListCodexInstancesOptions = {},
): Promise<CodexInstance[]> {
  const runtimes = await (options.listDesktopProcesses ?? listCodexDesktopProcesses)()
  const runtimeByDir = new Map(
    runtimes.map((runtime) => [normalizePath(runtime.desktopUserDataDir), runtime]),
  )
  const stored = readStore().instances.map((instance) =>
    hydrate(
      instance,
      runtimeByDir.get(normalizePath(codexDesktopUserDataDir(instance.codexHome))) ?? null,
    ),
  )
  // Stored rows claim their CODEX_HOME first, so discovery can never duplicate one that this app
  // manages (e.g. an instance deliberately pointed at the default home).
  const claimed = new Set(stored.map((instance) => codexPathKey(instance.codexHome)))
  return withNumbers([...stored, ...discoveredInstances(runtimes, claimed)])
}

/**
 * One STORED instance by id. Stays synchronous, and stays store-only, because every caller is a
 * mutating action (launch / open / quit / rename / delete) and those apply solely to instances this
 * app created — a discovered row has no store entry to act on.
 */
export function getCodexInstance(id: string): CodexInstance | null {
  const instance = readStore().instances.find((candidate) => candidate.id === id)
  return instance ? (withNumbers([hydrate(instance)])[0] ?? null) : null
}

/**
 * One instance by id INCLUDING the discovered ones, for the read-only routes (account, usage) —
 * so the default install's identity and quota are readable exactly like a stored instance's.
 *
 * Falls back to the (cached) process scan only when the id is not in the store, so the common
 * stored-row lookup stays a pure file read.
 */
export async function findCodexInstance(id: string): Promise<CodexInstance | null> {
  const stored = getCodexInstance(id)
  if (stored) return stored
  if (id !== DEFAULT_CODEX_INSTANCE_ID && !id.startsWith('external:')) return null
  return (await listCodexInstances()).find((candidate) => candidate.id === id) ?? null
}

function validName(name: string): string | null {
  const value = (name ?? '').trim()
  if (!value) return 'Name cannot be empty.'
  if (value.length > NAME_MAX) return `Name must be ≤ ${NAME_MAX} chars.`
  return null
}

export function createCodexInstance(name: string): CMActionResult {
  const reason = validName(name)
  if (reason)
    return {
      ok: false,
      action: 'codex-create',
      dir: null,
      message: reason,
      data: { name },
    }

  const id = crypto.randomUUID()
  const codexHome = join(CODEX_INSTANCES_ROOT, id)
  try {
    mkdirSync(codexHome, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      action: 'codex-create',
      dir: codexHome,
      message: `Failed to create CODEX_HOME '${codexHome}': ${error instanceof Error ? error.message : String(error)}`,
      data: { name },
    }
  }

  const instance: StoredCodexInstance = {
    id,
    name: name.trim(),
    codexHome,
    createdAt: Date.now(),
  }
  const store = readStore()
  store.instances.push(instance)
  writeStore(store)
  return {
    ok: true,
    action: 'codex-create',
    dir: codexHome,
    message: `Codex instance '${instance.name}' created. Use Log in to authenticate it.`,
    data: { id, codexHome },
  }
}

export function renameCodexInstance(id: string, name: string): CMActionResult {
  const reason = validName(name)
  if (reason)
    return {
      ok: false,
      action: 'codex-rename',
      dir: null,
      message: reason,
      data: { id },
    }
  const store = readStore()
  const instance = store.instances.find((candidate) => candidate.id === id)
  if (!instance)
    return {
      ok: false,
      action: 'codex-rename',
      dir: null,
      message: 'Codex instance not found.',
      data: { id },
    }
  instance.name = name.trim()
  writeStore(store)
  return {
    ok: true,
    action: 'codex-rename',
    dir: instance.codexHome,
    message: 'Renamed.',
    data: { id },
  }
}

export async function deleteCodexInstance(
  id: string,
  confirmName?: string,
  options: { listDesktopProcesses?: () => Promise<CodexDesktopRuntime[]> } = {},
): Promise<CMActionResult> {
  const store = readStore()
  const index = store.instances.findIndex((candidate) => candidate.id === id)
  if (index < 0)
    return {
      ok: false,
      action: 'codex-delete',
      dir: null,
      message: 'Codex instance not found.',
      data: { id },
    }
  const instance = store.instances[index]!
  if (!confirmName || confirmName !== instance.name)
    return {
      ok: false,
      action: 'codex-delete',
      dir: instance.codexHome,
      message: `Refusing to delete: confirmName must exactly match '${instance.name}'.`,
      data: { id },
    }

  if (
    await isCodexDesktopRunning(instance, options.listDesktopProcesses ?? listCodexDesktopProcesses)
  ) {
    return {
      ok: false,
      action: 'codex-delete',
      dir: instance.codexHome,
      message: 'Quit this Codex Desktop instance before deleting it.',
      data: { id },
    }
  }

  if (isPathInside(CODEX_INSTANCES_ROOT, instance.codexHome)) {
    try {
      rmSync(instance.codexHome, { recursive: true, force: true })
    } catch {
      // Best effort: remove the registry entry so a locked directory cannot wedge the UI.
    }
  }
  store.instances.splice(index, 1)
  writeStore(store)
  return {
    ok: true,
    action: 'codex-delete',
    dir: instance.codexHome,
    message: `Codex instance '${instance.name}' deleted.`,
    data: { id },
  }
}

function missingCodexInstance(action: string, id: string): CMActionResult {
  return {
    ok: false,
    action,
    dir: null,
    message: 'Codex instance not found.',
    data: { id },
  }
}

export async function openCodexDesktopInstance(id: string): Promise<CMActionResult> {
  const instance = getCodexInstance(id)
  return instance ? openCodexDesktop(instance) : missingCodexInstance('codex-desktop-open', id)
}

export async function focusCodexDesktopInstance(id: string): Promise<CMActionResult> {
  const instance = getCodexInstance(id)
  return instance ? focusCodexDesktop(instance) : missingCodexInstance('codex-desktop-focus', id)
}

export async function quitCodexDesktopInstance(id: string): Promise<CMActionResult> {
  const instance = getCodexInstance(id)
  return instance ? quitCodexDesktop(instance) : missingCodexInstance('codex-desktop-quit', id)
}

export interface CodexLaunchOptions extends LaunchOptionsInput {
  login?: boolean
}

export function launchCodexInstance(id: string, options: CodexLaunchOptions = {}): CMActionResult {
  const instance = getCodexInstance(id)
  if (!instance)
    return {
      ok: false,
      action: 'codex-launch',
      dir: null,
      message: 'Codex instance not found.',
      data: { id },
    }

  const optionError = options.login ? null : launchOptionError(options, CODEX_LAUNCH_EFFORTS)
  if (optionError)
    return {
      ok: false,
      action: 'codex-launch',
      dir: instance.codexHome,
      message: optionError,
      data: { id },
    }

  const exe = resolveCodexExe()
  const args: string[] = options.login ? ['login'] : []
  if (!options.login && typeof options.model === 'string') args.push('--model', options.model)
  if (!options.login && typeof options.effort === 'string')
    args.push('-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`)
  const env = {
    ...(process.env as Record<string, string>),
    CODEX_HOME: instance.codexHome,
  }

  try {
    if (process.platform === 'win32') {
      const inner = [`"${exe}"`, ...args.map((arg) => JSON.stringify(arg))].join(' ')
      Bun.spawn(['cmd', '/c', 'start', '', 'cmd', '/k', inner], {
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        // Hide only the transient launcher cmd; `start` still creates the visible inner terminal.
        windowsHide: true,
      })
    } else if (process.platform === 'darwin') {
      const command = `CODEX_HOME=${JSON.stringify(instance.codexHome)} ${JSON.stringify(exe)} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`
      Bun.spawn([
        'osascript',
        '-e',
        `tell application "Terminal" to do script ${JSON.stringify(command)}`,
      ])
    } else {
      const command = `${JSON.stringify(exe)} ${args.map((arg) => JSON.stringify(arg)).join(' ')}; exec bash`
      Bun.spawn(['x-terminal-emulator', '-e', 'bash', '-lc', command], {
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
    }
  } catch (error) {
    return {
      ok: false,
      action: options.login ? 'codex-login' : 'codex-launch',
      dir: instance.codexHome,
      message: `Failed to open a terminal: ${error instanceof Error ? error.message : String(error)}`,
      data: { id },
    }
  }

  return {
    ok: true,
    action: options.login ? 'codex-login' : 'codex-launch',
    dir: instance.codexHome,
    message: options.login
      ? 'Opened Codex login in a terminal.'
      : 'Launched a terminal for this Codex instance.',
    data: { id, codexHome: instance.codexHome },
  }
}
