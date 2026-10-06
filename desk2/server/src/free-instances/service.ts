import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { FREE_COMMANDS, FREE_PROVIDERS, type FreeInstance, type FreeJob, type FreeRequest, type FreeStatus, type FreeThread } from '@shared/free-instances'
import { failure, parseResult } from './results'
import { runFree, type FreeRunner } from './runner'
import { ManagedFreeRuntime, type FreeRuntime } from './runtime'
import { FreeStorage } from './storage'
import type { FreeSyncHost } from './sync'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export class FreeError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 503 = 400) { super(message) }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FreeError('A JSON operation is required.')
  return value as Record<string, unknown>
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f]/.test(value)) throw new FreeError('A name must contain 1–100 printable characters.')
  return value.trim()
}
export function validateRequest(value: unknown): FreeRequest {
  const r = record(value) as unknown as FreeRequest
  const keys = ['requestId', 'instanceId', 'provider', 'command', 'chatId', 'prompt', 'name', 'webSearch']
  if (Object.keys(r).some(k => !keys.includes(k))) throw new FreeError('Unknown operation option.')
  if (typeof r.requestId !== 'string' || !UUID.test(r.requestId) || typeof r.instanceId !== 'string' || !UUID.test(r.instanceId) || !FREE_PROVIDERS.includes(r.provider) || !FREE_COMMANDS.includes(r.command)) throw new FreeError('Request and instance UUIDs, a supported provider and command are required.')
  const send = r.command === 'chat' || r.command === 'resume'
  const reference = ['read', 'resume', 'track'].includes(r.command)
  if (reference ? typeof r.chatId !== 'string' || !UUID.test(r.chatId) : r.chatId !== undefined) throw new FreeError('Use an explicit chat UUID for read, resume or track.')
  if (send ? typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > 100_000 : r.prompt !== undefined) throw new FreeError('Messages must contain 1–100,000 characters, only for chat or resume.')
  if (r.name !== undefined) { if (!['chat', 'track'].includes(r.command)) throw new FreeError('Name is an option for chat or track.'); name(r.name) }
  if (r.command === 'track' && !r.name) throw new FreeError('A name is required when tracking a chat.')
  if (r.webSearch !== undefined && (typeof r.webSearch !== 'boolean' || !send || r.provider !== 'claude')) throw new FreeError('Web search is an option for Claude messages only.')
  return { ...r }
}

