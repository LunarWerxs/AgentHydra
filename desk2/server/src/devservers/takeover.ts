// External auto-start "take over" (ported from DevWebUI's takeover.ts). Some repos start their dev server from outside:
// VS Code's tasks.json (`runOptions.runOn: "folderOpen"`) or the Vite extension (`vite.autoStart: true`). The outside
// launcher and AgentHydra then race for the same port. This finds those triggers and, on request, turns them off after
// backing the file up. Edits are surgical text replacements, so comments, key order and formatting survive:
//   tasks.json    "runOn": "folderOpen"   -> "runOn": "default"
//   settings.json "vite.autoStart": true  -> "vite.autoStart": false

import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { DevWebTrigger } from '@shared/devwebui'
import { parseJsonc } from './detect'
import { writeFileAtomic } from './project-file'

const BACKUP_SUFFIX = '.devwebui-bak'

function readJsonc<T>(file: string): T | null {
  try {
    return (parseJsonc(readFileSync(file, 'utf8')) ?? null) as T | null
  } catch {
    return null
  }
}

type VsCodeTask = { label?: string; command?: string; args?: unknown[]; runOptions?: { runOn?: string } }

function taskTriggers(tasksFile: string): DevWebTrigger[] {
  if (!existsSync(tasksFile)) return []
  const out: DevWebTrigger[] = []
  for (const t of readJsonc<{ tasks?: VsCodeTask[] }>(tasksFile)?.tasks ?? []) {
    if (!t || typeof t !== 'object' || t.runOptions?.runOn !== 'folderOpen') continue
    const cmd = [t.command, ...(Array.isArray(t.args) ? t.args.map(String) : [])].filter(Boolean).join(' ').trim()
    out.push({
      kind: 'vscode-task',
      file: tasksFile,
      label: t.label ? `VS Code task “${t.label}”` : 'VS Code task',
      detail: cmd ? `runs \`${cmd}\` when the folder opens` : 'runs when the folder opens'
    })
  }
  return out
}

function viteTrigger(settingsFile: string): DevWebTrigger[] {
  if (!existsSync(settingsFile)) return []
  const j = readJsonc<Record<string, unknown>>(settingsFile)
  if (j?.['vite.autoStart'] !== true) return []
  const cmd = typeof j['vite.devCommand'] === 'string' ? j['vite.devCommand'] : ''
  return [{ kind: 'vite-extension', file: settingsFile, label: '“Vite” VS Code extension', detail: cmd ? `auto-starts \`${cmd}\` when the folder opens` : 'auto-starts the dev server when the folder opens' }]
}

/** The dev servers a folder's .vscode config starts outside AgentHydra. */
export function detectAutostartTriggers(dir: string): DevWebTrigger[] {
  return [...taskTriggers(path.join(dir, '.vscode', 'tasks.json')), ...viteTrigger(path.join(dir, '.vscode', 'settings.json'))]
}

/** The VS Code files a take-over may have rewritten. */
const restorableFiles = (dir: string): string[] => [path.join(dir, '.vscode', 'tasks.json'), path.join(dir, '.vscode', 'settings.json')]

/** Backups a take-over left that can still be put back. */
export const takeoverBackups = (dir: string): string[] => restorableFiles(dir).map((f) => f + BACKUP_SUFFIX).filter((b) => existsSync(b))

/** Backs a file up once, so the pristine original survives repeated take-overs. */
function backupOnce(file: string): string | null {
  const bak = file + BACKUP_SUFFIX
  try {
    if (!existsSync(bak)) copyFileSync(file, bak)
    return bak
  } catch {
    return null
  }
}

export interface TakeOverOutcome {
  ok: boolean
  disabled: DevWebTrigger[]
  backups: string[]
  skipped: { file: string; reason: string }[]
}

/** Turns off every trigger under `dir`, one backed-up rewrite per file. A file that cannot change lands in `skipped`. */
export function takeOverAutostart(dir: string): TakeOverOutcome {
  const disabled: DevWebTrigger[] = []
  const backups: string[] = []
  const skipped: { file: string; reason: string }[] = []
  const byFile = new Map<string, DevWebTrigger[]>()
  for (const t of detectAutostartTriggers(dir)) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t])
  for (const [file, ts] of byFile) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      skipped.push({ file, reason: (e as Error).message })
      continue
    }
    let next = text
    if (ts.some((t) => t.kind === 'vscode-task')) next = next.replace(/("runOn"\s*:\s*")folderOpen(")/g, '$1default$2')
    if (ts.some((t) => t.kind === 'vite-extension')) next = next.replace(/("vite\.autoStart"\s*:\s*)true\b/g, '$1false')
    if (next === text) {
      skipped.push({ file, reason: 'nothing to change (already turned off?)' })
      continue
    }
    const bak = backupOnce(file)
    if (!bak) {
      // Never rewrite a file whose original could not be kept.
      skipped.push({ file, reason: 'could not back the file up' })
      continue
    }
    backups.push(bak)
    try {
      writeFileAtomic(file, next)
      disabled.push(...ts)
    } catch (e) {
      skipped.push({ file, reason: (e as Error).message })
    }
  }
  return { ok: skipped.length === 0 || disabled.length > 0, disabled, backups, skipped }
}

/** Copies each backup back over its original and removes it, so a later take-over captures a fresh original. */
export function restoreAutostart(dir: string): string[] {
  const restored: string[] = []
  for (const file of restorableFiles(dir)) {
    const bak = file + BACKUP_SUFFIX
    if (!existsSync(bak)) continue
    writeFileAtomic(file, readFileSync(bak, 'utf8'))
    rmSync(bak, { force: true })
    restored.push(file)
  }
  return restored
}
