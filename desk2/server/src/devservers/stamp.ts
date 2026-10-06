// The hash of the dev-servers service's own source, so Desk can tell a service that runs older code than its folder.
// One function for both sides: the service computes it when it starts (service.json carries it) and Desk computes it
// again when it looks; a difference means the service was started before the code changed.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** desk2/: every path in the hash is relative to it, so two checkouts of the same code give the same stamp. */
const ROOT = resolve(import.meta.dir, '../../..')
const DIRS = ['server/src/devservers', 'server/src/localhost']
const FILES = ['shared/devwebui.ts']

function tsFiles(rel: string): string[] {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(join(ROOT, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules') continue
    if (e.isDirectory()) out.push(...tsFiles(`${rel}/${e.name}`))
    else if (e.name.endsWith('.ts')) out.push(`${rel}/${e.name}`)
  }
  return out
}

/** sha256 over the source of the service (devservers/, localhost/ and shared/devwebui.ts), sorted by path. */
export function serviceStamp(): string {
  const files = [...DIRS.flatMap(tsFiles), ...FILES].sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    let text = ''
    try {
      text = readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      // floor-ok: a file that cannot be read hashes as empty, the same on both sides
    }
    hash.update(`${rel}\0${text}\0`)
  }
  return hash.digest('hex')
}
