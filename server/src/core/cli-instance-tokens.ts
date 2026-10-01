// server/src/core/cli-instance-tokens.ts — how many tokens have run through each CLI instance, for
// the CLI table's Tokens column (owner, 2026-10-01: "a column to show, how many tokens have been run
// through each account").
//
// The source is the instance's own transcripts (`<configDir>/projects/**/*.jsonl`): everything its
// `claude` ran on this PC, CliMayte's workers included. Work the same account did in a desktop app or
// on another PC is not in these files and is not counted.
//
// A transcript holds one line per streamed block, and every line of one reply repeats that reply's
// usage, so the count is ONE usage per message id (the last one written), never one per line.
// Counting lines read 2.2 times too high on a real orchestrator chat (2026-10-01).
//
// Served stale-while-revalidate: the route answers from memory and a sweep older than a minute
// starts another in the background. A sweep re-reads only files whose size or mtime moved; the first
// one read ~600 MB across ten instances in 1.3 s (2026-10-01).

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CliInstanceTokens } from '../types'
import { listCliInstances } from './cli-instances'

const REFRESH_AFTER_MS = 60_000

type Parts = [input: number, output: number, cacheRead: number, cacheWrite: number]

/** One transcript's tokens: one usage per message id, the last one written. */
function tokensInTranscript(text: string): Parts {
  const byMessage = new Map<string, Parts>()
  let unnamed = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let entry: { type?: string; message?: { id?: string; usage?: Record<string, unknown> } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const usage = entry?.message?.usage
    if (entry?.type !== 'assistant' || !usage) continue
    byMessage.set(entry.message?.id ?? `line-${unnamed++}`, [
      Number(usage.input_tokens) || 0,
      Number(usage.output_tokens) || 0,
      Number(usage.cache_read_input_tokens) || 0,
      Number(usage.cache_creation_input_tokens) || 0,
    ])
  }
  const sum: Parts = [0, 0, 0, 0]
  for (const p of byMessage.values()) for (let k = 0; k < 4; k++) sum[k] += p[k]
  return sum
}

interface FileEntry {
  mtimeMs: number
  size: number
  parts: Parts
}
const files = new Map<string, FileEntry>()
const totals = new Map<string, CliInstanceTokens>()
let sweptAt = 0
let sweeping: Promise<void> | null = null

async function transcriptsUnder(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const path = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await transcriptsUnder(path)))
    else if (e.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

async function partsOf(path: string): Promise<Parts | null> {
  try {
    const s = await stat(path)
    const known = files.get(path)
    if (known && known.mtimeMs === s.mtimeMs && known.size === s.size) return known.parts
    const parts = tokensInTranscript(await Bun.file(path).text())
    files.set(path, { mtimeMs: s.mtimeMs, size: s.size, parts })
    return parts
  } catch {
    // Gone or locked since the folder was listed; the next sweep reads it again.
    return null
  }
}

async function sweep(): Promise<void> {
  const seen = new Set<string>()
  for (const inst of listCliInstances()) {
    const sum: Parts = [0, 0, 0, 0]
    for (const path of await transcriptsUnder(join(inst.configDir, 'projects'))) {
      seen.add(path)
      const parts = await partsOf(path)
      if (parts) for (let k = 0; k < 4; k++) sum[k] += parts[k]
    }
    totals.set(inst.configDir, {
      input: sum[0],
      output: sum[1],
      cacheRead: sum[2],
      cacheWrite: sum[3],
      total: sum[0] + sum[1] + sum[2] + sum[3],
    })
  }
  for (const path of files.keys()) if (!seen.has(path)) files.delete(path)
  sweptAt = Date.now()
}

/** Re-read what changed, now (daemon boot, so the first page has numbers). One sweep at a time: a
 *  second caller joins the running one. */
export function refreshCliInstanceTokens(): Promise<void> {
  sweeping ??= sweep()
    .catch(() => {})
    .finally(() => {
      sweeping = null
    })
  return sweeping
}

/** This instance's tokens as of the last sweep; null until the first one finishes. */
export function cliInstanceTokens(configDir: string): CliInstanceTokens | null {
  if (Date.now() - sweptAt > REFRESH_AFTER_MS) void refreshCliInstanceTokens()
  return totals.get(configDir) ?? null
}
