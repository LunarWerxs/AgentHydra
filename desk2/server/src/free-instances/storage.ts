import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { FREE_PROVIDERS, FREE_SETTINGS_DEFAULTS, type FreeDeleted, type FreeInstance, type FreeProvider, type FreeSettings, type FreeThread } from '@shared/free-instances'
import { type TokenLedger, validLedger } from './tokens'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A name nobody had to type ("Claude", "ChatGPT 2") follows the account; a deliberate one stays. */
const generic = (name: string): boolean => /^(claude|chatgpt)\s*#?\d*$/i.test(name.trim())
/** `deleted`: local tombstones the sync still has to tell the store about; `settings`: the keepalive's (keepalive.ts);
 *  `tokens`: each account's token estimate by its id (tokens.ts), counts only. */
interface Data { instances: FreeInstance[]; threads: FreeThread[]; deleted?: FreeDeleted[]; settings?: FreeSettings; tokens?: Record<string, TokenLedger> }

/** Persistent account/chat metadata only. DPAPI files are copied without decrypting them. */
export class FreeStorage {
  data: Data = { instances: [], threads: [] }
  private file: string
  constructor(private home: string) {
    this.file = join(home, 'free', 'accounts.json')
    if (existsSync(this.file)) {
      // Fail closed on damaged metadata; never silently replace someone's stored account list.
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Data
      if (!Array.isArray(value.instances) || !Array.isArray(value.threads) || value.instances.some(i => !UUID.test(i.id) || !['claude', 'chatgpt'].includes(i.provider))) throw new Error('Invalid Free account metadata')
      this.data = value
      // Tolerate absent or damaged tombstones and settings: fall back to none and the defaults.
      const s = value.settings as Partial<FreeSettings> | undefined
      this.data.settings = s && typeof s.keepWindows === 'boolean' && Number.isInteger(s.weeklyFloorPct) && s.weeklyFloorPct! >= 1 && s.weeklyFloorPct! <= 100 ? { keepWindows: s.keepWindows, weeklyFloorPct: s.weeklyFloorPct! } : { ...FREE_SETTINGS_DEFAULTS }
      // A damaged estimate is dropped, never trusted: the account counts again from its next message.
      const tokens = value.tokens && typeof value.tokens === 'object' ? Object.entries(value.tokens) : []
      this.data.tokens = Object.fromEntries(tokens.flatMap(([id, l]) => { const ledger = UUID.test(id) && validLedger(l); return ledger ? [[id, ledger]] : [] }))
      this.data.deleted = Array.isArray(value.deleted) ? value.deleted.filter(d => d && typeof d.id === 'string' && UUID.test(d.id) && FREE_PROVIDERS.includes(d.provider) && Number.isInteger(d.num) && typeof d.name === 'string') : []
      // Older records lack lastSignedInAt: a signed-in account was last signed in when it was last checked.
      for (const i of this.data.instances) if (typeof i.lastSignedInAt !== 'number') i.lastSignedInAt = i.loggedIn ? i.checkedAt ?? null : null
      for (const i of this.data.instances) if (typeof i.autoName !== 'boolean') i.autoName = generic(i.name)
      for (const t of this.data.threads) if (t.status === 'running') { t.status = 'failed'; t.error = 'Desk restarted during the request. Read this chat before sending again.' }
    } else this.migrate()
  }
  create(provider: FreeProvider, name?: string): FreeInstance {
    const instance: FreeInstance = { id: randomUUID(), num: Math.max(0, ...this.data.instances.map(i => i.num)) + 1, provider, name: name ?? (provider === 'claude' ? 'Claude' : 'ChatGPT'), autoName: name === undefined, loggedIn: false, checkedAt: null, lastSignedInAt: null, lastActiveAt: null, usage: null }
    mkdirSync(join(this.home, 'free', 'instances', instance.id), { recursive: true })
    this.data.instances.push(instance)
    this.save()
    return instance
  }
  /** An account another PC shares (free-instances/sync.ts): its id and name, and its number unless one here has it. */
  adopt(shared: Pick<FreeInstance, 'id' | 'num' | 'provider' | 'name'>): FreeInstance {
    const taken = this.data.instances.some(i => i.num === shared.num)
    const num = taken ? Math.max(0, ...this.data.instances.map(i => i.num)) + 1 : shared.num
    const instance: FreeInstance = { ...shared, num, autoName: generic(shared.name), loggedIn: false, checkedAt: null, lastSignedInAt: null, lastActiveAt: null, usage: null }
    mkdirSync(join(this.home, 'free', 'instances', instance.id), { recursive: true })
    this.data.instances.push(instance)
    this.save()
    return instance
  }
  /** Drops an account and its chats and state folder; a tombstone stays until the sync has told the store. */
  remove(id: string, tombstone: boolean): void {
    const instance = this.data.instances.find(i => i.id === id)
    this.data.instances = this.data.instances.filter(i => i.id !== id)
    this.data.threads = this.data.threads.filter(t => t.instanceId !== id)
    if (this.data.tokens) delete this.data.tokens[id]
    if (tombstone && instance) this.data.deleted = [...(this.data.deleted ?? []).filter(d => d.id !== id), { id, num: instance.num, provider: instance.provider, name: instance.name }]
    rmSync(join(this.home, 'free', 'instances', id), { recursive: true, force: true })
    this.save()
  }
  /** The store knows of a deletion: the tombstone is done. */
  settle(id: string): void {
    this.data.deleted = (this.data.deleted ?? []).filter(d => d.id !== id)
    this.save()
  }
  save(): void {
    mkdirSync(join(this.home, 'free'), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
  }
  private migrate(): void {
    let legacy: { harnessDir?: unknown }
    try { legacy = JSON.parse(readFileSync(join(this.home, 'free-instances.json'), 'utf8')) } catch { return }
    if (typeof legacy.harnessDir !== 'string' || !isAbsolute(legacy.harnessDir)) return
    const source = join(legacy.harnessDir, '.state')
    for (const provider of ['claude', 'chatgpt'] as const) {
      const from = provider === 'chatgpt' ? join(source, 'chatgpt') : source
      if (!existsSync(join(from, 'session.dpapi'))) continue
      const instance = this.create(provider)
      const state = join(this.home, 'free', 'instances', instance.id)
      const to = provider === 'chatgpt' ? join(state, 'chatgpt') : state
      mkdirSync(to, { recursive: true })
      for (const file of ['session.dpapi', 'chats.sqlite3', 'usage-cache.json', 'http-config.json', 'browser-runtime.json']) {
        if (existsSync(join(from, file))) copyFileSync(join(from, file), join(to, file))
      }
    }
    // A marker prevents a removed/imported account from reappearing on every restart.
    this.save()
  }
}
