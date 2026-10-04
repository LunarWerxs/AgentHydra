// server/src/loop-detector.ts — notice a Claude session stuck re-running the same failing tool call.
//
// WHY THIS EXISTS. An agent that keeps re-running the same failing tool call burns quota and gets
// nowhere, and on a long unattended run nobody is watching to notice. So a background sweep reads
// the tails of recently written transcripts, and when the newest tool results are the same call
// with the same input failing LOOP_MIN times in a row, it records an incident through the existing
// incidents system (which also handles dedup and notification).
//
// The idea comes from omnigent-ai/omnigent (Apache-2.0); the idea only, no code was copied.
//
// Claude only: Claude marks a failed tool result with `is_error`, and the other tools' transcripts
// carry no such flag, so there is nothing reliable to detect a failure with there.

import { deliverIncidentNotification, recordIncident } from './incidents'
import { getSession } from './sessions'
import { ensureTranscriptIndex } from './transcript'

/** Identical failing calls in a row before it counts as a loop. */
const LOOP_MIN = 5
/** Only transcripts written in the last 10 minutes: a session that is still at it. */
const WINDOW_MS = 10 * 60 * 1000
/** Bytes of tail to read per candidate; a few dozen recent tool calls fit comfortably. */
const TAIL_BYTES = 512 * 1024
/** How often the sweep runs. */
const POLL_MS = 60_000

export interface ToolLoop {
  tool: string
  count: number
  firstCallId: string
  error: string
}

/** File revision last read, by path: an unchanged transcript cannot have started a new loop. */
const memo = new Map<string, { mtimeMs: number; sizeBytes: number }>()
/** Session id -> firstCallId of the loop already recorded, so one loop is one incident, not one per sweep. */
const reported = new Map<string, string>()

function resultText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** The run of identical failing calls the transcript currently ENDS with, if it is long enough. Pure. */
export function findToolLoop(jsonl: string): ToolLoop | null {
  const calls = new Map<string, { name: string; input: string }>()
  const results: Array<{
    id: string
    name: string
    input: string
    failed: boolean
    error: string
  }> = []
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue
    let ev: any
    try {
      ev = JSON.parse(raw)
    } catch {
      continue // the first line of a tail read is usually cut off mid-line
    }
    // A subagent's calls are its own conversation; mixing them in would break up or fake a run.
    if (ev?.isSidechain === true) continue
    const content = ev?.message?.content
    if (!Array.isArray(content)) continue
    if (ev.type === 'assistant') {
      for (const b of content) {
        if (b?.type === 'tool_use' && typeof b.id === 'string') {
          calls.set(b.id, {
            name: String(b.name ?? 'tool'),
            input: JSON.stringify(b.input ?? null),
          })
        }
      }
    } else if (ev.type === 'user') {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue
        const call = calls.get(b.tool_use_id)
        if (!call) continue
        results.push({
          id: b.tool_use_id,
          ...call,
          failed: b.is_error === true,
          error: resultText(b.content),
        })
      }
    }
  }

  const last = results[results.length - 1]
  if (!last?.failed) return null
  let count = 0
  let firstCallId = last.id
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i]
    if (!r.failed || r.name !== last.name || r.input !== last.input) break
    count++
    firstCallId = r.id
  }
  if (count < LOOP_MIN) return null
  return { tool: last.name, count, firstCallId, error: last.error.slice(0, 300) }
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const file = Bun.file(path)
  const start = Math.max(0, file.size - maxBytes)
  return start > 0 ? await file.slice(start).text() : await file.text()
}

/** One sweep over recently written Claude transcripts; returns how many incidents it recorded. */
export async function scanForLoops(now = Date.now()): Promise<number> {
  // The async index, never the sync listTranscriptFiles: on a cold cache that one builds the index
  // on the event loop, and this runs on a timer while requests are in flight.
  const recent = (await ensureTranscriptIndex()).filter(
    (f) => f.source === 'claude' && now - f.mtime_ms <= WINDOW_MS,
  )
  // Both maps would otherwise grow with every session ever seen; out of the window is out of mind.
  const paths = new Set(recent.map((f) => f.path))
  const ids = new Set(recent.map((f) => f.session_id))
  for (const p of memo.keys()) if (!paths.has(p)) memo.delete(p)
  for (const id of reported.keys()) if (!ids.has(id)) reported.delete(id)

  let recorded = 0
  for (const tf of recent) {
    try {
      const known = memo.get(tf.path)
      if (known && known.mtimeMs === tf.mtime_ms && known.sizeBytes === tf.size_bytes) continue
      let text: string
      try {
        text = await readTail(tf.path, TAIL_BYTES)
      } catch {
        continue // an unreadable transcript is not a loop
      }
      memo.set(tf.path, { mtimeMs: tf.mtime_ms, sizeBytes: tf.size_bytes })

      const loop = findToolLoop(text)
      if (!loop) continue
      // The loop keeps growing while the session is stuck; the run's first call id names it.
      if (reported.get(tf.session_id) === loop.firstCallId) continue

      const session = await getSession(tf.session_id, 'claude')
      const title = session?.title || tf.session_id
      const key = session?.cwd || tf.session_id
      const error = `"${title}" ran ${loop.tool} ${loop.count} times in a row with the same input, failing each time. Last error: ${loop.error}`
      const result = await recordIncident({ scope: 'session-loop', key, error })
      await deliverIncidentNotification(result, { scope: 'session-loop', key, error })
      reported.set(tf.session_id, loop.firstCallId)
      recorded++
    } catch (err) {
      console.error('[agenthydra] loop detector:', err)
    }
  }
  return recorded
}

let timer: ReturnType<typeof setInterval> | null = null

export function startLoopDetector(): void {
  if (timer) return
  // scanForLoops already swallows per-file failures, but `void` on a promise discards a rejection
  // rather than handling it, and an unhandled one exits this process. A timer must not be able to
  // kill the daemon.
  timer = setInterval(() => {
    scanForLoops().catch((err) => console.error('[agenthydra] loop detector sweep error:', err))
  }, POLL_MS)
}

export function stopLoopDetector(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
