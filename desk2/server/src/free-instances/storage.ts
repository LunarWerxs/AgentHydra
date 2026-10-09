import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { FREE_PROVIDERS, FREE_SETTINGS_DEFAULTS, type FreeDeleted, type FreeInstance, type FreeProvider, type FreeSettings, type FreeThread } from '@shared/free-instances'
import { seedStats, type StatsData, validStats } from './stats'
import { type TokenLedger, validLedger } from './tokens'
import { writeFlushed } from '../write-flushed'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A name nobody had to type ("Claude", "ChatGPT 2") follows the account; a deliberate one stays. */
const generic = (name: string): boolean => /^(claude|chatgpt)\s*#?\d*$/i.test(name.trim())
/** `deleted`: local tombstones the sync still has to tell the store about; `settings`: the keepalive's (keepalive.ts);
 *  `tokens`: each account's token estimate by its id (tokens.ts), counts only; `forgotten`: the ids of threads someone
 *  forgot, so a later read of the account's private chats does not list them again; `stats`: each day's messages by
 *  account and model (stats.ts), counts only. */
interface Data { instances: FreeInstance[]; threads: FreeThread[]; deleted?: FreeDeleted[]; settings?: FreeSettings; tokens?: Record<string, TokenLedger>; forgotten?: string[]; stats?: StatsData }

/** Tolerate absent or damaged settings: fall back to the defaults. */
function validSettings(s: Partial<FreeSettings> | undefined): FreeSettings {
  const floor = s?.weeklyFloorPct
  return s && typeof s.keepWindows === 'boolean' && Number.isInteger(floor) && floor! >= 1 && floor! <= 100 ? { keepWindows: s.keepWindows, weeklyFloorPct: floor! } : { ...FREE_SETTINGS_DEFAULTS }
}

/** A damaged estimate is dropped, never trusted: the account counts again from its next message. */
function validTokens(value: Data['tokens']): Record<string, TokenLedger> {
  const tokens = value && typeof value === 'object' ? Object.entries(value) : []
  return Object.fromEntries(tokens.flatMap(([id, l]) => { const ledger = UUID.test(id) && validLedger(l); return ledger ? [[id, ledger]] : [] }))
}

/** Tolerate absent or damaged tombstones: fall back to none. */
function validDeleted(value: Data['deleted']): FreeDeleted[] {
  return Array.isArray(value) ? value.filter(d => d && typeof d.id === 'string' && UUID.test(d.id) && FREE_PROVIDERS.includes(d.provider) && Number.isInteger(d.num) && typeof d.name === 'string') : []
}

/** accounts.json's text. Fails closed on damaged metadata; never silently replaces someone's stored account list. */
function load(text: string): Data {
  const value = JSON.parse(text) as Data
  if (!Array.isArray(value.instances) || !Array.isArray(value.threads) || value.instances.some(i => !UUID.test(i.id) || !['claude', 'chatgpt'].includes(i.provider))) throw new Error('Invalid Free account metadata')
  value.settings = validSettings(value.settings as Partial<FreeSettings> | undefined)
  value.tokens = validTokens(value.tokens)
  value.stats = value.stats === undefined ? seedStats(value.tokens) : validStats(value.stats) ?? {}
  value.forgotten = Array.isArray(value.forgotten) ? value.forgotten.filter(f => typeof f === 'string') : []
  value.deleted = validDeleted(value.deleted)
  // Older records lack lastSignedInAt: a signed-in account was last signed in when it was last checked.
  for (const i of value.instances) if (typeof i.lastSignedInAt !== 'number') i.lastSignedInAt = i.loggedIn ? i.checkedAt ?? null : null
  for (const i of value.instances) if (typeof i.autoName !== 'boolean') i.autoName = generic(i.name)
  for (const t of value.threads) if (t.status === 'running') { t.status = 'failed'; t.error = 'Desk restarted during the request. Read this chat before sending again.' }
  return value
}

/** Persistent account/chat metadata only. DPAPI files are copied without decrypting them. */
export class FreeStorage {
  data: Data = { instances: [], threads: [] }
  private file: string
  constructor(private home: string) {
    this.file = join(home, 'free', 'accounts.json')
    const bytes = existsSync(this.file) ? readFileSync(this.file) : null
    if (!bytes) this.migrate()
    else if (bytes.every(b => b === 0)) this.rebuild()
    else this.data = load(bytes.toString('utf8'))
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
    if (this.data.forgotten) this.data.forgotten = this.data.forgotten.filter(f => !f.startsWith(`${id}/`))
    if (this.data.tokens) delete this.data.tokens[id]
    for (const day of Object.values(this.data.stats ?? {})) delete day[id]
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
    writeFlushed(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
  }
  /**
   * accounts.json is only NUL bytes (or empty): an unclean shutdown kept its length and lost its data, as on 2026-10-08,
   * so there is nothing left in it to protect. It is set aside, never deleted, and each account folder holding a login
   * becomes an account again under a plain name, which its first sign-in check (refresh.ts, first for an account never
   * checked) replaces with the account's own; that check's chat read brings its chats back.
   */
  private rebuild(): void {
    renameSync(this.file, `${this.file}.unwritten-${Date.now()}`)
    const root = join(this.home, 'free', 'instances')
    const folders = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && UUID.test(d.name)) : []
    const found = folders.flatMap(d => {
      const dir = join(root, d.name)
      const provider: FreeProvider | null = existsSync(join(dir, 'session.dpapi')) ? 'claude' : existsSync(join(dir, 'chatgpt', 'session.dpapi')) ? 'chatgpt' : null
      return provider ? [{ id: d.name, provider, born: statSync(dir).birthtimeMs }] : []
    }).sort((a, b) => a.born - b.born)
    const instances = found.map(({ id, provider }, i): FreeInstance => ({ id, num: i + 1, provider, name: provider === 'claude' ? 'Claude' : 'ChatGPT', autoName: true, loggedIn: false, checkedAt: null, lastSignedInAt: null, lastActiveAt: null, usage: null }))
    this.data = { instances, threads: [], settings: { ...FREE_SETTINGS_DEFAULTS }, tokens: {}, stats: {}, forgotten: [], deleted: [] }
    console.error(`[free] accounts.json held no data (an unclean shutdown): set aside, ${instances.length} account(s) rebuilt from their folders`)
    this.save()
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
