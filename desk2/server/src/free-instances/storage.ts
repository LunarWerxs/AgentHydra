import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { FreeInstance, FreeProvider, FreeThread } from '@shared/free-instances'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
interface Data { instances: FreeInstance[]; threads: FreeThread[] }

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
      // Older records lack lastSignedInAt: a signed-in account was last signed in when it was last checked.
      for (const i of this.data.instances) if (typeof i.lastSignedInAt !== 'number') i.lastSignedInAt = i.loggedIn ? i.checkedAt ?? null : null
      for (const t of this.data.threads) if (t.status === 'running') { t.status = 'failed'; t.error = 'Desk restarted during the request. Read this chat before sending again.' }
    } else this.migrate()
  }
  create(provider: FreeProvider, name: string): FreeInstance {
    const instance: FreeInstance = { id: randomUUID(), num: Math.max(0, ...this.data.instances.map(i => i.num)) + 1, provider, name, loggedIn: false, checkedAt: null, lastSignedInAt: null, lastActiveAt: null, usage: null }
    mkdirSync(join(this.home, 'free', 'instances', instance.id), { recursive: true })
    this.data.instances.push(instance)
    this.save()
    return instance
  }
  /** An account another PC shares (free-instances/sync.ts): its id and name, and its number unless one here has it. */
  adopt(shared: Pick<FreeInstance, 'id' | 'num' | 'provider' | 'name'>): FreeInstance {
    const taken = this.data.instances.some(i => i.num === shared.num)
    const num = taken ? Math.max(0, ...this.data.instances.map(i => i.num)) + 1 : shared.num
    const instance: FreeInstance = { ...shared, num, loggedIn: false, checkedAt: null, lastSignedInAt: null, lastActiveAt: null, usage: null }
    mkdirSync(join(this.home, 'free', 'instances', instance.id), { recursive: true })
    this.data.instances.push(instance)
    this.save()
    return instance
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
      const instance = this.create(provider, provider === 'claude' ? 'Claude' : 'ChatGPT')
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
