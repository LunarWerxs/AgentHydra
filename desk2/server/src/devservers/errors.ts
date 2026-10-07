// The errors panel's store: what a server printed to stderr (or in an error-looking stdout chunk) or how it crashed,
// de-duplicated by a normalised fingerprint with a count and first / last seen, kept across restarts in
// <home>/devservers/errors.ndjson (bounded). Ported from DevWebUI's errors.ts; a dismissed or cleared entry is gone.

import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { DevWebErrorEntry, DevWebErrorSource, DevWebSourceFrame } from '@shared/devwebui'
import { stripAnsi } from './ansi'
import { writeFileAtomic } from './project-file'
import { findSourceFrames } from './source-frames'

const MAX_ERRORS = 500
const SAMPLE_CHARS = 4000
const SAVE_DEBOUNCE_MS = 1000
const MAX_FRAMES = 12

/** The server an error belongs to. `cwd` is what a relative frame path resolves against. */
export interface ErrorInfo {
  processId: string
  localId: string
  processName: string
  projectId: string
  projectName: string
  cwd: string
}

// stdout only counts as an error when it looks like one.
const ERROR_PATTERN = /\b(error|exception|unhandled|fatal|ERR_[A-Z]+|E[A-Z]{3,}|failed|cannot find|is not defined|traceback|panic)\b/i

// Dev-only / HMR noise that is not a real bug.
const IGNORE = [/\[vite\] (?:failed to connect to websocket|connecting\.\.\.|connected\.)/i, /does not provide an export named/i, /\bExperimentalWarning\b/i]

function normalize(text: string): string {
  return text
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '<ts>')
    .replace(/\b\d{1,2}:\d\d:\d\d(?:\s?[AP]M)?\b/gi, '<time>')
    .replace(/\?t=\d+/g, '?t=<ts>')
    .replace(/:\d+:\d+/g, ':<pos>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .trim()
    .slice(0, 400)
}

function framesOf(text: string, cwd: string): DevWebSourceFrame[] {
  const out: DevWebSourceFrame[] = []
  for (const f of findSourceFrames(text)) {
    const file = path.isAbsolute(f.file) || path.win32.isAbsolute(f.file) ? f.file : path.resolve(cwd, f.file)
    if (out.some((o) => o.file === file && o.line === f.line && o.column === f.column)) continue
    out.push({ file, line: f.line, ...(f.column ? { column: f.column } : {}) })
    if (out.length >= MAX_FRAMES) break
  }
  return out
}

export class ErrorStore {
  private map = new Map<string, DevWebErrorEntry>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as DevWebErrorEntry
          if (e.fingerprint && e.processId) this.map.set(e.fingerprint, e)
        } catch {
          // a bad line is skipped
        }
      }
    } catch {
      // no file yet
    }
  }

  /** Records (or bumps) an error and answers its fingerprint, or null when it was filtered out. */
  record(info: ErrorInfo, source: DevWebErrorSource, rawText: string): string | null {
    const text = stripAnsi(rawText).trim()
    if (!text || IGNORE.some((re) => re.test(text))) return null
    if (source === 'stdout' && !ERROR_PATTERN.test(text)) return null
    const normalized = normalize(text)
    if (!normalized) return null
    const fingerprint = `${info.processId}|${source}|${normalized}`
    const at = this.now()
    const existing = this.map.get(fingerprint)
    if (existing) {
      existing.count += 1
      existing.lastSeen = at
      existing.sample = text.slice(0, SAMPLE_CHARS)
    } else {
      this.map.set(fingerprint, {
        fingerprint,
        processId: info.processId,
        localId: info.localId,
        processName: info.processName,
        projectId: info.projectId,
        projectName: info.projectName,
        source,
        sample: text.slice(0, SAMPLE_CHARS),
        frames: framesOf(text, info.cwd),
        count: 1,
        firstSeen: at,
        lastSeen: at,
      })
      if (this.map.size > MAX_ERRORS) {
        const oldest = [...this.map.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]
        if (oldest) this.map.delete(oldest.fingerprint)
      }
    }
    this.scheduleSave()
    return fingerprint
  }

  /** Newest first. */
  list(processId?: string): DevWebErrorEntry[] {
    return [...this.map.values()].filter((e) => !processId || e.processId === processId).sort((a, b) => b.lastSeen - a.lastSeen)
  }

  count(processId: string): number {
    let n = 0
    for (const e of this.map.values()) if (e.processId === processId) n++
    return n
  }

  dismiss(fingerprint: string): boolean {
    const had = this.map.delete(fingerprint)
    if (had) this.scheduleSave()
    return had
  }

  clear(processId?: string): void {
    for (const [k, v] of this.map) if (!processId || v.processId === processId) this.map.delete(k)
    this.scheduleSave()
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /** Writes what changed now (the debounce timer, and the service's stop). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileAtomic(this.file, `${this.list().map((e) => JSON.stringify(e)).join('\n')}\n`)
    } catch {
      // losing an error record is not worth failing a server over
    }
  }
}
