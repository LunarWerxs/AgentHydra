// Opens an error's `file:line:col` in the editor the person already has running (ported from DevWebUI's
// open-in-editor.ts, itself after create-react-app's launchEditor): the editor is found from the process list, each
// editor gets its own line / column flags, and bad input is refused before anything is spawned. DEVWEBUI_EDITOR (the
// person's explicit choice), VISUAL and EDITOR are honoured; a .cmd / .bat shim is never launched; the editor starts
// outside this service's process tree so it outlives a service restart.

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DevWebOpenInEditor } from '@shared/devwebui'
import { detachedCommand } from '../host/launch'
import { powershell, run } from '../localhost/ports'
import { frameFilePath } from './source-frames'

type EditorKind = 'vscode' | 'jetbrains' | 'zed' | 'sublime' | 'notepadpp'
type Failure = Extract<DevWebOpenInEditor, { ok: false }>

// Executable name (lowercase, extension dropped) to dialect, in preference order: with several running, the first kind wins.
const EDITORS: [string, EditorKind][] = [
  ['code', 'vscode'],
  ['code - insiders', 'vscode'],
  ['code-insiders', 'vscode'],
  ['cursor', 'vscode'],
  ['windsurf', 'vscode'],
  ['codium', 'vscode'],
  ['vscodium', 'vscode'],
  ...['idea', 'webstorm', 'phpstorm', 'pycharm', 'rider', 'goland', 'rubymine', 'clion'].flatMap((n): [string, EditorKind][] => [
    [n, 'jetbrains'],
    [`${n}64`, 'jetbrains'],
  ]),
  ['zed', 'zed'],
  ['sublime_text', 'sublime'],
  ['subl', 'sublime'],
  ['notepad++', 'notepadpp'],
]
const KIND_BY_NAME = new Map(EDITORS)
const KIND_RANK: EditorKind[] = ['vscode', 'jetbrains', 'zed', 'sublime', 'notepadpp']

// On macOS `ps` shows the bundle's inner binary (VS Code's is `Electron`), which does not take the CLI flags.
const MAC_LAUNCHERS: Record<string, string> = {
  'Visual Studio Code.app': 'Contents/Resources/app/bin/code',
  'Visual Studio Code - Insiders.app': 'Contents/Resources/app/bin/code-insiders',
  'Cursor.app': 'Contents/Resources/app/bin/cursor',
  'Windsurf.app': 'Contents/Resources/app/bin/windsurf',
  'VSCodium.app': 'Contents/Resources/app/bin/codium',
  'Sublime Text.app': 'Contents/SharedSupport/bin/subl',
  'Zed.app': 'Contents/MacOS/cli',
}

/** `C:\x\Code.exe` becomes `code`, on any host OS. */
function editorName(p: string): string {
  return (p.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|sh)$/, '')
}

export const editorKind = (editorPath: string): EditorKind | null => KIND_BY_NAME.get(editorName(editorPath)) ?? null

/** The argv (after the executable) that opens `file` at `line`/`column` in that editor. */
export function editorArgs(editorPath: string, file: string, line: number, column = 1): string[] {
  switch (editorKind(editorPath)) {
    case 'vscode':
      return ['-g', `${file}:${line}:${column}`]
    case 'jetbrains':
      return ['--line', String(line), '--column', String(column), file]
    case 'zed':
    case 'sublime':
      return [`${file}:${line}:${column}`]
    case 'notepadpp':
      return [`-n${line}`, `-c${column}`, file]
    default:
      return [file]
  }
}

/** From a process listing (an executable per line), the most-preferred known editor; null when none runs. */
export function pickEditor(lines: string[], platform: NodeJS.Platform): string | null {
  let best: { path: string; rank: number } | null = null
  for (const raw of lines) {
    let p = raw.trim()
    if (!p) continue
    if (platform === 'darwin') {
      const bundle = /^(.*?\/([^/]+\.app))\/Contents\//.exec(p)
      const launcher = bundle?.[2] ? MAC_LAUNCHERS[bundle[2]] : undefined
      if (bundle?.[1] && launcher) p = `${bundle[1]}/${launcher}`
    }
    const kind = editorKind(p)
    if (!kind) continue
    const rank = KIND_RANK.indexOf(kind)
    if (!best || rank < best.rank) best = { path: p, rank }
  }
  return best?.path ?? null
}

async function runningExecutables(platform: NodeJS.Platform): Promise<string[]> {
  const out = platform === 'win32' ? await powershell('Get-CimInstance -ClassName Win32_Process | ForEach-Object { $_.ExecutablePath }') : await run('ps', ['x', '-o', 'comm='])
  return (out ?? '').split(/\r?\n/)
}

