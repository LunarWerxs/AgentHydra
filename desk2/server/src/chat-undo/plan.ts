// "Undo this chat's changes": what a chat's own transcript proves about the files it changed with Edit, Write and
// MultiEdit, and putting those files back.
//
// Why the transcript and not the SDK's rewindFiles: Desk starts its queries without enableFileCheckpointing, so a chat
// has no SDK checkpoints (and rewindFiles needs the live query), and a rewind answers a file list with one total
// +/- and no way to tell that someone else changed a file since. The transcript is exact instead: every successful
// Edit/Write result carries `originalFile`, the file's content just before that tool ran, so the first one is how the
// file was before the chat touched it, and replaying the chat's edits from it gives the content the chat last left.
//
// A file is `ready` only when its content on disk is exactly what that replay gives. Anything else (someone edited it
// since, an edit that does not replay, a NotebookEdit, a file with no stored original, a path outside the chat's
// folder) is shown and refused, never written. Files changed through a shell command are not in the transcript's tool
// inputs, so they are not this feature's: a file is only ever touched when the chat's own Edit/Write changed it.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ChatUndoFile, ChatUndoPlan, ChatUndoResult } from '@shared/connectors'

interface Op {
  tool: string
  input: Record<string, unknown>
  /** The tool's toolUseResult (originalFile and, for Write, type). */
  result: Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The chat's successful file-changing tool calls per absolute path, in the order they ran. */
export function opsByFile(jsonl: string): Map<string, Op[]> {
  const calls = new Map<string, { tool: string; input: Record<string, unknown> }>()
  const out = new Map<string, Op[]>()
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(rec) || !isRecord(rec.message) || !Array.isArray(rec.message.content)) continue
    for (const block of rec.message.content) {
      if (!isRecord(block)) continue
      if (rec.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && TOOLS.has(block.name) && isRecord(block.input)) {
        calls.set(block.id, { tool: block.name, input: block.input })
      } else if (rec.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = calls.get(block.tool_use_id)
        if (!call || block.is_error === true) continue
        const file = call.input.file_path ?? call.input.notebook_path
        if (typeof file !== 'string' || !isAbsolute(file)) continue
        const key = resolve(file)
        const list = out.get(key) ?? []
        list.push({ tool: call.tool, input: call.input, result: isRecord(rec.toolUseResult) ? rec.toolUseResult : {} })
        out.set(key, list)
      }
    }
  }
  return out
}

const eol = (s: string): string => s.replace(/\r\n/g, '\n')

function replaceIn(text: string, old: string, next: string, all: boolean): string | null {
  if (old === '' || !text.includes(old)) return null
  return all ? text.split(old).join(next) : text.replace(old, () => next)
}

/** `text` after one Edit/Write/MultiEdit, or null when the call does not replay on it (the file was not as the chat saw it). */
function replay(text: string | null, op: Op): string | null {
  const seen = typeof op.result.originalFile === 'string' ? op.result.originalFile : null
  if (op.tool === 'Write') {
    const created = op.result.type === 'create'
    if (created ? text !== null : seen === null || text === null || eol(seen) !== eol(text)) return null
    return typeof op.input.content === 'string' ? op.input.content : null
  }
  if (text === null || (seen !== null && eol(seen) !== eol(text))) return null
  const edits = op.tool === 'MultiEdit' && Array.isArray(op.input.edits) ? op.input.edits : [op.input]
  // The tool matched against the file as read; a CRLF file is replayed on its LF form and put back after.
  const crlf = text.includes('\r\n')
  let cur = eol(text)
  for (const e of edits) {
    if (!isRecord(e) || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null
    const next = replaceIn(cur, eol(e.old_string), eol(e.new_string), e.replace_all === true)
    if (next === null) return null
    cur = next
  }
  return crlf ? cur.replace(/\n/g, '\r\n') : cur
}

/** The lines of a text (a final newline ends the last line, it does not start another). */
const lines = (t: string): string[] => (t === '' ? [] : eol(t).replace(/\n$/, '').split('\n'))

/** The line counts a change from `a` to `b` adds and removes (common head and tail dropped, then a longest-common-subsequence). */
export function lineChange(a: string, b: string): { added: number; removed: number } {
  const x = lines(a)
  const y = lines(b)
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head++
  let tail = 0
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  const p = x.slice(head, x.length - tail)
  const q = y.slice(head, y.length - tail)
  if (p.length * q.length > 4_000_000) return { added: q.length, removed: p.length }
  let prev = new Uint32Array(q.length + 1)
  for (const line of p) {
    const row = new Uint32Array(q.length + 1)
    for (let j = 1; j <= q.length; j++) row[j] = line === q[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!)
    prev = row
  }
  const common = prev[q.length]!
  return { added: q.length - common, removed: p.length - common }
}

/** The file's text, null when it is not there; undefined when it is not text (it has a NUL) or cannot be read. */
function readDisk(path: string): string | null | undefined {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8')
    return text.includes('\0') ? undefined : text
  } catch {
    return undefined
  }
}

