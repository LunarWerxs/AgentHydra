import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { FREE_CHATGPT_MODELS, FREE_CLAUDE_MODELS, FREE_COMMANDS, FREE_PROVIDERS, FREE_SETTINGS_DEFAULTS, isPaidPlan, type FreeHealth, type FreeInstance, type FreeJob, type FreeRequest, type FreeResult, type FreeSettings, type FreeStatRow, type FreeStatus, type FreeThread, type FreeTokens } from '@shared/free-instances'
import { addOutcome, healthOf, type SendOutcome } from './health'
import { NUDGE_EVERY_MS, nudgeDue } from './keepalive'
import { nextRead, REFRESH_TICK_MS, USAGE_EVERY_MS } from './refresh'
import { failure, parseResult } from './results'
import { runFree, type FreeRunner } from './runner'
import { ManagedFreeRuntime, SetupRefused, type FreeRuntime } from './runtime'
import { FreeStorage } from './storage'
import type { FreeSyncHost } from './sync'
import { addStat, statRows } from './stats'
import { addTokens, estimateTokens, type TokenEntry, tokenWindows } from './tokens'

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
const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID.test(v)
function checkIdentity(r: FreeRequest): void {
  const keys = ['requestId', 'instanceId', 'provider', 'command', 'chatId', 'prompt', 'name', 'webSearch', 'model']
  if (Object.keys(r).some(k => !keys.includes(k))) throw new FreeError('Unknown operation option.')
  if (!isUuid(r.requestId) || !isUuid(r.instanceId) || !FREE_PROVIDERS.includes(r.provider) || !FREE_COMMANDS.includes(r.command)) throw new FreeError('Request and instance UUIDs, a supported provider and command are required.')
}
function checkChatAndPrompt(r: FreeRequest, send: boolean): void {
  const reference = ['read', 'resume', 'track'].includes(r.command)
  if (reference ? !isUuid(r.chatId) : r.chatId !== undefined) throw new FreeError('Use an explicit chat UUID for read, resume or track.')
  if (send ? typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > 100_000 : r.prompt !== undefined) throw new FreeError('Messages must contain 1–100,000 characters, only for chat or resume.')
}
function checkOptions(r: FreeRequest, send: boolean): void {
  if (r.name !== undefined) { if (!['chat', 'track'].includes(r.command)) throw new FreeError('Name is an option for chat or track.'); name(r.name) }
  if (r.command === 'nudge' && r.provider !== 'claude') throw new FreeError('A keepalive nudge is for Claude only.')
  if (r.command === 'track' && !r.name) throw new FreeError('A name is required when tracking a chat.')
  const claudeMessage = send && r.provider === 'claude'
  if (r.webSearch !== undefined && (typeof r.webSearch !== 'boolean' || !claudeMessage)) throw new FreeError('Web search is an option for Claude messages only.')
  const models: readonly string[] = r.provider === 'claude' ? FREE_CLAUDE_MODELS : FREE_CHATGPT_MODELS
  if (r.model !== undefined && (!send || !models.includes(r.model)))
    throw new FreeError(`Model is ${models.join(' or ')} for a ${r.provider === 'claude' ? 'Claude' : 'ChatGPT'} message.`)
}
export function validateRequest(value: unknown): FreeRequest {
  const r = record(value) as unknown as FreeRequest
  checkIdentity(r)
  const send = r.command === 'chat' || r.command === 'resume'
  checkChatAndPrompt(r, send)
  checkOptions(r, send)
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
  /** Keep windows running: a first pass a minute after start, then every NUDGE_EVERY_MS. */
  private keeper: ReturnType<typeof setTimeout>
  /** The rolling refresh (refresh.ts): a first read a minute and a half after start, then one each REFRESH_TICK_MS. */
  private refresher: ReturnType<typeof setTimeout>
  /** When the rolling refresh last started a read on each account: one per USAGE_EVERY_MS at most, so a read that
   *  fails before it records anything (setup, a crash) is not tried again every tick. */
  private refreshed = new Map<string, number>()
  /** Each operation's end: a person's operation waits for it while Desk's own read (FreeJob.auto) holds the account. */
  private runs = new Map<string, Promise<void>>()
  /** Each account's messages in the last hour and how they ended (health.ts). Kept in memory: an hour is gone soon. */
  private outcomes = new Map<string, SendOutcome[]>()
  /** A sign-in or a log out here (the Free login sync listens, so the other PCs hear soon). */
  onLoginChange?: () => void
  /** An account moved between free and paid (notePlan); the plugin tells the window. */
  onPlanChange?: (instance: FreeInstance) => void
  constructor(home: string, private runner: FreeRunner = runFree, runtime?: FreeRuntime) {
    this.store = new FreeStorage(home)
    this.runtime = runtime ?? new ManagedFreeRuntime(home)
    // Armed only once the store has loaded. Armed before (as field initialisers), a store that failed to load left
    // them running on an instance with no store, and the first pass a minute later took the whole server down
    // (2026-10-08), where the plugin's failure alone costs only Free.
    this.keeper = setTimeout(() => { this.keepWindows(); this.keeper = setInterval(() => this.keepWindows(), NUDGE_EVERY_MS).unref() }, 60_000).unref()
    this.refresher = setTimeout(() => { this.refreshNext(); this.refresher = setInterval(() => this.refreshNext(), REFRESH_TICK_MS).unref() }, 90_000).unref()
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
    return this.store.create(r.provider as FreeInstance['provider'], r.name === undefined ? undefined : name(r.name))
  }
  rename(id: string, value: unknown): FreeInstance {
    const r = record(value)
    if (Object.keys(r).some(k => k !== 'name')) throw new FreeError('Only a name can be changed.')
    const instance = this.instance(id)
    instance.name = name(r.name)
    instance.autoName = false
    this.store.save()
    return instance
  }
  /**
   * Removes the stored sign-in only (chats and metadata stay); the account can sign in again later. The harness's own
   * forget does it: it deletes the saved login (and for ChatGPT its preparations) under the lock a cookie refresh takes.
   */
  async logout(id: string): Promise<FreeInstance> {
    this.instance(id)
    if (this.stopping) throw new FreeError('Desk is stopping. Log out after reconnecting.', 503)
    await this.autoSettled(id)
    const instance = this.instance(id)
    if (this.busy(id)) throw new FreeError('This account has an operation running. Wait for it to finish or cancel it first.', 409)
    this.forgetting.add(id)
    try {
      try { await this.runtime.ensure(instance.provider) }
      catch (e) { throw new FreeError(e instanceof SetupRefused ? e.message : 'Automatic setup could not finish. Check that Python 3.11 or later, Bun and Node.js are installed, then try again.', 503) }
      const done = await this.runner(this.runtime.config(id), { requestId: randomUUID(), instanceId: id, provider: instance.provider, command: 'forget' }, AbortSignal.timeout(240_000)).catch(() => null)
      if (done?.code !== 0) throw new FreeError('The saved login could not be removed. Try again.', 503)
    } finally { this.forgetting.delete(id) }
    instance.loggedIn = false
    instance.checkedAt = Date.now()
    instance.usage = null
    // The next sign-in may be another account: its check reads the address and the plan again.
    instance.email = null
    instance.plan = null
    instance.planChange = null
    // Logged out on purpose, not lost: the row offers "Sign in", and "Sign in again" stays for an expired login.
    instance.lastSignedInAt = null
    this.store.save()
    this.onLoginChange?.()
    return instance
  }
  /**
   * Deletes the account here: its login, state folder, chats and row. Deleting reaches every PC, as a log out does:
   * the sync leaves a tombstone for the store, and the other PCs remove it too (they pass `tombstone: false`).
   */
  async remove(id: string, opts: { tombstone?: boolean } = {}): Promise<{ ok: true }> {
    this.instance(id)
    if (this.stopping) throw new FreeError('Desk is stopping. Delete the account after reconnecting.', 503)
    await this.autoSettled(id)
    const instance = this.instance(id)
    if (this.busy(id)) throw new FreeError('This account has an operation running. Wait for it to finish or cancel it first.', 409)
    this.forgetting.add(id)
    try {
      // The harness's forget also stops a live ChatGPT worker; its failure does not matter, the folder delete removes the login file anyway.
      try {
        await this.runtime.ensure(instance.provider)
        await this.runner(this.runtime.config(id), { requestId: randomUUID(), instanceId: id, provider: instance.provider, command: 'forget' }, AbortSignal.timeout(240_000))
      } catch { /* deleted regardless */ }
      for (const [jobId, job] of this.jobs) if (job.instanceId === id) { this.jobs.delete(jobId); this.fingerprints.delete(jobId) }
      this.store.remove(id, opts.tombstone ?? true)
      this.refreshed.delete(id)
    } finally { this.forgetting.delete(id) }
    this.onLoginChange?.()
    return { ok: true }
  }
  private busy(id: string): boolean {
    return this.forgetting.has(id) || [...this.jobs.values()].some(j => j.instanceId === id && j.state === 'running')
  }
  /** Waits until no read of Desk's own (FreeJob.auto) runs on the account: a person's log out or delete waits for one
   *  rather than being refused. */
  private async autoSettled(id: string): Promise<void> {
    for (;;) {
      const job = [...this.jobs.values()].find(j => j.instanceId === id && j.state === 'running' && j.auto)
      const run = job && this.runs.get(job.id)
      if (!run) return
      await run
    }
  }
  settings(): FreeSettings { return this.store.data.settings ?? { ...FREE_SETTINGS_DEFAULTS } }
  updateSettings(value: unknown): FreeSettings {
    const r = record(value)
    if (Object.keys(r).some(k => k !== 'keepWindows' && k !== 'weeklyFloorPct')) throw new FreeError('Only keepWindows and weeklyFloorPct can be changed.')
    if (r.keepWindows !== undefined && typeof r.keepWindows !== 'boolean') throw new FreeError('keepWindows must be true or false.')
    if (r.weeklyFloorPct !== undefined && (!Number.isInteger(r.weeklyFloorPct) || (r.weeklyFloorPct as number) < 1 || (r.weeklyFloorPct as number) > 100)) throw new FreeError('weeklyFloorPct must be a whole number from 1 to 100.')
    this.store.data.settings = { ...this.settings(), ...r }
    this.store.save()
    setTimeout(() => this.keepWindows(), 0).unref()
    return this.store.data.settings
  }
  /** Starts a nudge on each signed-in Claude account that is due (keepalive.ts); one that is busy waits for the next pass. */
  keepWindows(): void {
    const settings = this.settings()
    for (const instance of [...this.store.data.instances]) {
      if (!nudgeDue(instance, settings, Date.now()) || this.busy(instance.id)) continue
      try { this.start({ requestId: randomUUID(), instanceId: instance.id, provider: 'claude', command: 'nudge' }, true) } catch { /* Desk is stopping or its jobs are full; the next pass tries again */ }
    }
  }
  /** One read of the rolling refresh (refresh.ts): the most overdue account's login check or usage, as Desk's own job. */
  refreshNext(): void {
    if (this.stopping) return
    const now = Date.now()
    const read = nextRead(this.store.data.instances, id => this.busy(id) || now - (this.refreshed.get(id) ?? 0) < USAGE_EVERY_MS, now)
    if (!read) return
    this.refreshed.set(read.id, now)
    try { this.start({ requestId: randomUUID(), instanceId: read.id, provider: this.instance(read.id).provider, command: read.command }, true) } catch { /* its jobs are full; a later tick reads it */ }
  }
  /** What the Free login sync (sync.ts) reads and does here. */
  syncHost(): FreeSyncHost {
    return {
      list: () => this.store.data.instances,
      deleted: () => this.store.data.deleted ?? [],
      settled: id => this.store.settle(id),
      remove: async id => { await this.remove(id, { tombstone: false }) },
      busy: id => this.busy(id),
      sessionFile: i => join(this.runtime.config(i.id).stateDir, i.provider === 'chatgpt' ? 'chatgpt' : '', 'session.dpapi'),
      adopt: shared => this.store.adopt(shared),
      landed: id => {
        const instance = this.instance(id)
        instance.loggedIn = true
        instance.checkedAt = instance.lastSignedInAt = Date.now()
        this.store.save()
        // Check it here at once: the row then says whether the login works on this PC, with its quota. A read of Desk's
        // own already running began with the old login and may report it gone: this check waits and comes after it.
        void this.autoSettled(id).then(() => {
          try { this.start({ requestId: randomUUID(), instanceId: id, provider: instance.provider, command: 'auth' }, true) } catch { /* someone's operation runs on it; the next check confirms the login */ }
        })
      },
      forget: async id => { await this.logout(id) }
    }
  }
  threads(): FreeThread[] { return this.store.data.threads }
  /** Removes one thread from Desk's list (a private chat: it is not in the site's history either). Its tokens stay in the
   *  account's ledger, so the totals do not drop. Refused while its message is still running. Its id is remembered: the
   *  harness still lists the private chats it made, and the next read of them (refresh.ts, hourly) would add it back. */
  forgetThread(id: string): { ok: true } {
    const thread = this.store.data.threads.find(t => t.id === id)
    if (!thread) throw new FreeError('Thread not found.', 404)
    if (thread.status === 'running') throw new FreeError('This chat has a message running. Wait for it to finish or cancel it first.', 409)
    this.store.data.threads = this.store.data.threads.filter(t => t !== thread)
    this.store.data.forgotten = [...(this.store.data.forgotten ?? []).filter(f => f !== id), id].slice(-5000)
    this.store.save()
    return { ok: true }
  }
  status(): FreeStatus {
    this.prune()
    const now = Date.now()
    const tokens: Record<string, FreeTokens> = {}
    const health: Record<string, FreeHealth> = {}
    for (const i of this.store.data.instances) {
      const ledger = this.store.data.tokens?.[i.id]
      if (ledger) tokens[i.id] = tokenWindows(ledger, i.usage, now)
      const hour = healthOf(this.outcomes.get(i.id), now)
      if (hour) health[i.id] = hour
    }
    return { ready: this.runtime.ready(), tokens, health, instances: this.store.data.instances, jobs: [...this.jobs.values()].map(({ result, ...job }) => ({ ...job, chatId: result?.chat_id ?? result?.error?.chat_id ?? job.chatId })) }
  }
  /** The last `days` days' messages by account and model (stats.ts). */
  stats(days: number): FreeStatRow[] { return statRows(this.store.data.stats ?? {}, days, Date.now()) }
  get(id: string): FreeJob {
    this.prune()
    const job = this.jobs.get(id)
    if (!job) throw new FreeError('Operation not found or expired. Refresh the chat list and read the chat before sending again.', 404)
    return job
  }
  cancel(id: string): void { this.get(id); this.controllers.get(id)?.abort() }
  /** `auto`: Desk's own job (FreeJob.auto). It never waits: it is refused while the account runs anything; an operation a
   *  person or a chat asks for while it runs waits for it instead of being refused. */
  start(value: unknown, auto = false): FreeJob {
    const r = validateRequest(value)
    const fingerprint = createHash('sha256').update(JSON.stringify([r.instanceId, r.provider, r.command, r.chatId, r.prompt, r.name, r.webSearch, r.model])).digest('hex')
    const previous = this.jobs.get(r.requestId)
    if (previous) {
      if (this.fingerprints.get(r.requestId) !== fingerprint) throw new FreeError('That request UUID already identifies another operation.', 409)
      return previous
    }
    if (this.stopping) throw new FreeError('Desk is stopping. Read the chat after reconnecting.', 503)
    const instance = this.instance(r.instanceId)
    if (instance.provider !== r.provider) throw new FreeError('The provider does not match this instance.')
    const running = [...this.jobs.values()].filter(j => j.instanceId === r.instanceId && j.state === 'running')
    if (this.forgetting.has(r.instanceId) || (running.length && (auto || running.some(j => !j.auto)))) throw new FreeError('This account already has an operation running.', 409)
    this.prune()
    while (this.jobs.size >= 16) {
      const oldest = [...this.jobs.values()].find(j => j.state === 'done')
      if (!oldest) throw new FreeError('Desk already has 16 operations running.', 409)
      this.jobs.delete(oldest.id); this.fingerprints.delete(oldest.id)
    }
    const job: FreeJob = { id: r.requestId, instanceId: r.instanceId, provider: r.provider, command: r.command, state: 'running', phase: 'setup', startedAt: Date.now(), chatId: r.chatId, ...(auto ? { auto: true } : {}) }
    this.jobs.set(job.id, job)
    this.fingerprints.set(job.id, fingerprint)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    this.markThread(r, 'running')
    const before = running.length ? Promise.all(running.map(j => this.runs.get(j.id))).then(() => undefined) : undefined
    const run = this.execute(job, r, controller, before).then(() => undefined, () => undefined)
    this.runs.set(job.id, run)
    void run.then(() => this.runs.delete(job.id))
    return job
  }
  /** noteThread, then the store saved. */
  private markThread(r: FreeRequest, status: FreeThread['status'], chatId = r.chatId, error: string | null = null, serverId?: string, title?: string, createdAt?: number, used = true): void {
    if (this.noteThread(r, status, chatId, error, serverId, title, createdAt, used)) this.store.save()
  }
  /**
   * Marks a thread (adding it when new) without saving the store; true when one was marked. apply() notes a whole
   * chat list and saves once: a save per chat wrote the whole store (5 MB, fsync'd) for each, and one account's list
   * of 1,493 chats held the server's one thread for 16 s, 30 to 80 s on a busy PC, the sidebar frozen meanwhile
   * (2026-10-09). `used` false for a chat-list refresh: it records the chat but is not a use, so "last used" stays.
   */
  private noteThread(r: FreeRequest, status: FreeThread['status'], chatId = r.chatId, error: string | null = null, serverId?: string, title?: string, createdAt?: number, used = true): boolean {
    if (!chatId || !UUID.test(chatId)) return false
    const id = `${r.instanceId}/${chatId}`
    // A forgotten chat used again (a message, a track, a read) is wanted again: the chat-list read keeps it current.
    const forgotten = this.store.data.forgotten
    if (used && forgotten?.includes(id)) this.store.data.forgotten = forgotten.filter(f => f !== id)
    let thread = this.store.data.threads.find(t => t.id === id)
    if (!thread) {
      const created = createdAt || Date.now()
      thread = { id, instanceId: r.instanceId, provider: r.provider, chatId, title: title || r.name || `${r.provider === 'claude' ? 'Claude' : 'ChatGPT'} · ${chatId.slice(0, 8)}`, status, createdAt: created, updatedAt: used ? Date.now() : created, error }
      this.store.data.threads.push(thread)
    }
    Object.assign(thread, { status, error }, used ? { updatedAt: Date.now() } : {}, serverId ? { serverId } : {}, title ? { title } : {})
    return true
  }
  private async execute(job: FreeJob, r: FreeRequest, controller: AbortController, before?: Promise<void>): Promise<void> {
    let spent: TokenEntry | null = null
    try {
      // Desk's own read on this account ends first: one operation per account at a time. A cancel ends the wait.
      if (before) await Promise.race([before, new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))])
      controller.signal.throwIfAborted()
      try { await this.runtime.ensure(r.provider) }
      catch (e) { job.result = failure('setup_failed', e instanceof SetupRefused ? e.message : 'Automatic setup could not finish. Check that Python 3.11 or later, Bun and Node.js are installed, then try again.'); return }
      controller.signal.throwIfAborted()
      job.phase = 'working'
      const config = this.runtime.config(r.instanceId)
      job.result = parseResult(r.command, await this.runner(config, r, controller.signal))
      const instance = this.instance(r.instanceId)
      if (r.command === 'auth' || r.command === 'login') await this.afterAuth(r, job.result, instance, config, controller.signal)
      if (r.command === 'nudge') await this.afterNudge(r, job.result, instance, config, controller.signal)
      spent = this.apply(r, job.result)
    } catch {
      job.result = failure('operation_interrupted', 'The operation was interrupted. Refresh the chat list and read the chat before sending again.', r.chatId)
      this.markThread(r, 'failed', r.chatId, job.result.error!.message)
    } finally {
      job.state = 'done'; job.finishedAt = Date.now(); this.controllers.delete(job.id)
      // A cancel is the asker's doing, not the account's.
      if ((r.command === 'chat' || r.command === 'resume') && !controller.signal.aborted) {
        this.outcomes.set(r.instanceId, addOutcome(this.outcomes.get(r.instanceId), { at: job.finishedAt, error: job.result?.ok ? null : (job.result?.error?.message ?? 'No result') }, job.finishedAt))
        const ok = job.result?.ok === true
        addStat((this.store.data.stats ??= {}), { at: job.finishedAt, instanceId: r.instanceId, model: ok ? job.result?.model : job.result?.error?.model, ok, input: spent?.input ?? 0, output: spent?.output ?? 0 })
      }
      this.store.save()
    }
  }
  private async afterAuth(r: FreeRequest, result: FreeResult, instance: FreeInstance, config: ReturnType<FreeRuntime['config']>, signal: AbortSignal): Promise<void> {
    // Only an answer moves the login: the site took it, or said it needs one (login_required). A check that failed
    // on its own (offline after sleep, a crashed harness) leaves it as it was: Desk checks in the background now
    // (refresh.ts), and a working login read as signed out would never be checked again.
    const signedIn = result.ok && result.authenticated === true
    if (result.ok || r.command === 'login' || result.error?.code === 'login_required') instance.loggedIn = signedIn
    instance.checkedAt = Date.now()
    if (!signedIn) return
    instance.lastSignedInAt = instance.checkedAt
    instance.email = result.account_email ?? null
    const label = result.account_label
    if (instance.autoName && label && label.length <= 100 && !/[\x00-\x1f]/.test(label)) instance.name = label
    this.onLoginChange?.()
    // Read-only followups bring imported chats and available quota into the shared view.
    for (const command of ['chats', 'usage'] as const) {
      try { this.apply({ ...r, command }, parseResult(command, await this.runner(config, { ...r, command }, signal))) } catch { /* auth still succeeded; refresh can retry a read */ }
    }
  }
  private async afterNudge(r: FreeRequest, result: FreeResult, instance: FreeInstance, config: ReturnType<FreeRuntime['config']>, signal: AbortSignal): Promise<void> {
    instance.nudge = { at: Date.now(), ok: result.ok }
    // Read the quota again so the window the nudge started shows.
    if (result.ok) try { this.apply({ ...r, command: 'usage' }, parseResult('usage', await this.runner(config, { ...r, command: 'usage' }, signal))) } catch { /* the nudge worked; the next refresh reads it */ }
  }
  /** Keep the plan a reading reports; a move between free and paid (a first reading that is already paid included) is
   *  kept on the row and told to onPlanChange. A reading with no plan changes nothing. */
  private notePlan(instance: FreeInstance, plan: string | null): void {
    if (!plan || plan === instance.plan) return
    const before = instance.plan ?? null
    instance.plan = plan
    if (isPaidPlan(plan) === isPaidPlan(before)) return
    instance.planChange = { from: before, to: plan, at: Date.now() }
    this.onPlanChange?.(instance)
  }
  /** The row's plan-change mark has been seen. */
  planSeen(id: string): FreeInstance {
    const instance = this.instance(id)
    instance.planChange = null
    this.store.save()
    return instance
  }
  /** Returns the message's token estimate, or null for anything that was not an answered message. */
  private apply(r: FreeRequest, result: NonNullable<FreeJob['result']>): TokenEntry | null {
    const instance = this.instance(r.instanceId)
    if (result.usage) {
      // A row read before plans were kept (2026-10-09) has its plan only in its last reading. Start from that, or
      // every account already on Go or Pro would be told as newly paid on its first reading after the update.
      if (instance.plan === undefined) instance.plan = instance.usage?.plan ?? null
      instance.usage = result.usage
      this.notePlan(instance, result.usage.plan ?? null)
    }
    if (r.command === 'usage') instance.usageReadAt = Date.now()
    if (result.ok && (r.command === 'chat' || r.command === 'resume')) instance.lastActiveAt = Date.now()
    if (result.chats) for (const chat of result.chats) {
      if (chat.is_temporary === true && !this.store.data.forgotten?.includes(`${r.instanceId}/${chat.chat_id}`)) {
        const existing = this.store.data.threads.find(t => t.instanceId === r.instanceId && t.chatId === chat.chat_id)
        this.noteThread(r, existing?.status ?? 'done', chat.chat_id, existing?.error ?? null, chat.server_conversation_id, existing?.title || chat.name || undefined, Date.parse(chat.created_at ?? '') || undefined, false)
      }
    }
    if (!['auth', 'login', 'usage', 'chats', 'nudge'].includes(r.command)) {
      if (result.ok && result.is_temporary) { instance.loggedIn = true; instance.checkedAt = instance.lastSignedInAt = Date.now() }
      const chatId = result.chat_id ?? result.error?.chat_id ?? r.chatId
      const existing = this.store.data.threads.find(t => t.instanceId === r.instanceId && t.chatId === chatId)
      if (result.ok) result.chat_name = r.name || existing?.title || result.chat_name
      this.noteThread(r, result.ok ? 'done' : 'failed', chatId, result.error?.message ?? null, result.server_conversation_id, r.name || existing?.title || result.chat_name || undefined)
    }
    const spent = result.ok ? this.countTokens(r, result) : null
    this.store.save()
    return spent
  }
  /** A message adds to the account's token estimate (tokens.ts): what it sent, the thread it continues included, and
   *  the reply. A chat that was read gives its thread's length, so a later continuation counts what it holds. */
  private countTokens(r: FreeRequest, result: FreeResult): TokenEntry | null {
    const chatId = result.chat_id ?? r.chatId
    const thread = this.store.data.threads.find(t => t.instanceId === r.instanceId && t.chatId === chatId)
    if (r.command === 'read' && thread && result.messages) thread.contextChars = result.messages.reduce((n, m) => n + (m.text?.length ?? 0), 0)
    if (r.command !== 'chat' && r.command !== 'resume') return null
    const context = r.command === 'resume' ? thread?.contextChars ?? 0 : 0
    const sent = r.prompt?.length ?? 0
    const reply = result.response?.length ?? 0
    const ledgers = (this.store.data.tokens ??= {})
    const entry: TokenEntry = { at: Date.now(), input: estimateTokens(context + sent), output: estimateTokens(reply) }
    ledgers[r.instanceId] = addTokens(ledgers[r.instanceId], entry)
    if (thread) thread.contextChars = context + sent + reply
    return entry
  }
  stop(): void { this.stopping = true; clearTimeout(this.keeper); clearInterval(this.keeper); clearTimeout(this.refresher); clearInterval(this.refresher); for (const controller of this.controllers.values()) controller.abort() }
}