/** Windows launches a real `.exe` only (never a .cmd / .bat shim); finds one for `name`. */
function findWindowsExe(name: string, env: NodeJS.ProcessEnv): string | null {
  if (/\.(?:cmd|bat)$/i.test(name)) return null
  const withExt = /\.exe$/i.test(name) ? name : `${name}.exe`
  if (path.win32.isAbsolute(withExt)) return existsSync(withExt) ? withExt : null
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    const candidate = path.win32.join(dir, withExt)
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function resolveEditor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<{ editor: string } | Failure> {
  const explicit = env.DEVWEBUI_EDITOR?.trim()
  if (explicit) {
    if (platform !== 'win32') return { editor: explicit }
    const exe = findWindowsExe(explicit, env)
    return exe ? { editor: exe } : { ok: false, reason: 'unsupported-editor', detail: "DEVWEBUI_EDITOR must name the editor's .exe (a .cmd/.bat shim cannot be launched)" }
  }
  const running = pickEditor(await runningExecutables(platform), platform)
  if (running) return { editor: running }
  for (const v of [env.VISUAL, env.EDITOR]) {
    const named = v?.trim()
    if (!named || !editorKind(named)) continue
    const editor = platform === 'win32' ? findWindowsExe(named, env) : named
    if (editor) return { editor }
  }
  return { ok: false, reason: 'no-editor', detail: 'no running editor found; open one or set DEVWEBUI_EDITOR' }
}

/**
 * Validates a request before anything is spawned: line and column are positive whole numbers (they are spliced into
 * the editor's arguments), the path carries no control characters, a UNC path is refused (opening one makes Windows
 * authenticate to that host), and a relative path needs the server's folder to resolve against.
 */
export function validateOpenRequest(req: { file?: unknown; line?: unknown; column?: unknown }, cwd?: string): { ok: true; file: string; line: number; column: number } | Failure {
  const bad = (detail: string): Failure => ({ ok: false, reason: 'bad-input', detail })
  const line = req.line ?? 1
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return bad('line must be a positive integer')
  if (req.column !== undefined && (typeof req.column !== 'number' || !Number.isInteger(req.column) || req.column < 1)) return bad('column must be a positive integer')
  if (typeof req.file !== 'string' || !req.file.trim() || req.file.length > 4096) return bad('file must be a non-empty path')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(req.file)) return bad('file contains control characters')
  const raw = frameFilePath(req.file.trim())
  if (/^[\\/]{2}/.test(raw)) return bad('network (UNC) paths are not opened')
  const absolute = path.isAbsolute(raw) || path.win32.isAbsolute(raw)
  if (!absolute && !cwd) return bad('a relative path needs the processId it was logged by')
  const resolved = absolute ? path.resolve(raw) : path.resolve(cwd as string, raw)
  // Resolving can turn an innocent-looking path (or a cwd) into a share; `\\?\UNC\host\...` starts with `\\` too.
  if (/^[\\/]{2}/.test(resolved)) return bad('network (UNC) paths are not opened')
  return { ok: true, file: resolved, line, column: (req.column as number | undefined) ?? 1 }
}

/** Starts the editor outside this process tree; false when it cannot start. */
function launch(editor: string, args: string[]): Promise<boolean> {
  const plan = detachedCommand(process.platform, [editor, ...args])
  return new Promise((resolve) => {
    try {
      const child = spawn(plan.argv[0] as string, plan.argv.slice(1), { detached: plan.detached, stdio: 'ignore', windowsHide: true })
      child.once('error', () => resolve(false))
      child.once('spawn', () => resolve(true))
      child.unref()
    } catch {
      resolve(false)
    }
  })
}

/** Opens `req.file` at its line / column in the person's editor. Never throws. */
export async function openInEditor(req: { file?: unknown; line?: unknown; column?: unknown }, cwd?: string): Promise<DevWebOpenInEditor> {
  const checked = validateOpenRequest(req, cwd)
  if (!checked.ok) return checked
  const { file, line, column } = checked
  try {
    if (!statSync(file).isFile()) return { ok: false, reason: 'not-found', detail: file }
  } catch {
    return { ok: false, reason: 'not-found', detail: file }
  }
  const found = await resolveEditor(process.platform, process.env)
  if (!('editor' in found)) return found
  const started = await launch(found.editor, editorArgs(found.editor, file, line, column))
  return started ? { ok: true, editor: editorName(found.editor), file, line, column } : { ok: false, reason: 'launch-failed', detail: found.editor }
}
