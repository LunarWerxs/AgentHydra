import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ServerContext } from '../src/context'
import type { FreeRequest } from '../../shared/free-instances'
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

  test('sends multiline Unicode only on stdin, uses HTTP and never opens Desktop', () => {
    const { config } = fixture()
    const args = commandArgs(config, operation({ command: 'chat', prompt: 'π\n$(not-a-command)', name: 'local name' }))
    expect(args).toContain('--stdin')
    expect(args).not.toContain('--prompt')
    expect(args.join(' ')).not.toContain('not-a-command')
    expect(args).toContain('http')
    expect(args).not.toContain('--regular')
    expect(args[args.indexOf('--name') + 1]).toMatch(/^desk-[a-f0-9]{24}$/)
    // desk_entry prints sign-in's JSON itself; the harness refuses --json and --brief with login, which once failed
    // every sign-in from Desk before a browser opened.
    expect(commandArgs(config, operation({ command: 'login' })).slice(1)).toEqual(['login', '--provider', 'claude', '--no-desktop', '--timeout', '900'])
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
    expect(auth).toEqual({ ok: true, authenticated: true })
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
    expect(parseResult('login', output({ ok: true, authenticated: true, token: 'fake-secret' }))).toEqual({ ok: true, authenticated: true })
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
