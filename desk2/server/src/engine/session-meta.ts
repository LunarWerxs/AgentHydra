// Hydra Desk's own marks on outside sessions (SPEC "Session meta"): pinned, archived, unread, a title
// and a sidebar group per session id, in <home>/session-meta.json, written atomically (temp file +
// rename). They live here because the sessions' own files belong to Claude Desktop or the CLI and are
// never written. The bridge applies them to every external list it answers.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExternalSession, SessionMeta, SessionMetaPatch } from '@shared/protocol'
import { AsyncFile } from '../async-file'

const UNMARKED: SessionMeta = { title: null, pinned: false, archived: false, unread: false, group: null }

const isUnmarked = (m: SessionMeta): boolean => (Object.keys(UNMARKED) as (keyof SessionMeta)[]).every((k) => m[k] === UNMARKED[k])

export class SessionMetaStore {
  readonly file: string
  readonly tombFile: string
  private readonly byId: Map<string, SessionMeta>
  private readonly tombs: Set<string>
  private readonly marksWriter: AsyncFile
  private readonly tombWriter: AsyncFile

  constructor(home: string) {
    this.file = join(home, 'session-meta.json')
    this.tombFile = join(home, 'session-tombstones.json')
    this.byId = new Map(Object.entries(this.load()))
    this.tombs = new Set(this.loadTombs())
    this.marksWriter = new AsyncFile(this.file)
    this.tombWriter = new AsyncFile(this.tombFile)
  }

  get(sessionId: string): SessionMeta | null {
    const m = this.byId.get(sessionId)
    return m ? { ...m } : null
  }

  /** The sessions of deleted chats: never listed as outside sessions again, not even after a restart. */
  tombstoned(): string[] {
    return [...this.tombs]
  }

  tombstone(sessionIds: string[]): void {
    const fresh = sessionIds.filter((id) => !this.tombs.has(id))
    if (!fresh.length) return
    for (const id of fresh) this.tombs.add(id)
    this.tombWriter.write(JSON.stringify([...this.tombs], null, 2))
  }

  /** Server shutdown: what is not on disk yet is written now. */
  flushSync(): void {
    this.marksWriter.flushSync()
    this.tombWriter.flushSync()
  }

  /** The session ids marked pinned (the bridge keeps them listed however old). */
  pinnedIds(): string[] {
    return [...this.byId].filter(([, m]) => m.pinned).map(([id]) => id)
  }

  /** Applies the patch and writes the file now; a session left with no marks is dropped from it. */
  patch(sessionId: string, p: SessionMetaPatch): SessionMeta {
    const next: SessionMeta = { ...UNMARKED, ...this.byId.get(sessionId) }
    for (const k of Object.keys(UNMARKED) as (keyof SessionMeta)[]) if (p[k] !== undefined) Object.assign(next, { [k]: p[k] })
    if (isUnmarked(next)) this.byId.delete(sessionId)
    else this.byId.set(sessionId, next)
    this.save()
    return { ...next }
  }

  /** The list with each session's marks on it (its title replaced when renamed here). */
  apply(list: ExternalSession[]): ExternalSession[] {
    return list.map((s) => {
      const m = this.byId.get(s.id)
      if (!m) return s
      return { ...s, title: m.title ?? s.title, pinned: m.pinned, archived: m.archived, unread: m.unread, group: m.group }
    })
  }

  /** A missing or unreadable file is no marks; malformed entries are skipped. */
  private load(): Record<string, SessionMeta> {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, SessionMeta> = {}
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const m = v as Partial<SessionMeta>
      out[id] = {
        title: typeof m.title === 'string' ? m.title : null,
        pinned: m.pinned === true,
        archived: m.archived === true,
        unread: m.unread === true,
        group: typeof m.group === 'string' ? m.group : null,
      }
    }
    return out
  }

  private loadTombs(): string[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.tombFile, 'utf8'))
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  private save(): void {
    this.marksWriter.write(JSON.stringify(Object.fromEntries(this.byId), null, 2))
  }
}
