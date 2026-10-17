// server/src/core/own-name.ts - AgentHydra's long-lived processes run under a name of their own.
//
// Chats stop their own dev servers with `taskkill /F /IM bun.exe` or `Stop-Process -Name bun`, and
// that is fine for them (owner, 2026-10-17: "Those are fine within reason"). It used to end the
// daemon and Desk's server as well, since both ran as bun.exe: eight such kills from four projects'
// chats on 2026-10-15..17 ended the daemon five times, and Desk's server, which nothing revives,
// once stayed down 48 minutes. So the daemon runs on a copy of the bun in use named
// AgentHydra-daemon.exe (Desk's server on AgentHydra-desk.exe, made by desk2/launcher/start.ps1):
// the same program under a name those commands do not match.
//
// Beside the copy, `<copy>.source.json` names the bun it was copied from and that file's size and
// time. It says when the copy is stale (bun was upgraded) and lets anything running on the copy
// find the real bun's folder. A running copy cannot be overwritten but can be renamed, so a refresh
// moves it aside (`<copy>.<ticks>.old`, removed once nothing runs it) and puts the new one in place.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const DAEMON_EXE_NAME = 'AgentHydra-daemon.exe'

/** What a copy's stamp records about the bun it was made from. */
export interface CopyStamp {
  source: string
  size: number
  mtimeMs: number
}

export function stampPath(exe: string): string {
  return `${exe}.source.json`
}

export function readStamp(exe: string): CopyStamp | null {
  try {
    // PowerShell 5.1 writes a BOM with -Encoding UTF8; start.ps1 avoids it, a hand edit may not.
    const raw = readFileSync(stampPath(exe), 'utf8').replace(/^﻿/, '')
    const s = JSON.parse(raw) as Partial<CopyStamp>
    if (typeof s.source !== 'string' || typeof s.size !== 'number' || typeof s.mtimeMs !== 'number')
      return null
    return { source: s.source, size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/** The real bun behind `exe`: the file its stamp names when `exe` is one of these copies and that
 *  file is still there, else `exe` itself. */
export function realRuntime(exe: string = process.execPath): string {
  const source = readStamp(exe)?.source
  return source && existsSync(source) ? source : exe
}

/** `target` when it is a current copy of `source` (same size, and a stamp matching the source's
 *  size and time), else null. A stat of each and one small read: cheap enough for a relaunch. */
export function currentCopy(source: string, target: string): string | null {
  try {
    const src = statSync(source)
    const stamp = readStamp(target)
    if (!stamp || stamp.source !== source) return null
    if (stamp.size !== src.size || Math.trunc(stamp.mtimeMs) !== Math.trunc(src.mtimeMs))
      return null
    return statSync(target).size === src.size ? target : null
  } catch {
    return null
  }
}

export type RefreshResult =
  | { action: 'current'; path: string }
  | { action: 'copied'; path: string }
  | { action: 'failed'; path: string; detail: string }

/** Make `target` a current copy of `source`. Never throws: a copy that cannot be made leaves the
 *  launch on `source`, the name it always had. */
export async function refreshCopy(source: string, target: string): Promise<RefreshResult> {
  if (sameFile(source, target)) return { action: 'current', path: target }
  if (currentCopy(source, target)) return { action: 'current', path: target }
  const tmp = `${target}.${process.pid}.tmp`
  try {
    const src = statSync(source)
    if (!src.isFile()) return { action: 'failed', path: target, detail: `${source} is not a file` }
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, tmp)
    if (existsSync(target)) {
      // A copy something still runs cannot be deleted, but it can be renamed out of the way.
      await unlink(target).catch(() => rename(target, `${target}.${Date.now()}.old`))
    }
    await rename(tmp, target)
    const stamp: CopyStamp = { source, size: src.size, mtimeMs: src.mtimeMs }
    await writeFile(stampPath(target), JSON.stringify(stamp))
    await sweepOld(target)
    return { action: 'copied', path: target }
  } catch (error) {
    await unlink(tmp).catch(() => {})
    return { action: 'failed', path: target, detail: (error as Error).message }
  }
}

/** Whether two paths name one file. Windows spells a file many ways: process.execPath is the long,
 *  on-disk form, while a folder from the environment may be 8.3 (C:\Users\RUNNER~1) or differ in
 *  case. A daemon whose copy's source is gone runs as its own source, and a string compare there
 *  would copy the copy onto itself and stamp it as its own source, so it stopped following bun. */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return realpathSync.native(a) === realpathSync.native(b)
  } catch {
    return false
  }
}

/** Remove the copies a refresh moved aside; one a process still runs stays until the next pass. */
async function sweepOld(target: string): Promise<void> {
  const name = basename(target).toLowerCase()
  const dir = dirname(target)
  const old = (await readdir(dir).catch(() => [] as string[])).filter((f) => {
    const lower = f.toLowerCase()
    return lower.startsWith(`${name}.`) && lower.endsWith('.old')
  })
  for (const f of old) await unlink(join(dir, f)).catch(() => {})
}
