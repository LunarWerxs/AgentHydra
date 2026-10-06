// The long reply the stream-frames harness (e2e/stream-frames.e2e.ts) streams: prose with an em dash,
// then a 240-line TypeScript block (the one-byte highlight path in transcript/lib/highlight.ts), then more prose.
// Deterministic and invented; chunks are what one `item.delta` would carry.
const EM = '\u2014'

const PROSE_A = [
  `The cache layer is the culprit ${EM} not the parser, as the first trace suggested. Every refresh rebuilt the index from scratch, and the rebuild held the main thread long enough to drop frames.`,
  `Here is the fix in three steps. First, key the index by a content hash so an unchanged folder is never walked again. Second, move the walk behind a queue that yields between batches. Third, write the result once, after the last batch, instead of after each one.`,
  `The code below does all three; the helper at the top is the part worth reading twice.`,
]
const PROSE_B = [
  `That is the whole change. The queue yields every 16 entries, which keeps one batch well under a frame, and the hash makes a warm start free.`,
  `Two things to watch ${EM} a folder that changes while the queue runs is picked up on the next pass, and a symlink loop now ends at the depth limit instead of the stack.`,
]

function codeLines(n: number): string[] {
  const out = ['import { createHash } from "node:crypto"', 'import type { Dirent } from "node:fs"', '']
  let i = 0
  while (out.length < n) {
    const k = i++
    out.push(
      `export interface Entry${k} {`,
      `  path: string`,
      `  size: number`,
      `  hash: string | null`,
      `}`,
      ``,
      `export function visit${k}(dir: string, entries: Dirent[], depth = ${k % 7}): Entry${k}[] {`,
      `  const seen: Entry${k}[] = []`,
      `  for (const e of entries) {`,
      `    if (depth > 8) break // symlink loops end here`,
      `    seen.push({ path: dir + "/" + e.name, size: e.name.length * ${k + 1}, hash: null })`,
      `  }`,
      `  return seen`,
      `}`,
      ``,
    )
  }
  return out.slice(0, n)
}

const words = (s: string, per: number): string[] => {
  const w = s.split(' ')
  const out: string[] = []
  for (let i = 0; i < w.length; i += per) out.push(w.slice(i, i + per).join(' ') + (i + per < w.length ? ' ' : ''))
  return out
}

export const CODE_LINES = 240

/** The reply as the pieces it arrives in: ~8 words of prose, or 3 lines of code, per piece. */
export function streamChunks(): string[] {
  const chunks: string[] = []
  for (const p of PROSE_A) chunks.push(...words(p, 8), '\n\n')
  chunks.push('```ts\n')
  const code = codeLines(CODE_LINES)
  for (let i = 0; i < code.length; i += 3) chunks.push(code.slice(i, i + 3).join('\n') + '\n')
  chunks.push('```\n\n')
  for (const p of PROSE_B) chunks.push(...words(p, 8), '\n\n')
  return chunks
}
