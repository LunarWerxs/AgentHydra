// A window opened before a rebuild still asks for the chunks of the build it loaded. Its files are copied into the new
// build (with their age) for a week, so a lazy import from the old page still resolves after the swap.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const KEEP_MS = 7 * 24 * 60 * 60 * 1000

export function retainAssets(liveDir: string, nextDir: string, now = Date.now()): string[] {
  const from = join(liveDir, 'assets')
  if (!existsSync(from)) return []
  const to = join(nextDir, 'assets')
  mkdirSync(to, { recursive: true })
  const kept: string[] = []
  for (const name of readdirSync(from)) {
    const source = join(from, name)
    const st = statSync(source)
    if (!st.isFile() || now - st.mtimeMs > KEEP_MS || existsSync(join(to, name))) continue
    cpSync(source, join(to, name), { preserveTimestamps: true })
    kept.push(name)
  }
  return kept
}
