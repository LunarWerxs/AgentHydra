import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR, resolveCodexExe } from '../config'
import type { CodexInstance } from '../types'
import {
  type CodexDesktopRuntime,
  codexDesktopUserDataDir,
  focusCodexDesktop,
  isCodexDesktopRunning,
  listCodexDesktopProcesses,
  openCodexDesktop,
  quitCodexDesktop,
} from './codex-desktop'
import { CODEX_LAUNCH_EFFORTS, type LaunchOptionsInput, launchOptionError } from './launch-options'
import { isPathInside, normalizePath } from './paths'
import type { CMActionResult } from './shared'

const CODEX_INSTANCES_ROOT = join(CONFIG_DIR, 'codex-instances')
const STORE_PATH = join(CONFIG_DIR, 'codex-instances.json')
const NAME_MAX = 60

type StoredCodexInstance = Omit<
  CodexInstance,
  'loggedIn' | 'desktopUserDataDir' | 'isDesktopRunning' | 'desktopPid'
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

function hydrate(
  instance: StoredCodexInstance,
  runtime: CodexDesktopRuntime | null = null,
): CodexInstance {
  return {
    ...instance,
    loggedIn: isCodexLoggedIn(instance.codexHome),
    desktopUserDataDir: codexDesktopUserDataDir(instance.codexHome),
    isDesktopRunning: runtime !== null,
    desktopPid: runtime?.pid ?? null,
  }
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
  return readStore().instances.map((instance) =>
    hydrate(
      instance,
      runtimeByDir.get(normalizePath(codexDesktopUserDataDir(instance.codexHome))) ?? null,
    ),
  )
}

export function getCodexInstance(id: string): CodexInstance | null {
  const instance = readStore().instances.find((candidate) => candidate.id === id)
  return instance ? hydrate(instance) : null
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
