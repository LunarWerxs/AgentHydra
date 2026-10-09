// Runs the headless audio rules (headless-audio.ts) each time the Windows audio helper reports: which profiles make
// sound, which of their pages, and which chat owns each. Mute silences one chat's pages over CDP, and falls back to the
// helper's session mute only when the profile's sound is all that chat's. The helper, page access and chat lookup are
// injected; headless-audio-host.ts has the real ones.

import type { BrowserTab } from '@shared/browser'
import type { HeadlessAudioState } from '@shared/headless-audio'
import {
  MuteBook,
  pageIsAudible,
  pageOwners,
  profileHoldsChats,
  profilesOf,
  type AudioRow,
  type PageSound,
  type ProcRow,
  type ProfileSound,
} from './headless-audio'

export interface HelperPort {
  onLine(fn: (line: string) => void): void
  send(line: string): void
  exited: Promise<number>
  kill(): void
}

export interface PageAccess {
  tabs(port: number): Promise<BrowserTab[]>
  sound(port: number, pageId: string): Promise<PageSound>
  mute(port: number, pageId: string, on: boolean): Promise<void>
}

export interface HeadlessAudioDeps {
  platform: string
  compile(): Promise<string | null>
  spawn(exe: string): HelperPort
  page: PageAccess
  readPort(dir: string): number | null
  chatOf(): Promise<(sessionId: string) => string | null>
  broadcast(state: HeadlessAudioState): void
  now?(): number
}

const UNATTRIBUTED = '*unattributed'
const RESTART_MIN_MS = 1000
const RESTART_MAX_MS = 30000
const HEALTHY_MS = 60000
const QUIT_GRACE_MS = 2000

export function restartDelay(attempt: number): number {
  return Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** attempt)
}

/** A session's chat: its own, else the chat that dispatched it when it is a CliMayte worker's session. */
export function chatResolver(
  direct: (sessionId: string) => string | null,
  workerOrigin: ReadonlyMap<string, string>,
): (sessionId: string) => string | null {
  return (sessionId) => {
    const own = direct(sessionId)
    if (own) return own
    const origin = workerOrigin.get(sessionId)
    return origin === undefined ? null : direct(origin)
  }
}

export class HeadlessAudio {
  private helper: HelperPort | null = null
  private rows: AudioRow[] = []
  private procs: ProcRow[] = []
  private profiles: ProfileSound[] = []
  private audibleOf = new Map<string, (string | null)[]>()
  private audible: string[] = []
  private unattributed: { profile: string; url: string }[] = []
  private unattributedMuted = false
  private readonly muting = new Set<string>()
  private readonly book = new MuteBook()
  private readonly pageDir = new Map<string, string>()
  private lane: Promise<unknown> = Promise.resolve()
  private readonly now: () => number
  private last = ''
  private running = false
  private again = false
  private stopped = false
  private attempt = 0

  constructor(private readonly deps: HeadlessAudioDeps) {
    this.now = deps.now ?? Date.now
  }

  state(): HeadlessAudioState {
    return { audible: this.audible, muted: [...this.muting].sort(), unattributed: this.unattributed, unattributedMuted: this.unattributedMuted }
  }

  start(): void {
    if (this.deps.platform !== 'win32') return
    void this.supervise()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lane.then(fn)
    this.lane = run.catch(() => undefined)
    return run
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.serial(async () => {
      for (const chat of [...this.muting]) {
        this.muting.delete(chat)
        await this.unmuteChat(chat)
      }
      await this.unmuteChat(UNATTRIBUTED)
    })
    this.helper?.send('{"op":"quit"}')
    const killer = setTimeout(() => this.helper?.kill(), QUIT_GRACE_MS)
    killer.unref?.()
  }

  setMuted(chat: string, on: boolean): Promise<HeadlessAudioState> {
    return this.serial(async () => {
      if (on) {
        this.muting.add(chat)
        await this.muteChat(chat)
      } else {
        this.muting.delete(chat)
        await this.unmuteChat(chat)
      }
      this.publish()
      return this.state()
    })
  }

  setUnattributed(on: boolean): Promise<HeadlessAudioState> {
    return this.serial(async () => {
      this.unattributedMuted = on
      if (on) await this.scan().catch(() => undefined)
      else await this.unmuteChat(UNATTRIBUTED)
      this.publish()
      return this.state()
    })
  }

  private async supervise(): Promise<void> {
    const exe = await this.deps.compile()
    if (exe === null) return
    while (!this.stopped) {
      const started = this.now()
      const port = this.deps.spawn(exe)
      this.helper = port
      port.onLine((line) => this.onLine(line))
      await port.exited.catch(() => 1)
      this.helper = null
      this.rows = []
      this.procs = []
      if (this.stopped) return
      this.audible = []
      this.unattributed = []
      this.publish()
      if (this.now() - started >= HEALTHY_MS) this.attempt = 0
      await new Promise<void>((resolve) => setTimeout(resolve, restartDelay(this.attempt++)))
    }
  }

