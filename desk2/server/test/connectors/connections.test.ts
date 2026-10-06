// plugins/56-connections.ts and connectors/connections-client.ts against a fake Connections loader that speaks MCP
// over stdio: the workspace of a chat (its pin, else its folder's), the list, the switch per scope, the 409 before a
// chat has a session, the environment the child was given, and sign-in.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONNECTIONS_COMPANIES, CONNECTIONS_SIGNIN, CONNECTIONS_SWITCH, CONNECTIONS_WORKSPACE } from '@shared/connectors'
import { createServer, type DeskServer } from '../../src/index'
import defFactory from '../../src/connectors/defs/connections'

const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '56-connections.ts')
const temps: string[] = []
const stops: (() => unknown)[] = []
const saved = { home: process.env.HYDRA_DESK_HOME, cfg: process.env.HYDRA_DESK_MAIN_CLAUDE_JSON }

const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  // Windows holds a folder until the killed fake loader that started in it has gone.
  for (const d of temps.splice(0)) {
    for (let i = 0; i < 40; i++) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch {
        await Bun.sleep(50)
      }
    }
  }
  for (const [k, v] of [['HYDRA_DESK_HOME', saved.home], ['HYDRA_DESK_MAIN_CLAUDE_JSON', saved.cfg]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// The fake loader keeps its state in <dir>/state.json and writes one line per tool call to <dir>/calls.jsonl.
const LOADER = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const dir = process.argv[2]
const state = () => (existsSync(dir + '/state.json') ? JSON.parse(readFileSync(dir + '/state.json', 'utf8')) : {})
const save = (s) => writeFileSync(dir + '/state.json', JSON.stringify(s))
const COMPANIES = [
  { companyId: 'c1', projectId: 'p1', name: 'Acme Example' },
  { companyId: 'c2', name: 'Globex Example' }
]
const tools = {
  connections_whoami: () => {
    const s = state()
    if (s.signedOut) return 'Sign in: https://studio.example.com/device?code=ABCD'
    return JSON.stringify({ identity: { signedIn: true }, registration: { workspace: 'w' }, company: s.folder ?? null, ...((s.pins?.[process.env.CLAUDE_CODE_SESSION_ID] ?? s.chatPin) ? { chatPin: s.pins?.[process.env.CLAUDE_CODE_SESSION_ID] ?? s.chatPin } : {}), ...('bypassPermissions' in s ? { bypassPermissions: s.bypassPermissions } : {}) }) + (s.note ? '\\n\\n' + s.note : '')
  },
  connections_list_companies: () => JSON.stringify({ companies: COMPANIES }),
  connections_use_workspace: (p) => {
    const s = state()
    // pins are kept per Claude session id, as Connections keeps them
    s.pins = { ...s.pins, [process.env.CLAUDE_CODE_SESSION_ID]: p.clear ? undefined : COMPANIES.find((c) => c.companyId === p.company) }
    save(s)
    return 'ok'
  },
  connections_switch_workspace: (p) => {
    const s = state()
    s.folder = COMPANIES.find((c) => c.companyId === p.company) ?? s.folder
    save(s)
    return 'ok'
  },
  connections_signin: () => 'Sign in to Connections - open this in your browser (I also opened it for you):\\n  https://studio.example.com/device?code=ABCD\\n\\nCode: ABCD'
}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  if (m.method !== 'tools/call') return
  const a = m.params.arguments
  appendFileSync(dir + '/calls.jsonl', JSON.stringify({ tool: a.tool_name, params: a.params, local: a.local, env: { CLAUDECODE: process.env.CLAUDECODE, dir: process.env.CLAUDE_PROJECT_DIR, session: process.env.CLAUDE_CODE_SESSION_ID ?? null } }) + '\\n')
  send({ id: m.id, result: { content: [{ type: 'text', text: tools[a.tool_name](a.params ?? {}) }] } })
})
`

interface Call {
  tool: string
  params: Record<string, unknown>
  local: boolean
  env: { CLAUDECODE: string; dir: string; session: string | null }
}

interface Rig {
  desk: DeskServer
  calls: () => Call[]
  state: (s: object) => void
}

// The chats' folders are real (the child starts in its chat's folder).
let CHATS: Record<string, { cwd: string; sessionId: string | null }> = {}

async function boot(): Promise<Rig> {
  CHATS = {
    withSession: { cwd: temp('desk-cx-proj-'), sessionId: 'sess-1' },
    noSession: { cwd: temp('desk-cx-other-'), sessionId: null },
    fourth: { cwd: temp('desk-cx-fourth-'), sessionId: null },
    third: { cwd: temp('desk-cx-third-'), sessionId: 'sess-3' }
  }
  // two chats in one folder, each with its own Claude session
  const shared = temp('desk-cx-shared-')
  CHATS.chatA = { cwd: shared, sessionId: 'sess-A' }
  CHATS.chatB = { cwd: shared, sessionId: 'sess-B' }
  const dir = temp('desk-cx-')
  writeFileSync(join(dir, 'loader.mjs'), LOADER)
  const cfg = join(dir, 'claude.json')
  writeFileSync(cfg, JSON.stringify({ mcpServers: { connections: { command: process.execPath, args: [join(dir, 'loader.mjs'), dir] } } }))
  const plugins = temp('desk-cx-plugins-')
  writeFileSync(join(plugins, '56-connections.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  // Stands in for the engine's GET /api/chats/:id.
  writeFileSync(
    join(plugins, '20-chats.ts'),
    `export default (app) => app.get('/api/chats/:id', (c) => { const t = (${JSON.stringify(CHATS)})[c.req.param('id')]; return t ? c.json(t) : c.json({ error: 'no' }, 404) })\n`
  )
  const home = temp('desk-cx-home-')
  process.env.HYDRA_DESK_HOME = home
  const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { mainClaudeJson: cfg } })
  stops.push(() => desk.stop())
  const calls = (): Call[] => {
    try {
      return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return { desk, calls, state: (s) => writeFileSync(join(dir, 'state.json'), JSON.stringify(s)) }
}

const get = async (r: Rig, path: string) => {
  const res = await fetch(`${r.desk.url}${path}`)
  return { status: res.status, body: await res.json() }
}
const post = async (r: Rig, path: string, body: object) => {
  const res = await fetch(`${r.desk.url}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return { status: res.status, body: await res.json() }
}