interface Entry {
  file: ChatUndoFile
  abs: string
  /** What to write back; null deletes the file. */
  before: string | null
}

function entries(jsonl: string, cwd: string): Entry[] {
  const root = resolve(cwd)
  const list: Entry[] = []
  for (const [abs, ops] of opsByFile(jsonl)) {
    const rel = relative(root, abs)
    const path = rel.split(sep).join('/')
    const make = (state: ChatUndoFile['state'], reason: string | undefined, over: Partial<ChatUndoFile> = {}, before: string | null = null): Entry => ({
      abs,
      before,
      file: { path, added: 0, removed: 0, kind: 'restore', state, ...(reason ? { reason } : {}), ...over }
    })
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      list.push(make('unknown', "outside this chat's folder", { path: abs.split(sep).join('/') }))
      continue
    }
    if (ops.some((o) => o.tool === 'NotebookEdit')) {
      list.push(make('unknown', 'a notebook edit cannot be replayed'))
      continue
    }
    const first = ops[0]!
    const origin = first.tool === 'Write' && first.result.type === 'create' ? null : typeof first.result.originalFile === 'string' ? first.result.originalFile : undefined
    if (origin === undefined) {
      list.push(make('unknown', "the transcript did not keep the file's old content"))
      continue
    }
    let cur: string | null = origin
    let broken = false
    for (const op of ops) {
      const next = replay(cur, op)
      if (next === null) {
        broken = true
        break
      }
      cur = next
    }
    const disk = readDisk(abs)
    if (disk === undefined) {
      list.push(make('unknown', 'it cannot be read as text'))
      continue
    }
    const kind = origin === null ? 'delete' : 'restore'
    if (broken || disk === null || cur === null || eol(disk) !== eol(cur)) {
      // Gone already and created by the chat: nothing to undo. Otherwise someone else changed it since the chat last wrote it.
      if (kind === 'delete' && disk === null) continue
      list.push(make('changed', disk === null ? 'it was deleted after the chat wrote it' : 'it was changed after the chat last wrote it', { kind }, origin))
      continue
    }
    if (origin !== null && eol(origin) === eol(disk)) continue
    // Put back with the file's own line endings.
    const back = origin !== null && disk.includes('\r\n') && !/(^|[^\r])\n/.test(disk) ? eol(origin).replace(/\n/g, '\r\n') : origin
    const { added, removed } = lineChange(origin ?? '', disk)
    list.push(make('ready', undefined, { kind, added, removed }, back))
  }
  return list.sort((a, b) => a.file.path.localeCompare(b.file.path))
}

/** What undoing the chat's changes would do, per file; nothing is written. */
export function planUndo(transcript: string, cwd: string): ChatUndoPlan {
  return { files: entries(transcript, cwd).map((e) => e.file) }
}

/** Puts the requested `ready` files back (the plan is made again just now, so a file changed since the confirm is skipped). */
export function applyUndo(transcript: string, cwd: string, paths: readonly string[]): ChatUndoResult {
  const want = new Set(paths)
  const result: ChatUndoResult = { done: [], skipped: [] }
  const now = entries(transcript, cwd)
  for (const path of want) {
    const e = now.find((x) => x.file.path === path)
    if (!e) result.skipped.push({ path, reason: 'nothing to undo in it any more' })
    else if (e.file.state !== 'ready') result.skipped.push({ path, reason: e.file.reason ?? 'not safe to undo' })
    else {
      try {
        if (e.before === null) unlinkSync(e.abs)
        else {
          mkdirSync(dirname(e.abs), { recursive: true })
          writeFileSync(e.abs, e.before, 'utf8')
        }
        result.done.push(path)
      } catch (err) {
        result.skipped.push({ path, reason: err instanceof Error ? err.message.slice(0, 120) : 'could not write it' })
      }
    }
  }
  return result
}