  private onLine(raw: string): void {
    let msg: { s?: unknown; p?: unknown }
    try {
      msg = JSON.parse(raw) as { s?: unknown; p?: unknown }
    } catch {
      return
    }
    if (!Array.isArray(msg.s)) return
    this.rows = (msg.s as unknown[][]).map((r) => ({ pid: Number(r[0]), peak: Number(r[1]), muted: r[2] === true }))
    if (Array.isArray(msg.p)) this.procs = (msg.p as unknown[][]).map((r) => ({ pid: Number(r[0]), ppid: Number(r[1]), cmd: String(r[2] ?? '') }))
    void this.tick()
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      do {
        this.again = false
        await this.serial(() => this.scan())
      } while (this.again && !this.stopped)
    } catch {
      // a failed scan waits for the helper's next line
    } finally {
      this.running = false
    }
  }

  private async scan(): Promise<void> {
    const chatOf = await this.deps.chatOf()
    const profiles = profilesOf(this.rows, this.procs)
    this.profiles = profiles
    const muted = new Set(this.muting)
    const audible = new Set<string>()
    const unattributed: { profile: string; url: string }[] = []
    const audibleOf = new Map<string, (string | null)[]>()
    for (const prof of profiles) {
      if (prof.peak <= 0 && !profileHoldsChats(prof.dir, muted, chatOf)) continue
      const port = this.deps.readPort(prof.dir)
      if (port === null) continue
      let tabs: BrowserTab[]
      try {
        tabs = await this.deps.page.tabs(port)
      } catch {
        continue
      }
      const owners = pageOwners(
        tabs.map((t) => t.id),
        prof.dir,
        chatOf,
      )
      const found: (string | null)[] = []
      for (const tab of tabs) {
        const chat = owners.get(tab.id) ?? null
        if (prof.peak <= 0 && (chat === null || !muted.has(chat))) continue
        const sound = await this.sound(port, tab.id)
        if (sound === null || !pageIsAudible(sound)) continue
        found.push(chat)
        if (chat === null) {
          unattributed.push({ profile: prof.dir, url: tab.url })
          if (this.unattributedMuted) await this.muteOne(prof.dir, port, tab.id, UNATTRIBUTED)
        } else {
          audible.add(chat)
          if (muted.has(chat)) await this.muteOne(prof.dir, port, tab.id, chat)
        }
      }
      audibleOf.set(prof.dir, found)
    }
    this.audibleOf = audibleOf
    this.audible = [...audible].sort()
    this.unattributed = unattributed
    this.publish()
  }

  private async sound(port: number, id: string): Promise<PageSound | null> {
    try {
      return await this.deps.page.sound(port, id)
    } catch {
      return null
    }
  }

  private async muteOne(dir: string, port: number, id: string, chat: string): Promise<boolean> {
    try {
      await this.deps.page.mute(port, id, true)
    } catch {
      return false
    }
    const thing = `page:${id}`
    if (this.book.hold(chat, thing)) this.pageDir.set(thing, dir)
    return true
  }

  private async muteChat(chat: string): Promise<void> {
    const chatOf = await this.deps.chatOf()
    for (const prof of this.profiles) {
      if (!profileHoldsChats(prof.dir, new Set([chat]), chatOf)) continue
      const port = this.deps.readPort(prof.dir)
      if (port === null) continue
      let tabs: BrowserTab[]
      try {
        tabs = await this.deps.page.tabs(port)
      } catch {
        continue
      }
      const owners = pageOwners(
        tabs.map((t) => t.id),
        prof.dir,
        chatOf,
      )
      let failed = 0
      for (const tab of tabs) {
        if (owners.get(tab.id) !== chat) continue
        if (!(await this.muteOne(prof.dir, port, tab.id, chat))) failed++
      }
      const sound = this.audibleOf.get(prof.dir) ?? []
      if (failed > 0 && sound.length > 0 && sound.every((c) => c === chat)) {
        for (const pid of prof.sessionPids) {
          if (this.book.hold(chat, `session:${pid}`)) this.helper?.send(JSON.stringify({ op: 'mute', pid, on: true }))
        }
      }
    }
  }

  private async unmuteChat(chat: string): Promise<void> {
    for (const thing of this.book.release(chat)) {
      if (thing.startsWith('page:')) {
        const id = thing.slice('page:'.length)
        const dir = this.pageDir.get(thing)
        this.pageDir.delete(thing)
        const port = dir === undefined ? null : this.deps.readPort(dir)
        if (port !== null) await this.deps.page.mute(port, id, false).catch(() => undefined)
      } else {
        const pid = Number(thing.slice('session:'.length))
        this.helper?.send(JSON.stringify({ op: 'mute', pid, on: false }))
      }
    }
  }

  private publish(): void {
    const state = this.state()
    const next = JSON.stringify(state)
    if (next === this.last) return
    this.last = next
    this.deps.broadcast(state)
  }
}