export class FreeInstances {
  private store: FreeStorage
  private runtime: FreeRuntime
  private jobs = new Map<string, FreeJob>()
  private fingerprints = new Map<string, string>()
  private controllers = new Map<string, AbortController>()
  /** Accounts whose log out is running: no operation may start on them meanwhile. */
  private forgetting = new Set<string>()
  private stopping = false
  private cleanup = setInterval(() => this.prune(), 60_000).unref()
  /** A sign-in or a log out here (the Free login sync listens, so the other PCs hear soon). */
  onLoginChange?: () => void
  constructor(home: string, private runner: FreeRunner = runFree, runtime?: FreeRuntime) {
    this.store = new FreeStorage(home)
    this.runtime = runtime ?? new ManagedFreeRuntime(home)
  }
  private prune(): void {
    for (const [id, job] of this.jobs) if (job.finishedAt && Date.now() - job.finishedAt > 15 * 60_000) { this.jobs.delete(id); this.fingerprints.delete(id) }
  }
  private instance(id: string): FreeInstance {
    const instance = this.store.data.instances.find(i => i.id === id)
    if (!instance) throw new FreeError('Free instance not found.', 404)
    return instance
  }
  create(value: unknown): FreeInstance {
    const r = record(value)
    if (Object.keys(r).some(k => !['provider', 'name'].includes(k)) || !FREE_PROVIDERS.includes(r.provider as FreeInstance['provider'])) throw new FreeError('Choose Claude or ChatGPT.')
    return this.store.create(r.provider as FreeInstance['provider'], name(r.name))
  }
  rename(id: string, value: unknown): FreeInstance {
    const r = record(value)
    if (Object.keys(r).some(k => k !== 'name')) throw new FreeError('Only a name can be changed.')
    const instance = this.instance(id)
    instance.name = name(r.name)
    this.store.save()
    return instance
  }
  /**
   * Removes the stored sign-in only (chats and metadata stay); the account can sign in again later. The harness's own
   * forget does it: it deletes the session under the lock a cookie refresh takes, and for ChatGPT it first stops the
   * live worker, whose browser would otherwise stay signed in.
   */
  async logout(id: string): Promise<FreeInstance> {
    const instance = this.instance(id)
    if (this.stopping) throw new FreeError('Desk is stopping. Log out after reconnecting.', 503)
    if (this.forgetting.has(id) || [...this.jobs.values()].some(j => j.instanceId === id && j.state === 'running')) throw new FreeError('This account has an operation running. Wait for it to finish or cancel it first.', 409)
    this.forgetting.add(id)
    try {
      try { await this.runtime.ensure(instance.provider, false) }
      catch { throw new FreeError('Automatic setup could not finish. Check that Python 3.11 or later, Bun and Node.js are installed, then try again.', 503) }
      const done = await this.runner(this.runtime.config(id), { requestId: randomUUID(), instanceId: id, provider: instance.provider, command: 'forget' }, AbortSignal.timeout(240_000)).catch(() => null)
      if (done?.code !== 0) throw new FreeError('The saved login could not be removed. Try again.', 503)
    } finally { this.forgetting.delete(id) }
    instance.loggedIn = false
    instance.checkedAt = Date.now()
    instance.usage = null
    // Logged out on purpose, not lost: the row offers "Sign in", and "Sign in again" stays for an expired login.
    instance.lastSignedInAt = null
    this.store.save()
    this.onLoginChange?.()
    return instance
  }
  /** What the Free login sync (sync.ts) reads and does here. */
  syncHost(): FreeSyncHost {
    return {
      list: () => this.store.data.instances,
      busy: id => this.forgetting.has(id) || [...this.jobs.values()].some(j => j.instanceId === id && j.state === 'running'),
      sessionFile: i => join(this.runtime.config(i.id).stateDir, i.provider === 'chatgpt' ? 'chatgpt' : '', 'session.dpapi'),
      adopt: shared => this.store.adopt(shared),
      landed: id => {
        const instance = this.instance(id)
        instance.loggedIn = true
        instance.checkedAt = instance.lastSignedInAt = Date.now()
        this.store.save()
        // Check it here at once: the row then says whether the login works on this PC, with its quota.
        try { this.start({ requestId: randomUUID(), instanceId: id, provider: instance.provider, command: 'auth' }) } catch { /* an operation already runs on it; the next check confirms the login */ }
      },
      forget: async id => { await this.logout(id) }
    }
  }
  threads(): FreeThread[] { return this.store.data.threads }
  status(): FreeStatus {
    this.prune()
    return { ready: this.runtime.ready(), instances: this.store.data.instances, jobs: [...this.jobs.values()].map(({ result, ...job }) => ({ ...job, chatId: result?.chat_id ?? result?.error?.chat_id ?? job.chatId })) }
  }
  get(id: string): FreeJob {
    this.prune()
    const job = this.jobs.get(id)
    if (!job) throw new FreeError('Operation not found or expired. Refresh the chat list and read the chat before sending again.', 404)
    return job
  }
  cancel(id: string): void { this.get(id); this.controllers.get(id)?.abort() }
  start(value: unknown): FreeJob {
    const r = validateRequest(value)
    const fingerprint = createHash('sha256').update(JSON.stringify([r.instanceId, r.provider, r.command, r.chatId, r.prompt, r.name, r.webSearch])).digest('hex')
    const previous = this.jobs.get(r.requestId)
    if (previous) {
      if (this.fingerprints.get(r.requestId) !== fingerprint) throw new FreeError('That request UUID already identifies another operation.', 409)
      return previous
    }
    if (this.stopping) throw new FreeError('Desk is stopping. Read the chat after reconnecting.', 503)
    const instance = this.instance(r.instanceId)
    if (instance.provider !== r.provider) throw new FreeError('The provider does not match this instance.')
    if (this.forgetting.has(r.instanceId) || [...this.jobs.values()].some(j => j.instanceId === r.instanceId && j.state === 'running')) throw new FreeError('This account already has an operation running.', 409)
    this.prune()
    while (this.jobs.size >= 16) {
      const oldest = [...this.jobs.values()].find(j => j.state === 'done')
      if (!oldest) throw new FreeError('Desk already has 16 operations running.', 409)
      this.jobs.delete(oldest.id); this.fingerprints.delete(oldest.id)
    }
    const job: FreeJob = { id: r.requestId, instanceId: r.instanceId, provider: r.provider, command: r.command, state: 'running', phase: 'setup', startedAt: Date.now(), chatId: r.chatId }
    this.jobs.set(job.id, job)
    this.fingerprints.set(job.id, fingerprint)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    this.markThread(r, 'running')
    void this.execute(job, r, controller)
    return job
  }
  private markThread(r: FreeRequest, status: FreeThread['status'], chatId = r.chatId, error: string | null = null, serverId?: string, title?: string, createdAt?: number): void {
    if (!chatId || !UUID.test(chatId)) return
    const id = `${r.instanceId}/${chatId}`
    let thread = this.store.data.threads.find(t => t.id === id)
    if (!thread) {
      thread = { id, instanceId: r.instanceId, provider: r.provider, chatId, title: title || r.name || `${r.provider === 'claude' ? 'Claude' : 'ChatGPT'} · ${chatId.slice(0, 8)}`, status, createdAt: createdAt || Date.now(), updatedAt: Date.now(), error }
      this.store.data.threads.push(thread)
    }
    Object.assign(thread, { status, error, updatedAt: Date.now() }, serverId ? { serverId } : {}, title ? { title } : {})
    this.store.save()
  }
  private async execute(job: FreeJob, r: FreeRequest, controller: AbortController): Promise<void> {
    try {
      try { await this.runtime.ensure(r.provider, r.command === 'login') }
      catch { job.result = failure('setup_failed', 'Automatic setup could not finish. Check that Python 3.11 or later, Bun and Node.js are installed, then try again.'); return }
      controller.signal.throwIfAborted()
      job.phase = 'working'
      const config = this.runtime.config(r.instanceId)
      job.result = parseResult(r.command, await this.runner(config, r, controller.signal))
      const instance = this.instance(r.instanceId)
      if (r.command === 'auth' || r.command === 'login') {
        instance.loggedIn = job.result.ok && job.result.authenticated === true
        instance.checkedAt = Date.now()
        if (instance.loggedIn) { instance.lastSignedInAt = instance.checkedAt; this.onLoginChange?.() }
        // Read-only followups bring imported chats and available quota into the shared view.
        if (instance.loggedIn) for (const command of ['chats', 'usage'] as const) {
          try { this.apply({ ...r, command }, parseResult(command, await this.runner(config, { ...r, command }, controller.signal))) } catch { /* auth still succeeded; refresh can retry a read */ }
        }
      }
      this.apply(r, job.result)
    } catch {
      job.result = failure('operation_interrupted', 'The operation was interrupted. Refresh the chat list and read the chat before sending again.', r.chatId)
      this.markThread(r, 'failed', r.chatId, job.result.error!.message)
    } finally {
      job.state = 'done'; job.finishedAt = Date.now(); this.controllers.delete(job.id)
      this.store.save()
    }
  }
  private apply(r: FreeRequest, result: NonNullable<FreeJob['result']>): void {
    const instance = this.instance(r.instanceId)
    if (result.usage) instance.usage = result.usage
    if (result.ok && (r.command === 'chat' || r.command === 'resume')) instance.lastActiveAt = Date.now()
    if (result.chats) for (const chat of result.chats) {
      if (chat.is_temporary === true) {
        const existing = this.store.data.threads.find(t => t.instanceId === r.instanceId && t.chatId === chat.chat_id)
        this.markThread(r, existing?.status ?? 'done', chat.chat_id, existing?.error ?? null, chat.server_conversation_id, existing?.title || chat.name || undefined, Date.parse(chat.created_at ?? '') || undefined)
      }
    }
    if (!['auth', 'login', 'usage', 'chats'].includes(r.command)) {
      if (result.ok && result.is_temporary) { instance.loggedIn = true; instance.checkedAt = instance.lastSignedInAt = Date.now() }
      const chatId = result.chat_id ?? result.error?.chat_id ?? r.chatId
      const existing = this.store.data.threads.find(t => t.instanceId === r.instanceId && t.chatId === chatId)
      if (result.ok) result.chat_name = r.name || existing?.title || result.chat_name
      this.markThread(r, result.ok ? 'done' : 'failed', chatId, result.error?.message ?? null, result.server_conversation_id, r.name || existing?.title || result.chat_name || undefined)
    }
    this.store.save()
  }
  stop(): void { this.stopping = true; clearInterval(this.cleanup); for (const controller of this.controllers.values()) controller.abort() }
}
