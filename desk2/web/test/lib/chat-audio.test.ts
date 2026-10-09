import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { applyHeadlessAudio, loadHeadlessAudio, setUnattributedMuted, unattributedSound, clearVideos, isAudible, isMuted, registerView, resetChatAudio, setMuted, speakerFor, toggleMuted, videoChanged, viewAudio, type VideoLike } from '../../src/lib/chat-audio'
import { HostView, type HostBrowserIn } from '../../src/components/servers/native-browser'
import { chatRow, rowMenu, type RowMenuItem } from '../../src/components/sidebar/logic'

const video = (over: Partial<VideoLike> = {}): VideoLike => ({ muted: false, paused: false, ended: false, volume: 1, isConnected: true, ...over })

beforeEach(() => resetChatAudio())

describe('a chat is audible from its videos', () => {
  it('only while one plays unmuted with volume', () => {
    const v = video({ muted: true })
    videoChanged('a', v)
    expect(isAudible('a')).toBe(false) // autoplay is muted
    v.muted = false
    videoChanged('a', v)
    expect(isAudible('a')).toBe(true)
    expect(isAudible('b')).toBe(false)
    v.volume = 0
    videoChanged('a', v)
    expect(isAudible('a')).toBe(false)
    v.volume = 1
    v.paused = true
    videoChanged('a', v)
    expect(isAudible('a')).toBe(false)
  })
  it('a video scrolled out of the document, or its transcript gone, stops counting', () => {
    const v = video()
    videoChanged('a', v)
    expect(isAudible('a')).toBe(true)
    v.isConnected = false
    videoChanged('a', video({ paused: true }))
    expect(isAudible('a')).toBe(false)
    videoChanged('a', video())
    clearVideos('a')
    expect(isAudible('a')).toBe(false)
  })
})

describe('a chat is audible from its page views', () => {
  it('a view id maps to the chat it was registered for', () => {
    registerView('a', 'page-1', () => {})
    registerView('b', 'page-2', () => {})
    viewAudio('page-1', true)
    expect(isAudible('a')).toBe(true)
    expect(isAudible('b')).toBe(false)
    viewAudio('page-1', false)
    expect(isAudible('a')).toBe(false)
  })
  it('an event for a view nobody registered, or one already closed, counts for nothing', () => {
    viewAudio('page-9', true)
    const off = registerView('a', 'page-1', () => {})
    viewAudio('page-1', true)
    off()
    expect(isAudible('a')).toBe(false)
  })
})

describe('muting a chat', () => {
  it('mutes its videos and its views, and only its own', () => {
    const mine = video()
    const other = video()
    const sent: boolean[] = []
    const otherSent: boolean[] = []
    videoChanged('a', mine)
    videoChanged('b', other)
    registerView('a', 'page-1', (m) => sent.push(m))
    registerView('b', 'page-2', (m) => otherSent.push(m))
    setMuted('a', true)
    expect(mine.muted).toBe(true)
    expect(other.muted).toBe(false)
    expect(sent).toEqual([true])
    expect(otherSent).toEqual([])
    expect(isAudible('a')).toBe(false)
    expect(isMuted('a')).toBe(true)
  })
  it('a view opened later in a muted chat is muted on registering', () => {
    setMuted('a', true)
    const sent: boolean[] = []
    registerView('a', 'page-1', (m) => sent.push(m))
    expect(sent).toEqual([true])
    const fresh: boolean[] = []
    registerView('b', 'page-2', (m) => fresh.push(m))
    expect(fresh).toEqual([])
  })
  it('unmuting gives the videos it muted their sound back, and leaves one that was muted already', () => {
    const loud = video()
    const quiet = video({ muted: true })
    videoChanged('a', loud)
    videoChanged('a', quiet)
    toggleMuted('a')
    toggleMuted('a')
    expect(loud.muted).toBe(false)
    expect(quiet.muted).toBe(true)
    expect(isMuted('a')).toBe(false)
  })
  it('a person unmuting a video of a muted chat unmutes the chat, and its other videos', () => {
    const one = video()
    const two = video()
    videoChanged('a', one)
    videoChanged('a', two)
    setMuted('a', true)
    one.muted = false // the video's own sound control
    videoChanged('a', one)
    expect(isMuted('a')).toBe(false)
    expect(two.muted).toBe(false)
    expect(isAudible('a')).toBe(true)
  })
  it('the store forcing a video muted does not read as the person unmuting it', () => {
    const v = video()
    videoChanged('a', v)
    setMuted('a', true)
    videoChanged('a', v) // its volumechange event
    expect(isMuted('a')).toBe(true)
  })
})