test("a chat with no pin acts as its folder's workspace, and the child got the chat's folder and session", async () => {
  const r = await boot()
  r.state({ folder: { companyId: 'c1', projectId: 'p1', name: 'Acme Example' } })
  const w = await get(r, `${CONNECTIONS_WORKSPACE}?chat=withSession`)
  expect(w.body).toEqual({ signedIn: true, company: { companyId: 'c1', projectId: 'p1', name: 'Acme Example' }, scope: 'folder', bypassPermissions: null })
  const [call] = r.calls()
  expect(call).toMatchObject({ tool: 'connections_whoami', local: true, env: { CLAUDECODE: '1', dir: CHATS.withSession.cwd, session: 'sess-1' } })
  // a second read inside 30 s is the cache's
  await get(r, `${CONNECTIONS_WORKSPACE}?chat=withSession`)
  expect(r.calls().length).toBe(1)
})

test('a chatPin wins over the folder; no workspace at all is null; a signed-out machine is signedIn false', async () => {
  const r = await boot()
  r.state({ folder: { companyId: 'c1', name: 'Acme Example' }, chatPin: { companyId: 'c2', name: 'Globex Example' } })
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=withSession`)).body).toEqual({ signedIn: true, company: { companyId: 'c2', name: 'Globex Example' }, scope: 'chat', bypassPermissions: null })
  r.state({})
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=noSession`)).body).toEqual({ signedIn: true, company: null, scope: null, bypassPermissions: null })
  r.state({ folder: { companyId: 'c1', name: 'Acme Example' }, note: 'A note after the JSON.' })
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=fourth`)).body.scope).toBe('folder')
  r.state({ signedOut: true })
  // (the earlier chats' answers are cached for 30 s, so a third chat reads it)
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=third`)).body).toEqual({ signedIn: false, company: null, scope: null, bypassPermissions: null })
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=nope`)).status).toBe(404)
})

test('the companies come back with the fields the chip needs', async () => {
  const r = await boot()
  const c = await get(r, `${CONNECTIONS_COMPANIES}?chat=withSession`)
  expect(c.body).toEqual({ companies: [{ companyId: 'c1', projectId: 'p1', name: 'Acme Example' }, { companyId: 'c2', name: 'Globex Example' }] })
})

test('switching this chat pins it and clears the pin; switching the folder uses the folder tool', async () => {
  const r = await boot()
  r.state({ folder: { companyId: 'c1', name: 'Acme Example' } })
  const pinned = await post(r, CONNECTIONS_SWITCH, { chat: 'withSession', company: 'c2', scope: 'chat' })
  expect(pinned.body).toEqual({ signedIn: true, company: { companyId: 'c2', name: 'Globex Example' }, scope: 'chat', bypassPermissions: null })
  expect(r.calls().find((c) => c.tool === 'connections_use_workspace')?.params).toEqual({ company: 'c2' })

  const cleared = await post(r, CONNECTIONS_SWITCH, { chat: 'withSession', company: null, scope: 'chat' })
  expect(cleared.body.scope).toBe('folder')
  expect(r.calls().filter((c) => c.tool === 'connections_use_workspace').at(-1)?.params).toEqual({ clear: true })

  const folder = await post(r, CONNECTIONS_SWITCH, { chat: 'noSession', company: 'c2', scope: 'folder' })
  expect(folder.body).toEqual({ signedIn: true, company: { companyId: 'c2', name: 'Globex Example' }, scope: 'folder', bypassPermissions: null })
  expect(r.calls().find((c) => c.tool === 'connections_switch_workspace')?.params).toEqual({ company: 'c2', remember: false })
  expect((await post(r, CONNECTIONS_SWITCH, { chat: 'noSession', company: null, scope: 'folder' })).status).toBe(400)
})

test('this chat alone cannot be switched before the chat has a Claude session: 409, and nothing was called', async () => {
  const r = await boot()
  const res = await post(r, CONNECTIONS_SWITCH, { chat: 'noSession', company: 'c2', scope: 'chat' })
  expect(res.status).toBe(409)
  expect(res.body.error).toContain('no Claude session')
  expect(r.calls().length).toBe(0)
})

test('sign-in answers the page to open, and says Connections already opened it', async () => {
  const r = await boot()
  expect((await post(r, CONNECTIONS_SIGNIN, { chat: 'withSession' })).body).toEqual({ url: 'https://studio.example.com/device?code=ABCD', opened: true, signedIn: false })
})

test('no Connections server in the config: 503 for the routes and the connector reads absent', async () => {
  const dir = temp('desk-cx-none-')
  const cfg = join(dir, 'claude.json')
  writeFileSync(cfg, JSON.stringify({ mcpServers: {} }))
  const plugins = temp('desk-cx-plugins-')
  writeFileSync(join(plugins, '56-connections.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  const home = temp('desk-cx-home-')
  const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { mainClaudeJson: cfg } })
  stops.push(() => desk.stop())
  expect((await fetch(`${desk.url}${CONNECTIONS_WORKSPACE}?chat=x`)).status).toBe(503)
  process.env.HYDRA_DESK_MAIN_CLAUDE_JSON = cfg
  expect((await defFactory({ home }).detect()).state).toBe('absent')
})

test('Bypass permissions is carried from whoami as a boolean; a missing or non-boolean field is null', async () => {
  const r = await boot()
  r.state({ bypassPermissions: true })
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=withSession`)).body.bypassPermissions).toBe(true)
  r.state({ bypassPermissions: false })
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=noSession`)).body.bypassPermissions).toBe(false)
  r.state({ bypassPermissions: 'yes' })
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=fourth`)).body.bypassPermissions).toBeNull()
  r.state({})
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=third`)).body.bypassPermissions).toBeNull()
})

test("'This chat' pins by the chat's own session id: chat A's pin leaves chat B in the same folder on the folder's workspace", async () => {
  const r = await boot()
  r.state({ folder: { companyId: 'c1', projectId: 'p1', name: 'Acme Example' } })
  const pinned = await post(r, CONNECTIONS_SWITCH, { chat: 'chatA', company: 'c2', scope: 'chat' })
  expect(pinned.body).toMatchObject({ company: { companyId: 'c2' }, scope: 'chat' })
  // the pin went out under A's session id, not B's
  const use = r.calls().find((c) => c.tool === 'connections_use_workspace')
  expect(use).toMatchObject({ params: { company: 'c2' }, env: { session: 'sess-A' } })
  // A reads its pin back; B, same folder, still reads the folder's workspace
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=chatA`)).body).toMatchObject({ company: { companyId: 'c2' }, scope: 'chat' })
  expect((await get(r, `${CONNECTIONS_WORKSPACE}?chat=chatB`)).body).toMatchObject({ company: { companyId: 'c1' }, scope: 'folder' })
})
