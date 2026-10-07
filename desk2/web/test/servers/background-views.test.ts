import { beforeEach, describe, expect, it } from 'bun:test'
import { evictForCap, lookAtKept, MAX_KEPT, SILENCE_MS, shouldKeep, type KeptView } from '../../src/components/servers/background-policy'
import { createBackgroundViews } from '../../src/components/servers/background-views'
import { type HostBrowserIn, HostView } from '../../src/components/servers/native-browser'
import { registerView, resetChatAudio, setMuted, viewAudio, viewPlaying } from '../../src/lib/chat-audio'

const kv = (key: string, keptAt: number, silentSince: number | null = null): KeptView => ({ key, chatId: 'c', viewId: key, url: key, keptAt, silentSince })

describe('shouldKeep', () => {
  it('keeps a view that plays; a silent one, or one whose tab was closed, is closed', () => {
    expect(shouldKeep(true, false)).toBe(true)
    expect(shouldKeep(false, false)).toBe(false)
    expect(shouldKeep(true, true)).toBe(false)
  })
})

describe('lookAtKept', () => {
  const live = () => true
  it('closes a view after 60 s of silence, not before, and a sound in between starts the count over', () => {
    let playing = false
    let r = lookAtKept([kv('a', 0)], () => playing, live, 1000)
    expect(r.close).toEqual([])
    expect(r.kept[0]!.silentSince).toBe(1000)
    r = lookAtKept(r.kept, () => playing, live, 1000 + SILENCE_MS - 1)
    expect(r.close).toEqual([])
    playing = true
    r = lookAtKept(r.kept, () => playing, live, 1000 + SILENCE_MS)
    expect(r.close).toEqual([])
    expect(r.kept[0]!.silentSince).toBeNull()
    playing = false
    r = lookAtKept(r.kept, () => playing, live, 70_000)
    r = lookAtKept(r.kept, () => playing, live, 70_000 + SILENCE_MS)
    expect(r.close).toEqual(['a'])
  })
  it('closes a view whose chat is gone even while it plays', () => {
    expect(lookAtKept([kv('a', 0)], () => true, () => false, 5).close).toEqual(['a'])
  })
})

describe('evictForCap', () => {
  it('does nothing at the cap', () => {
    expect(evictForCap(Array.from({ length: MAX_KEPT }, (_, i) => kv(`v${i}`, i)))).toEqual([])
  })
  it('over the cap the oldest silent one goes first, then the oldest', () => {
    const all = [kv('v0', 0), kv('v1', 1, 500), kv('v2', 2), kv('v3', 3, 400), kv('v4', 4), kv('v5', 5), kv('v6', 6)]
    expect(evictForCap(all)).toEqual(['v1'])
    expect(evictForCap([...all.filter((k) => k.key !== 'v1' && k.key !== 'v3'), kv('v7', 7), kv('v8', 8), kv('v9', 9)])).toEqual(['v0', 'v2'])
  })
})

describe('the registry', () => {
  let t = 0
  let sounding = new Set<string>()
  let alive = new Set<string>(['chat-a', 'chat-b'])
  const reg = () => createBackgroundViews({ playing: (v) => sounding.has(v), chatLive: (c) => alive.has(c), now: () => t })
  const open = (sent: HostBrowserIn[]) => {
    const v = new HostView(() => {}, (m) => sent.push(m), true)
    v.open('https://example.test/a', { left: 1, top: 1, right: 9, bottom: 9 })
    return v
  }
  beforeEach(() => {
    t = 0
    sounding = new Set()
    alive = new Set(['chat-a', 'chat-b'])
    resetChatAudio()
  })

  it('a sounding view is kept hidden on a switch, not closed; re-entry adopts the same view', () => {
    const sent: HostBrowserIn[] = []
    const r = reg()
    const v = open(sent)
    sounding.add(v.id)
    expect(r.leave('chat-a', 'https://example.test/a', v, null)).toBe(true)
    expect(sent.at(-1)).toEqual({ kind: 'browser', op: 'place', id: v.id, rect: null })
    expect(sent.some((m) => m.op === 'close')).toBe(false)
    expect(r.adopt('chat-b', 'https://example.test/a')).toBeNull()
    expect(r.adopt('chat-a', 'https://example.test/a')).toBe(v)
    expect(v.isOpen).toBe(true)
    expect(r.size()).toBe(0)
    r.dropChat('chat-a')
  })

  it('a silent view is not kept, and a tab closed on purpose is not kept even while it plays', () => {
    const r = reg()
    const quiet = open([])
    expect(r.leave('chat-a', 'https://example.test/a', quiet, null)).toBe(false)
    const loud = open([])
    sounding.add(loud.id)
    r.tabClosing('chat-a', 'https://example.test/a')
    expect(r.leave('chat-a', 'https://example.test/a', loud, null)).toBe(false)
    expect(r.size()).toBe(0)
  })

  it('closes a kept view 60 s after it falls silent, and one whose chat was archived', () => {
    const sent: HostBrowserIn[] = []
    const r = reg()
    const v = open(sent)
    sounding.add(v.id)
    r.leave('chat-a', 'https://example.test/a', v, null)
    sounding.delete(v.id)
    t = 1000
    r.look()
    t = 1000 + SILENCE_MS - 1
    r.look()
    expect(r.size()).toBe(1)
    t = 1000 + SILENCE_MS
    r.look()
    expect(r.size()).toBe(0)
    expect(sent.at(-1)).toEqual({ kind: 'browser', op: 'close', id: v.id })

    const w = open(sent)
    sounding.add(w.id)
    r.leave('chat-b', 'https://example.test/b', w, null)
    alive.delete('chat-b')
    r.look()
    expect(r.size()).toBe(0)
  })

  it('keeps at most 6: the seventh evicts the oldest silent view, else the oldest', () => {
    const sent: HostBrowserIn[] = []
    const r = reg()
    const views: HostView[] = []
    for (let i = 0; i < 7; i++) {
      t = i * 10
      const v = open(sent)
      views.push(v)
      sounding.add(v.id)
      if (i === 3) sounding.delete(views[2]!.id)
      if (i === 3) r.look() // views[2] notes its silence
      r.leave('chat-a', `https://example.test/${i}`, v, null)
    }
    expect(r.size()).toBe(6)
    expect(r.has('chat-a', 'https://example.test/2')).toBe(false)
    expect(sent.filter((m) => m.op === 'close').map((m) => m.id)).toEqual([views[2]!.id])
    for (let i = 0; i < 7; i++) sounding.add(views[i]!.id)
    t = 100
    const extra = open(sent)
    sounding.add(extra.id)
    r.leave('chat-a', 'https://example.test/x', extra, null)
    expect(r.has('chat-a', 'https://example.test/0')).toBe(false)
  })

  it('muting a background chat sends op:mute for its kept view, and its row still reads as playing', () => {
    const sent: HostBrowserIn[] = []
    const r = reg()
    const v = open(sent)
    const undo = registerView('chat-a', v.id, (m) => v.mute(m))
    viewAudio(v.id, true)
    sounding.add(v.id)
    r.leave('chat-a', 'https://example.test/a', v, undo)
    expect(viewPlaying(v.id)).toBe(true)
    setMuted('chat-a', true)
    expect(sent.at(-1)).toEqual({ kind: 'browser', op: 'mute', id: v.id, muted: true })
    setMuted('chat-a', false)
    expect(sent.at(-1)).toEqual({ kind: 'browser', op: 'mute', id: v.id, muted: false })
    r.dropChat('chat-a')
    expect(viewPlaying(v.id)).toBe(false)
  })
})
