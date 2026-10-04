// A worker's folder can change between turns (climayte_send `cwd`: Hydra Desk moved the chat when
// Claude cd'd out of its folder). Claude Code resumes a session only from
// <configDir>/projects/<encoded cwd>/<session>.jsonl, so the next launch copies the transcript (and
// its sidecar folder) into the new folder's project dir on the account it runs on, keeps the
// original, and resumes there. See docs/CLIMAYTE.md "Moving a worker to another folder".

import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { transcriptFile } from './climayte-core'
import { encodeCwdKey } from './transcript'

/** The folder as a normal absolute path, or a thrown reason: absolute, existing, a folder, local
 *  (no UNC share, no `\\?\` / `\\.\` device path, which Claude Code's folder key cannot mirror). */
export function validateCwd(cwd: unknown): string {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd is empty')
  const raw = cwd.trim()
  if (/^[\\/]{2}/.test(raw))
    throw new Error(`cwd '${raw}' is a network or device path, not a local folder`)
  if (!isAbsolute(raw)) throw new Error(`cwd '${raw}' is not an absolute path`)
  let ok = false
  try {
    ok = existsSync(raw) && statSync(raw).isDirectory()
  } catch {
    // unreadable: refused below
  }
  if (!ok) throw new Error(`cwd '${raw}' is not an existing folder`)
  return resolve(raw)
}

/** Copy the session from where `configDir` holds it into `cwd`'s project dir there. The original
 *  stays, and the copy keeps its mtime. False when the account holds no copy of it. */
export function copySessionToCwd(configDir: string, sessionId: string, cwd: string): boolean {
  const file = transcriptFile(configDir, sessionId)
  if (!file) return false
  const dest = join(configDir, 'projects', encodeCwdKey(cwd))
  const target = join(dest, `${sessionId}.jsonl`)
  if (resolve(file) === resolve(target)) return true
  mkdirSync(dest, { recursive: true })
  cpSync(file, target, { preserveTimestamps: true })
  const side = join(file, '..', sessionId)
  if (existsSync(side))
    cpSync(side, join(dest, sessionId), { recursive: true, preserveTimestamps: true })
  return true
}
