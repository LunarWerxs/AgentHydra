import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ServerContext } from '../src/context'
import type { FreeInstance, FreeRequest, FreeUsage } from '../../shared/free-instances'
import { nudgeDue } from '../src/free-instances/keepalive'
import { type FreeRead, nextRead } from '../src/free-instances/refresh'
import { addTokens, tokenWindows } from '../src/free-instances/tokens'
import { commandArgs, type FreeRunner, type FreeRunRequest, type RunOutput } from '../src/free-instances/runner'
import { parseResult } from '../src/free-instances/results'
import { FreeInstances, validateRequest } from '../src/free-instances/service'
import plugin from '../src/plugins/55-free-instances'
import { nodeDependenciesReady, type FreeRuntime } from '../src/free-instances/runtime'
import { FreeStorage } from '../src/free-instances/storage'

const dirs: string[] = []
const services: FreeInstances[] = []
afterEach(() => { services.splice(0).forEach(s => s.stop()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const CHAT = '11111111-2222-4333-8444-555555555555'
const INSTANCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const output = (value: unknown, code = 0): RunOutput => ({ code, stdout: JSON.stringify(value) })
const operation = (fields: Partial<FreeRequest> = {}): FreeRequest => ({ requestId: crypto.randomUUID(), instanceId: INSTANCE, provider: 'claude', command: 'auth', ...fields })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function fixture(runner: FreeRunner = async () => output({ ok: true, authenticated: true })) {
  const home = mkdtempSync(join(tmpdir(), 'desk-free-'))
  dirs.push(home)
  writeFileSync(join(home, 'desk_entry.py'), '# fixture')
  const python = join(home, 'python.exe')
  writeFileSync(python, '')
  const runtime: FreeRuntime = { ready: () => true, ensure: async () => {}, config: id => ({ harnessDir: home, python, stateDir: join(home, 'free', 'instances', id), cacheDir: join(home, 'cache') }) }
  const service = new FreeInstances(home, runner, runtime)
  services.push(service)
  const instance = service.create({ provider: 'claude', name: 'Example account' })
  const config = runtime.config(instance.id)
  const op = (fields: Partial<FreeRequest> = {}) => operation({ instanceId: instance.id, ...fields })
  const app = new Hono()
  plugin(app, { home, deps: { freeInstances: service }, onStop: () => {} } as unknown as ServerContext)
  return { home, config, service, app, instance, op, runtime }
}

describe('Free instance boundary', () => {
  test('runtime setup rejects links outside its readable dependency directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-free-node-')); dirs.push(home)
    const external = join(home, 'global-store', 'happy-dom')
    const runtime = join(home, 'runtime')
    mkdirSync(join(external, 'lib'), { recursive: true })
    writeFileSync(join(external, 'package.json'), JSON.stringify({ version: '20.14.5' }))
    writeFileSync(join(external, 'lib', 'index.js'), 'export class Window {}')
    mkdirSync(join(runtime, 'node_modules'), { recursive: true })
    symlinkSync(external, join(runtime, 'node_modules', 'happy-dom'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(nodeDependenciesReady(runtime)).toBe(false)
    expect(nodeDependenciesReady(join(home, 'global-store'))).toBe(false)
    unlinkSync(join(runtime, 'node_modules', 'happy-dom'))
    const local = join(runtime, 'node_modules', 'happy-dom')
    mkdirSync(join(local, 'lib'), { recursive: true })
    writeFileSync(join(local, 'package.json'), JSON.stringify({ version: '20.14.5' }))
    writeFileSync(join(local, 'lib', 'index.js'), 'export class Window {}')
    expect(nodeDependenciesReady(runtime)).toBe(true)
  })

  // The harness has no browser transport any more (2026-10-06): HTTP is its only way to chat, so no flag picks it.
  test('sends multiline Unicode only on stdin, as an Incognito chat', () => {
    const { config } = fixture()
    const args = commandArgs(config, operation({ command: 'chat', prompt: 'π\n$(not-a-command)', name: 'local name' }))
    expect(args).toContain('--stdin')
    expect(args).not.toContain('--prompt')
    expect(args.join(' ')).not.toContain('not-a-command')
    expect(args).not.toContain('--regular')
    expect(args[args.indexOf('--name') + 1]).toMatch(/^desk-[a-f0-9]{24}$/)
    // desk_entry prints sign-in's JSON itself; the harness refuses --json and --brief with login, which once failed
    // every sign-in from Desk before a browser opened.
    expect(commandArgs(config, operation({ command: 'login' })).slice(1)).toEqual(['login', '--provider', 'claude', '--timeout', '900'])
    // The harness's parser refuses --json with forget, which would turn every log out into a failure.
    expect(commandArgs(config, { ...operation(), command: 'forget', provider: 'chatgpt' }).slice(1)).toEqual(['forget', '--provider', 'chatgpt', '--request-timeout', '120'])
  })

  test.each([
    { provider: 'other' }, { command: 'forget' }, { requestId: ['11111111-2222-4333-8444-555555555555'] },
    { instanceId: '../another-account' }, { instanceId: undefined },
    { command: 'resume', chatId: 'last', prompt: 'hello' }, { command: 'read', chatId: '--regular' },
    { command: 'chat', prompt: ' ' }, { command: 'chat', prompt: 'x'.repeat(100_001) },
    { command: 'chat', prompt: 'hello', regular: true }, { command: 'chat', prompt: 'hello', transport: 'browser' },
    { provider: 'chatgpt', command: 'chat', prompt: 'hello', webSearch: true },
    { command: 'track', chatId: CHAT }, { command: 'auth', prompt: 'hello' },
  ])('refuses invalid or unsupported options', fields => {
    expect(() => validateRequest({ ...operation(), ...fields })).toThrow()
  })

  test('auth and chat lists never expose raw session/account fields', () => {
    const secret = { token: 'fake-secret', email: 'example@example.test', cookie: 'fixture', organization_id: CHAT }
    const auth = parseResult('auth', output({ ok: true, authenticated: true, ...secret }))
    expect(auth).toEqual({ ok: true, authenticated: true, account_label: null })
    const chats = parseResult('chats', output({ ok: true, chats: [
      { chat_id: CHAT, is_temporary: true, name: 'private', ...secret },
      { chat_id: 'regular', is_temporary: false },
    ] }))
    expect(chats.chats).toHaveLength(1)
    expect(JSON.stringify(chats)).not.toContain('fake-secret')
    expect(JSON.stringify(chats)).not.toContain('example.test')
  })

  test('private reads expose code and safe citations, refuse unconfirmed privacy', () => {
    const input = { ok: true, chat_id: CHAT, is_temporary: true, messages: [{ role: 'assistant', text: 'A reply',
      code_blocks: [{ language: 'python', code: 'print(1)' }], citations: [{ url: 'javascript:alert(1)' }, { url: 'https://example.invalid/source', title: 'Source' }] }] }
    const result = parseResult('read', output(input))
    expect(result.messages?.[0]?.code_blocks[0]?.code).toBe('print(1)')
    expect(result.messages?.[0]?.citations).toHaveLength(1)
    expect(parseResult('read', output({ ...input, is_temporary: false })).error?.code).toBe('privacy_mismatch')
    expect(parseResult('read', output({ ...input, is_temporary: undefined })).messages).toBeUndefined()
  })

  test('unknown usage stays unknown; historical readings and reset markers survive', () => {
    const missing = parseResult('usage', output({ ok: true, available: false, exact_remaining_messages: null, windows: [] }))
    expect(missing.usage?.available).toBe(false)
    expect(missing.usage?.windows).toEqual([])
    const historical = parseResult('usage', output({ ok: true, available: true, is_snapshot: true,
      observed_at: '2026-01-01T00:00:00Z', windows: [{ id: 'window', used_percent: null, remaining_percent: null, reset_passed: true }] }))
    expect(historical.usage?.is_snapshot).toBe(true)
    expect(historical.usage?.windows[0]?.remaining_percent).toBeNull()
    expect(historical.usage?.windows[0]?.reset_passed).toBe(true)
  })

  test('a verified unlimited text policy has no invented percentage or message count', () => {
    const policy = parseResult('usage', output({ ok: true, available: true, unlimited_text: true,
      text_model: 'GPT-5.6 Luna', windows: [], exact_remaining_messages: null, token: 'fake-secret' }))
    expect(policy.usage?.unlimited_text).toBe(true)
    expect(policy.usage?.text_model).toBe('GPT-5.6 Luna')
    expect(policy.usage?.windows).toEqual([])
    expect(JSON.stringify(policy)).not.toContain('fake-secret')
    expect(parseResult('usage', output({ ok: true, available: false, unlimited_text: true })).usage?.unlimited_text).toBe(false)
  })

  test('malformed output and login logs are not forwarded, errors retain recovery UUID', () => {
    expect(JSON.stringify(parseResult('chat', { code: 1, stdout: 'cookie=fake-secret\ntraceback' }))).not.toContain('fake-secret')
    expect(parseResult('login', { code: 0, stdout: 'private local path and diagnostics' }).ok).toBe(false)
    expect(parseResult('login', output({ ok: true, authenticated: true, token: 'fake-secret' }))).toEqual({ ok: true, authenticated: true, account_label: null })
    expect(parseResult('resume', output({ ok: false, error: { code: 'timeout', message: 'Read first', chat_id: CHAT, raw: 'private' } }, 1))).toEqual({ ok: false, error: { code: 'timeout', message: 'Read first', chat_id: CHAT } })
  })
})

describe('Free jobs and routes', () => {
  test('a duplicate send shares its job, another send is blocked, separate accounts can run independently', async () => {
    const calls: FreeRunRequest[] = []
    const release: ((output: RunOutput) => void)[] = []
    const { service, op } = fixture(async (_c, request) => { calls.push(request); return new Promise(resolve => release.push(resolve)) })
    const request = op({ command: 'chat', prompt: 'synthetic prompt' })
    const job = service.start(request)
    expect(service.start(request)).toBe(job)
    expect(() => service.start({ ...request, prompt: 'changed' })).toThrow('another operation')
    expect(() => service.start(op())).toThrow('already has an operation')
    const other = service.create({ provider: 'claude', name: 'Another account' })
    service.start(op({ instanceId: other.id, command: 'chat', prompt: 'another prompt' }))
    await tick()
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(service.status())).not.toContain('synthetic prompt')
    release.forEach(done => done(output({ ok: true, chat_id: CHAT, is_temporary: true, response: 'Synthetic reply' })))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.get(job.id).state).toBe('done')
    expect(service.start(request)).toBe(job)
    expect(calls).toHaveLength(2)
  })

  test('only metadata is persisted; restarting does not replay a send', async () => {
    let calls = 0
    const { service, home, op, runtime } = fixture(async () => { calls++; return output({ ok: true, chat_id: CHAT, is_temporary: true, response: 'Synthetic reply' }) })
    const job = service.start(op({ command: 'chat', prompt: 'synthetic prompt' }))
    await tick()
    const stored = readFileSync(join(home, 'free', 'accounts.json'), 'utf8')
    expect(stored).not.toContain('synthetic prompt')
    expect(stored).not.toContain('Synthetic reply')
    const restarted = new FreeInstances(home, undefined, runtime)
    services.push(restarted)
    expect(restarted.status().ready).toBe(true)
    expect(restarted.threads()[0]?.chatId).toBe(CHAT)
    expect(() => restarted.get(job.id)).toThrow('read the chat')
    expect(calls).toBe(1)
  })

  test('unexpected runner errors become recoverable, sanitized failures without retry', async () => {
    let calls = 0
    const { service, op } = fixture(async () => { calls++; throw new Error('raw token=fake-secret') })
    const job = service.start(op({ command: 'resume', chatId: CHAT, prompt: 'synthetic prompt' }))
    await tick()
    expect(job.result?.error?.chat_id).toBe(CHAT)
    expect(JSON.stringify(job)).not.toContain('fake-secret')
    expect(calls).toBe(1)
  })

  test('instances are isolated and callers cannot configure paths or override their provider', async () => {
    const paths: string[] = []
    const { service, op, instance } = fixture(async c => { paths.push(c.stateDir); return output({ ok: true, chats: [] }) })
    expect(() => service.create({ provider: 'claude', name: 'Example', stateDir: '../escape' })).toThrow()
    expect(() => service.start(op({ provider: 'chatgpt' }))).toThrow('does not match')
    expect(() => service.start(op({ instanceId: CHAT }))).toThrow('not found')
    const other = service.create({ provider: 'claude', name: 'Other' })
    service.start(op({ command: 'chats' }))
    service.start(op({ command: 'chats', instanceId: other.id }))
    await tick()
    expect(paths[0]).toEndWith(instance.id)
    expect(paths[1]).toEndWith(other.id)
    expect(paths[0]).not.toBe(paths[1])
    expect(JSON.stringify(service.status())).not.toContain('stateDir')
    service.rename(other.id, { name: 'Renamed account' })
    expect(service.status().instances[1]?.name).toBe('Renamed account')
  })

  test('own-page guard rejects another local port and cross-site provenance', async () => {
    const { app } = fixture()
    const origins: Record<string, string>[] = [
      { host: '127.0.0.1:7798', origin: 'http://127.0.0.1:9000' },
      { host: '127.0.0.1:7798', origin: 'null' },
      { host: '127.0.0.1:7798', 'sec-fetch-site': 'cross-site' },
    ]
    for (const headers of origins) expect((await app.request('http://127.0.0.1:7798/api/free/status', { headers })).status).toBe(403)
    const response = await app.request('http://127.0.0.1:7798/api/free/status', { headers: { host: '127.0.0.1:7798', origin: 'http://127.0.0.1:7798' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  test('routes return structured validation and not-found errors; no arbitrary CLI commands', async () => {
    const { app, op } = fixture()
    const invalid = await app.request('/api/free/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op({ command: 'forget' as 'auth' })) })
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error).toContain('supported')
    expect((await app.request('/api/free/jobs/missing')).status).toBe(404)
    expect((await app.request('/api/free/config', { method: 'PUT' })).status).toBe(404)
    const valid = await app.request('/api/free/jobs', { method: 'POST', body: JSON.stringify(op()) })
    expect(valid.status).toBe(202)
    expect((await valid.json()).provider).toBe('claude')
  })
  test('verified auth imports only private handles and preserves honest quota', async () => {
    const { service, op, instance } = fixture(async (_c, r) => output(r.command === 'auth' ? { ok: true, authenticated: true } : r.command === 'chats' ? { ok: true, chats: [
      { chat_id: CHAT, is_temporary: true, name: 'Example private chat' }, { chat_id: INSTANCE, is_temporary: false, name: 'Regular chat' },
    ] } : { ok: true, available: false, windows: [] }))
    service.start(op())
    await tick()
    expect(instance.loggedIn).toBe(true)
    expect(instance.checkedAt).not.toBeNull()
    expect(instance.usage?.available).toBe(false)
    expect(service.threads().map(t => t.chatId)).toEqual([CHAT])
  })
  test('friendly chat names survive read and registry refresh', async () => {
    const { service, op } = fixture(async (_c, r) => output(r.command === 'chats'
      ? { ok: true, chats: [{ chat_id: CHAT, name: 'desk-opaque-alias', is_temporary: true }] }
      : { ok: true, chat_id: CHAT, chat_name: 'desk-opaque-alias', is_temporary: true, response: 'Example response' }))
    const job = service.start(op({ command: 'chat', name: 'A friendly chat name!', prompt: 'Example prompt' }))
    await tick()
    expect(job.result?.chat_name).toBe('A friendly chat name!')
    service.start(op({ command: 'chats' })); await tick()
    const read = service.start(op({ command: 'read', chatId: CHAT })); await tick()
    expect(read.result?.chat_name).toBe('A friendly chat name!')
    expect(service.threads()[0]?.title).toBe('A friendly chat name!')
  })
  test('a chat-list refresh (after every login check) leaves when each thread was last used', async () => {
    const { service, op } = fixture(async (_c, r) => output(r.command === 'chats'
      ? { ok: true, chats: [{ chat_id: CHAT, is_temporary: true, name: 'Example chat' }] }
      : { ok: true, chat_id: CHAT, is_temporary: true, response: 'Example reply' }))
    service.start(op({ command: 'chat', prompt: 'Example prompt' })); await tick()
    const used = service.threads()[0]!.updatedAt
    await Bun.sleep(5)
    service.start(op({ command: 'chats' })); await tick()
    expect(service.threads()[0]!.updatedAt).toBe(used)
  })
  test('cancel interrupts an owned operation and never retries it', async () => {
    let calls = 0
    const { service, op } = fixture(async (_c, _r, signal) => {
      calls++
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const job = service.start(op({ command: 'resume', chatId: CHAT, prompt: 'Example prompt' }))
    await tick()
    service.cancel(job.id)
    await tick()
    expect(job.result?.error?.code).toBe('operation_interrupted')
    expect(service.threads()[0]?.status).toBe('failed')
    expect(calls).toBe(1)
  })
  test('log out runs the harness forget for that account, keeps it signed in when forget fails, and is refused while an operation runs', async () => {
    let release: (value: RunOutput) => void = () => {}
    const forgets: FreeRunRequest[] = []
    let forgetCode = 1
    const { service, app, op, instance } = fixture(async (_c, r) => {
      if (r.command === 'forget') { forgets.push(r); return { code: forgetCode, stdout: 'Saved web session removed.' } }
      return r.command !== 'chat' ? output(r.command === 'auth' ? { ok: true, authenticated: true } : r.command === 'chats' ? { ok: true, chats: [] } : { ok: true, available: false, windows: [] }) : new Promise(resolve => { release = resolve })
    })
    service.start(op()); await tick()
    expect(instance.loggedIn).toBe(true)
    expect(instance.lastSignedInAt).not.toBeNull()
    service.start(op({ command: 'chat', prompt: 'Example prompt' })); await tick()
    expect((await app.request(`/api/free/instances/${instance.id}/logout`, { method: 'POST' })).status).toBe(409)
    expect(forgets).toHaveLength(0)
    release(output({ ok: true, chat_id: CHAT, is_temporary: true, response: 'Example reply' })); await tick()
    expect((await app.request(`/api/free/instances/${instance.id}/logout`, { method: 'POST' })).status).toBe(503)
    expect(instance.loggedIn).toBe(true)
    forgetCode = 0
    const done = await app.request(`/api/free/instances/${instance.id}/logout`, { method: 'POST' })
    expect(done.status).toBe(200)
    expect((await done.json()).loggedIn).toBe(false)
    expect(instance.usage).toBeNull()
    expect(instance.lastSignedInAt).toBeNull()
    expect(forgets.map(f => [f.instanceId, f.provider])).toEqual([[instance.id, 'claude'], [instance.id, 'claude']])
    expect((await app.request(`/api/free/instances/${CHAT}/logout`, { method: 'POST' })).status).toBe(404)
  })
  test('an instance made without a name takes the account name at sign-in; a renamed one keeps its name', async () => {
    let label = 'Example Owner'
    const { service, op } = fixture(async (_c, r) => output(r.command === 'auth' ? { ok: true, authenticated: true, account_label: label } : r.command === 'chats' ? { ok: true, chats: [] } : { ok: true, available: false, windows: [] }))
    const auto = service.create({ provider: 'claude' })
    expect([auto.name, auto.autoName]).toEqual(['Claude', true])
    service.start(op({ instanceId: auto.id })); await tick()
    expect(auto.name).toBe('Example Owner')
    const named = service.create({ provider: 'claude', name: 'Mine' })
    label = 'Someone Else'
    service.start(op({ instanceId: auto.id })); await tick()
    expect(auto.name).toBe('Someone Else')
    service.start(op({ instanceId: named.id })); await tick()
    expect(named.name).toBe('Mine')
    service.rename(auto.id, { name: 'Renamed' })
    label = 'Third Name'
    service.start(op({ instanceId: auto.id })); await tick()
    expect(auto.name).toBe('Renamed')
  })
  test('delete removes the account, its chats and state folder, runs forget, and is refused while an operation runs', async () => {
    let release: (value: RunOutput) => void = () => {}
    const forgets: FreeRunRequest[] = []
    const { service, app, op, instance, config } = fixture(async (_c, r) => {
      if (r.command === 'forget') { forgets.push(r); return { code: 0, stdout: 'removed' } }
      if (r.command === 'chat') return new Promise(resolve => { release = resolve })
      return output(r.command === 'chats' ? { ok: true, chats: [{ chat_id: CHAT, is_temporary: true, name: 'Example chat' }] } : r.command === 'auth' ? { ok: true, authenticated: true } : { ok: true, available: false, windows: [] })
    })
    service.start(op()); await tick()
    expect(service.threads()).toHaveLength(1)
    expect(existsSync(config.stateDir)).toBe(true)
    service.start(op({ command: 'chat', prompt: 'Example prompt' })); await tick()
    expect((await app.request(`/api/free/instances/${instance.id}`, { method: 'DELETE' })).status).toBe(409)
    release(output({ ok: true, chat_id: CHAT, is_temporary: true, response: 'Example reply' })); await tick()
    expect((await app.request(`/api/free/instances/${instance.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(service.status().instances).toEqual([])
    expect(service.threads()).toEqual([])
    expect(existsSync(config.stateDir)).toBe(false)
    expect(forgets.map(f => f.instanceId)).toEqual([instance.id])
    expect(service.syncHost().deleted().map(d => d.id)).toEqual([instance.id])
    expect((await app.request(`/api/free/instances/${CHAT}`, { method: 'DELETE' })).status).toBe(404)
  })
  test('settings start at the defaults, persist, and refuse unknown keys and out-of-range floors', async () => {
    const { service, home, runtime } = fixture()
    expect(service.settings()).toEqual({ keepWindows: false, weeklyFloorPct: 85 })
    expect(service.updateSettings({ keepWindows: true, weeklyFloorPct: 70 })).toEqual({ keepWindows: true, weeklyFloorPct: 70 })
    const again = new FreeInstances(home, undefined, runtime)
    services.push(again)
    expect(again.settings()).toEqual({ keepWindows: true, weeklyFloorPct: 70 })
    for (const bad of [{ other: 1 }, { weeklyFloorPct: 0 }, { weeklyFloorPct: 101 }, { weeklyFloorPct: 50.5 }, { keepWindows: 'yes' }, null]) expect(() => service.updateSettings(bad)).toThrow()
    expect(service.settings().weeklyFloorPct).toBe(70)
  })
  test('nudgeDue follows the CLI keepalive rules', () => {
    const NOW = Date.parse('2026-10-06T12:00:00Z')
    const window = (id: string, used: number, resets: string | null) => ({ id, used_percent: used, remaining_percent: 100 - used, resets_at: resets, reset_passed: false })
    const future = '2026-10-06T15:00:00Z'
    const past = '2026-10-06T09:00:00Z'
    const usage = (windows: ReturnType<typeof window>[]): FreeUsage => ({ available: true, is_snapshot: false, observed_at: null, note: '', windows })
    const base: FreeInstance = { id: INSTANCE, num: 1, provider: 'claude', name: 'Example', autoName: false, loggedIn: true, checkedAt: null, lastSignedInAt: null, lastActiveAt: null, usage: usage([window('five_hour', 0, null), window('seven_day', 10, future)]) }
    const on = { keepWindows: true, weeklyFloorPct: 85 }
    const hour = 3_600_000
    const cases: [string, Partial<FreeInstance>, Partial<typeof on>, boolean][] = [
      ['idle and signed in', {}, {}, true],
      ['switched off', {}, { keepWindows: false }, false],
      ['ChatGPT', { provider: 'chatgpt' }, {}, false],
      ['signed out', { loggedIn: false }, {}, false],
      ['unreadable reading', { usage: null }, {}, false],
      ['five-hour window running', { usage: usage([window('five_hour', 5, future)]) }, {}, false],
      ['five-hour window ended', { usage: usage([window('five_hour', 5, past)]) }, {}, true],
      ['weekly at the floor', { usage: usage([window('seven_day', 85, future)]) }, {}, false],
      ['weekly under a higher floor', { usage: usage([window('seven_day', 85, future)]) }, { weeklyFloorPct: 90 }, true],
      ['recent good nudge', { nudge: { at: NOW - hour, ok: true } }, {}, false],
      ['old good nudge', { nudge: { at: NOW - 6 * hour, ok: true } }, {}, true],
      ['recent failed nudge', { nudge: { at: NOW - 10 * 60_000, ok: false } }, {}, false],
      ['old failed nudge', { nudge: { at: NOW - 2 * hour, ok: false } }, {}, true],
    ]
    for (const [label, change, settings, due] of cases) expect([label, nudgeDue({ ...base, ...change }, { ...on, ...settings }, NOW)]).toEqual([label, due])
  })
  test('keepWindows nudges a signed-in Claude account then reads its usage, never adds a chat, and skips ChatGPT', async () => {
    const calls: string[] = []
    const { service, instance } = fixture(async (_c, r) => { calls.push(`${r.provider}:${r.command}`); return output(r.command === 'nudge' ? { ok: true, nudged: true } : { ok: true, available: true, windows: [] }) })
    const gpt = service.create({ provider: 'chatgpt', name: 'Example GPT' })
    for (const i of [instance, gpt]) { i.loggedIn = true; i.usage = { available: true, is_snapshot: false, observed_at: null, note: '', windows: [] } }
    service.updateSettings({ keepWindows: true })
    service.keepWindows()
    await tick(); await tick()
    expect(calls).toEqual(['claude:nudge', 'claude:usage'])
    expect(instance.nudge?.ok).toBe(true)
    expect(gpt.nudge).toBeUndefined()
    expect(service.threads()).toEqual([])
  })
  test("Desk's own read never turns a person away: their operation waits for it; a second one, or another of Desk's, is refused", async () => {
    const calls: string[] = []
    let release: (value: RunOutput) => void = () => {}
    const { service, op, instance } = fixture(async (_c, r) => {
      calls.push(r.command)
      if (calls.length === 1) return new Promise(resolve => { release = resolve })
      return output({ ok: true, chat_id: CHAT, is_temporary: true, response: 'Example reply' })
    })
    const auto = service.start(op({ command: 'usage' }), true)
    expect(service.status().jobs.find(j => j.id === auto.id)?.auto).toBe(true)
    expect(() => service.start(op({ command: 'usage' }), true)).toThrow('already has an operation')
    const chat = service.start(op({ command: 'chat', prompt: 'Example prompt' }))
    expect(() => service.start(op({ command: 'chats' }))).toThrow('already has an operation')
    await tick()
    expect(calls).toEqual(['usage'])
    release(output({ ok: true, available: true, windows: [] })); await tick(); await tick()
    expect(calls).toEqual(['usage', 'chat'])
    expect(service.get(chat.id).result?.ok).toBe(true)
    expect(instance.usageReadAt).toBeNumber()
  })
  test("a log out waits for Desk's own read instead of being refused", async () => {
    let release: (value: RunOutput) => void = () => {}
    const { service, app, op, instance } = fixture(async (_c, r) => r.command === 'usage' ? new Promise(resolve => { release = resolve }) : { code: 0, stdout: 'Saved web session removed.' })
    instance.loggedIn = true
    service.start(op({ command: 'usage' }), true); await tick()
    const out = app.request(`/api/free/instances/${instance.id}/logout`, { method: 'POST' })
    await tick()
    release(output({ ok: true, available: true, windows: [] }))
    expect((await out).status).toBe(200)
    expect(instance.loggedIn).toBe(false)
  })
  test('a check that fails on its own leaves the login as it was; only a login the site asks for signs it out', async () => {
    let reply = output({ ok: false, error: { code: 'network_error', message: 'Offline' } }, 1)
    const { service, op, instance } = fixture(async () => reply)
    instance.loggedIn = true
    service.start(op(), true); await tick()
    expect(instance.loggedIn).toBe(true)
    reply = output({ ok: false, error: { code: 'login_required', message: 'No saved login.' } }, 1)
    service.start(op(), true); await tick()
    expect(instance.loggedIn).toBe(false)
  })
  test('a login another PC shares, landing while a background check runs, is checked again after it', async () => {
    const answers: ((value: RunOutput) => void)[] = []
    const { service, op, instance } = fixture(async (_c, r) => r.command === 'auth' ? new Promise(resolve => answers.push(resolve)) : output({ ok: true, chats: [] }))
    service.start(op(), true); await tick()
    service.syncHost().landed(instance.id)
    answers.shift()!(output({ ok: false, error: { code: 'login_required', message: 'No saved login.' } }, 1)); await tick(); await tick()
    expect(answers).toHaveLength(1)
    answers.shift()!(output({ ok: true, authenticated: true })); await tick(); await tick()
    expect(instance.loggedIn).toBe(true)
  })
  test('the rolling refresh starts its read as Desk\'s own, and tries an account at most once in 15 minutes', async () => {
    const { service, runtime } = fixture()
    // Setup failing records nothing on the account, so it stays never-checked and due on every tick.
    runtime.ensure = async () => { throw new Error('setup') }
    service.refreshNext(); await tick()
    service.refreshNext(); await tick()
    const jobs = service.status().jobs
    expect(jobs.map(j => [j.command, j.auto])).toEqual([['auth', true]])
    expect(service.get(jobs[0]!.id).result?.error?.code).toBe('setup_failed')
  })
  test('the Tokens column counts what each message sent, the thread it continues included, and its reply; counts only', async () => {
    const { service, op, instance, home, runtime } = fixture(async (_c, r) => output(r.command === 'read'
      ? { ok: true, chat_id: CHAT, is_temporary: true, messages: [{ id: 'm1', role: 'user', text: 'x'.repeat(400), code_blocks: [], citations: [] }] }
      : { ok: true, chat_id: CHAT, is_temporary: true, response: 'r'.repeat(80) }))
    const total = () => service.status().tokens?.[instance.id]?.total
    expect(total()).toBeUndefined()
    service.start(op({ command: 'chat', prompt: 'p'.repeat(40) })); await tick()
    expect(total()).toEqual({ input: 10, output: 20, total: 30 })
    // The continuation sends the 120 characters the thread holds, plus its own 40.
    service.start(op({ command: 'resume', chatId: CHAT, prompt: 'p'.repeat(40) })); await tick()
    expect(total()).toEqual({ input: 50, output: 40, total: 90 })
    // A read gives the thread's real length (400), so the next continuation counts that.
    service.start(op({ command: 'read', chatId: CHAT })); await tick()
    service.start(op({ command: 'resume', chatId: CHAT, prompt: 'p'.repeat(40) })); await tick()
    expect(total()).toEqual({ input: 160, output: 60, total: 220 })
    const now = service.status().tokens![instance.id]!
    expect([now.fiveHour, now.week]).toEqual([now.total, now.total])
    expect(readFileSync(join(home, 'free', 'accounts.json'), 'utf8')).not.toMatch(/ppp|rrr|xxx/)
    const again = new FreeInstances(home, async () => output({}), runtime); services.push(again)
    expect(again.status().tokens?.[instance.id]?.total.total).toBe(220)
    await again.remove(instance.id)
    expect(again.status().tokens).toEqual({})
  })
  test('token windows cut where the account\'s own windows do: at a reset ahead or just passed, else rolling', () => {
    const NOW = Date.parse('2026-10-06T12:00:00Z')
    const hour = 3_600_000
    // Distinct powers of two, so a sum names exactly which messages a window holds.
    const ledger = { entries: [[1, 1], [4, 2], [6, 4], [72, 8]].map(([ago, n]) => ({ at: NOW - ago! * hour, input: n!, output: 0 })), total: { input: 99, output: 1 } }
    const usage = (fiveHour: number | null, week: number | null): FreeUsage => ({ available: true, is_snapshot: false, observed_at: null, note: '', windows: [
      { id: 'five_hour', used_percent: 1, remaining_percent: 99, resets_at: fiveHour == null ? null : new Date(NOW + fiveHour * hour).toISOString(), reset_passed: false },
      { id: 'seven_day', used_percent: 1, remaining_percent: 99, resets_at: week == null ? null : new Date(NOW + week * hour).toISOString(), reset_passed: false },
    ] })
    const cases: [string, FreeUsage | null, number, number][] = [
      ['no reading: the last 5 hours and 7 days', null, 1 + 2, 1 + 2 + 4 + 8],
      ['resets ahead: from the reset minus the span', usage(2, 24), 1, 1 + 2 + 4 + 8],
      ['a 5-hour reset 2 hours ago: from the reset', usage(-2, 24 * 5), 1, 1 + 2 + 4],
      ['a reset over a span ago: rolling again', usage(-10, -24 * 8), 1 + 2, 1 + 2 + 4 + 8],
    ]
    for (const [label, u, fiveHour, week] of cases) {
      const w = tokenWindows(ledger, u, NOW)
      expect([label, w.fiveHour.input, w.week.input, w.total]).toEqual([label, fiveHour, week, { input: 99, output: 1, total: 100 }])
    }
    // A message leaves the ledger once no window can reach it; the all-time sum keeps it.
    const later = addTokens(ledger, { at: NOW + 5 * 24 * hour, input: 16, output: 0 })
    expect([later.entries.map(e => e.input), later.total.input]).toEqual([[1, 2, 4, 16], 115])
  })
  test('the rolling refresh reads the most overdue account: a never-checked login first, then old logins and old Claude usage', () => {
    const NOW = Date.parse('2026-10-06T12:00:00Z')
    const min = 60_000
    const base: FreeInstance = { id: 'a', num: 1, provider: 'claude', name: 'A', autoName: false, loggedIn: true, checkedAt: NOW - 10 * min, lastSignedInAt: NOW - 10 * min, lastActiveAt: null, usage: null, usageReadAt: NOW - 10 * min }
    const one = (change: Partial<FreeInstance>, busy = false) => nextRead([{ ...base, ...change }], () => busy, NOW)
    const cases: [string, ReturnType<typeof one>, FreeRead | null][] = [
      ['fresh', one({}), null],
      ['usage read 20 minutes ago', one({ usageReadAt: NOW - 20 * min }), { id: 'a', command: 'usage' }],
      ['older record: usage goes by the last check', one({ usageReadAt: undefined, checkedAt: NOW - 20 * min }), { id: 'a', command: 'usage' }],
      ['login checked 70 minutes ago', one({ checkedAt: NOW - 70 * min, usageReadAt: NOW - min }), { id: 'a', command: 'auth' }],
      ['never checked', one({ checkedAt: null, loggedIn: false }), { id: 'a', command: 'auth' }],
      ['signed out after a check', one({ loggedIn: false, checkedAt: NOW - 600 * min, usageReadAt: null }), null],
      ['ChatGPT usage is not read between checks', one({ provider: 'chatgpt', usageReadAt: NOW - 50 * min }), null],
      ['busy', one({ usageReadAt: NOW - 50 * min }, true), null],
    ]
    for (const [label, got, want] of cases) expect([label, got]).toEqual([label, want])
    const many = [{ ...base, id: 'b', usageReadAt: NOW - 20 * min }, { ...base, id: 'c', usageReadAt: NOW - 40 * min }, { ...base, id: 'd', checkedAt: null }]
    expect(nextRead(many, () => false, NOW)?.id).toBe('d')
    expect(nextRead(many.slice(0, 2), () => false, NOW)?.id).toBe('c')
  })
  test('legacy migration copies encrypted state into isolated homes once, without removing its source', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-free-migrate-')); dirs.push(home)
    const legacy = join(home, 'old-harness')
    mkdirSync(join(legacy, '.state', 'chatgpt'), { recursive: true })
    writeFileSync(join(legacy, '.state', 'session.dpapi'), 'opaque encrypted fixture')
    writeFileSync(join(legacy, '.state', 'chatgpt', 'session.dpapi'), 'another encrypted fixture')
    writeFileSync(join(legacy, '.state', 'requests.json'), 'unneeded diagnostic')
    writeFileSync(join(home, 'free-instances.json'), JSON.stringify({ harnessDir: legacy }))
    const migrated = new FreeStorage(home)
    expect(migrated.data.instances.map(i => i.provider)).toEqual(['claude', 'chatgpt'])
    const [claude, gpt] = migrated.data.instances
    expect(readFileSync(join(home, 'free', 'instances', claude!.id, 'session.dpapi'), 'utf8')).toBe('opaque encrypted fixture')
    expect(readFileSync(join(home, 'free', 'instances', gpt!.id, 'chatgpt', 'session.dpapi'), 'utf8')).toBe('another encrypted fixture')
    expect(existsSync(join(home, 'free', 'instances', claude!.id, 'requests.json'))).toBe(false)
    expect(existsSync(join(legacy, '.state', 'session.dpapi'))).toBe(true)
    expect(new FreeStorage(home).data.instances.map(i => i.id)).toEqual(migrated.data.instances.map(i => i.id))
  })
})