describe('the host side of a page view', () => {
  const ipc = (audio: boolean) => {
    const sent: HostBrowserIn[] = []
    return { sent, view: new HostView(() => {}, (m) => sent.push(m), audio) }
  }
  it('sends the mute once it is open, and muted as it opens when asked before', () => {
    const { sent, view } = ipc(true)
    view.mute(true)
    expect(sent).toEqual([])
    view.open('https://example.com/', null)
    expect(sent.map((m) => (m.op === 'mute' ? `mute ${m.muted}` : m.op))).toEqual(['open', 'mute true'])
    view.mute(false)
    expect(sent.at(-1)).toEqual({ kind: 'browser', op: 'mute', id: view.id, muted: false })
  })
  it('an older host without audio is sent no mute', () => {
    const { sent, view } = ipc(false)
    view.open('https://example.com/', null)
    view.mute(true)
    expect(sent.map((m) => m.op)).toEqual(['open'])
  })
})

describe('the row', () => {
  const chat = { status: 'idle', pinned: false, archived: false, unread: false, group: null, cwd: 'C:/Users/me/proj', sessionId: 's1', account: { id: '1', label: '#1', configDir: null, number: 1 } } as never
  const labels = (muted: boolean | undefined) =>
    rowMenu({ ...chatRow(chat), muted }, [])
      .filter((e): e is RowMenuItem => typeof e === 'object' && 'action' in e)
      .map((e) => e.label)
  it('the menu says Mute chat, then Unmute chat once muted, and has neither for a row that cannot mute', () => {
    expect(labels(false)).toContain('Mute chat')
    expect(labels(false)).not.toContain('Unmute chat')
    expect(labels(true)).toContain('Unmute chat')
    expect(labels(true)).not.toContain('Mute chat')
    expect(labels(undefined).some((l) => /mute/i.test(l))).toBe(false)
  })
  it('the speaker appears while the chat is audible or muted, and says what a click does', () => {
    expect(speakerFor('a')).toBeNull()
    videoChanged('a', video())
    expect(speakerFor('a')).toEqual({ muted: false, label: 'Mute this chat' })
    toggleMuted('a')
    expect(speakerFor('a')).toEqual({ muted: true, label: 'Unmute this chat' })
    expect(speakerFor('b')).toBeNull()
  })
})

describe('headless audio from the Desk', () => {
  const realFetch = globalThis.fetch
  const posts: { url: string; body: unknown }[] = []
  let reply: unknown = {}
  beforeEach(() => {
    posts.length = 0
    reply = { audible: [], muted: [], unattributed: [], unattributedMuted: false }
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('the one fetch on load makes a chat audible, and each event replaces that', async () => {
    reply = { audible: ['h1'], muted: [], unattributed: [], unattributedMuted: false }
    await loadHeadlessAudio()
    expect(isAudible('h1')).toBe(true)
    expect(isAudible('h2')).toBe(false)
    expect(speakerFor('h1')).toEqual({ muted: false, label: 'Mute this chat' })
    applyHeadlessAudio({ audible: [], muted: [], unattributed: [], unattributedMuted: false })
    expect(isAudible('h1')).toBe(false)
  })

  it('the server muted list is the truth after a reload, and muting posts the chat', () => {
    applyHeadlessAudio({ audible: [], muted: ['h2'], unattributed: [], unattributedMuted: false })
    expect(isMuted('h2')).toBe(true)
    expect(speakerFor('h2')).toEqual({ muted: true, label: 'Unmute this chat' })
    setMuted('h2', false)
    expect(posts).toEqual([{ url: '/api/browser/audio/mute', body: { chat: 'h2', muted: false } }])
    setMuted('h3', true)
    expect(posts.at(-1)).toEqual({ url: '/api/browser/audio/mute', body: { chat: 'h3', muted: true } })
  })

  it('unattributed pages are listed, and their mute posts unattributed', () => {
    const page = { profile: 'C:/profiles/one', url: 'https://example.test/x' }
    applyHeadlessAudio({ audible: [], muted: [], unattributed: [page], unattributedMuted: false })
    expect(unattributedSound()).toEqual([page])
    setUnattributedMuted(true)
    expect(posts).toEqual([{ url: '/api/browser/audio/mute', body: { unattributed: true, muted: true } }])
  })
})
