// The hash of the dev-servers service's own source, so Desk can tell a service that runs older code than its folder.
// One function for both sides: the service computes it when it starts (service.json carries it) and Desk computes it
// again when it looks; a difference means the service was started before the code changed.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DIRS = ['server/src/devservers', 'server/src/localhost']
const FILES = ['shared/devwebui.ts']

/** desk2/: the nearest folder above this file that holds shared/devwebui.ts. Every path in the hash is relative to it. */
function findRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, FILES[0] as string))) return dir
    if (dirname(dir) === dir) throw new Error(`no ${FILES[0]} above ${from}`)
  }
}

const ROOT = findRoot(import.meta.dir)

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

/** The last stamp and the files' paths, mtimes and sizes it was computed from: the same list hashes the same. */
let last: { key: string; value: string } | null = null

/** sha256 over the source of the service (devservers/, localhost/ and shared/devwebui.ts), sorted by path. */
export function serviceStamp(): string {
  const files = [...DIRS.flatMap(tsFiles), ...FILES].sort()
  const key = files
    .map((rel) => {
      try {
        const st = statSync(join(ROOT, rel))
        return `${rel}:${st.mtimeMs}:${st.size}`
      } catch {
        return `${rel}:-`
      }
    })
    .join('\n')
  if (last?.key === key) return last.value
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
  last = { key, value: hash.digest('hex') }
  return last.value
}
