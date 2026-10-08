// Chat hosts end to end (bun run e2e:hosts; Windows): the real server as its own hidden process, the real chat
// host it starts through WMI, real Claude Code on one signed-in account, and one short turn that lives through
// two server restarts: a graceful one (POST /api/server/shutdown) while Claude's question waits for its answer
// (AskUserQuestion always comes to Desk; an account's settings may let Bash run unasked), and a hard one
// (taskkill /T /F on the server's whole tree) while the command it then runs is still sleeping. Prints PASS/FAIL
// per check with what it saw; exits 1 on any FAIL. Never prints an email, a token or the chat env.

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AccountInfo, ChatSummary, ServerEvent, TranscriptItem } from '../shared/protocol'
import { portFrom } from './lib/free-port'

const MODEL = process.env.E2E_MODEL || 'sonnet'
const PORT = portFrom(process.env.E2E_PORT)
const TURN_MS = 180_000
const DESK = resolve(import.meta.dir, '..')

const results: { ok: boolean; line: string }[] = []
function check(step: string, ok: boolean, what: string, seen: unknown): boolean {
  const line = `${ok ? 'PASS' : 'FAIL'} [${step}] ${what} :: ${typeof seen === 'string' ? seen : JSON.stringify(seen)}`
  results.push({ ok, line })
  console.log(line)
  return ok
}
const info = (s: string) => console.log(`     ${s}`)

// The server gets this process's env without the nested-session markers of whoever ran us and without any
// API key, so the account's own login is used.
const STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
const root = mkdtempSync(join(tmpdir(), 'hydra-desk-hosts-e2e-'))
process.on('exit', () => {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
})
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
const serverLog = join(root, 'server.log')
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.includes(k)) env[k] = v
env.HYDRA_DESK_HOME = home
env.HYDRA_DESK_PORT = String(PORT)
const base = `http://127.0.0.1:${PORT}`

// The server, as its own process

let server: ReturnType<typeof Bun.spawn> | null = null

async function startServer(): Promise<number> {
  const fd = openSync(serverLog, 'a')
  server = Bun.spawn([process.execPath, 'server/src/index.ts'], { cwd: DESK, env, stdout: fd, stderr: fd, windowsHide: true })
  closeSync(fd)
  await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok === true, 30_000, 'server health')
  return server.pid
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: (await res.json().catch(() => null)) as T }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(250)
  }
}

// Windows processes

interface Proc {
  pid: number
  ppid: number
  name: string
}

function procs(): Proc[] {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const list = JSON.parse(r.stdout) as { ProcessId: number; ParentProcessId: number; Name: string }[]
  return list.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name }))
}

function tree(all: Proc[], pid: number): Proc[] {
  const out: Proc[] = []
  const walk = (p: number) => {
    for (const c of all) {
      if (c.ppid === p && c.pid !== p && !out.some((o) => o.pid === c.pid)) {
        out.push(c)
        walk(c.pid)
      }
    }
  }
  walk(pid)
  return out
}

/** Processes of these pids that have a visible main window. */
function visibleWindows(pids: number[]): string[] {
  if (!pids.length) return []
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.ProcessName + ' ' + $_.Id }`], { encoding: 'utf8', windowsHide: true })
  return r.stdout.split(/\r?\n/).filter(Boolean)
}

const alive = (pid: number) => procs().some((p) => p.pid === pid)
const hostFile = (chatId: string) => join(home, 'hosts', `${chatId}.json`)

// The run

let hostPid = 0
let cliPids: number[] = []
try {
  // 1. An account: signed in, nobody on it, the most room left.
  await startServer()
  const accounts = (await api<AccountInfo[]>('GET', '/api/accounts')).body ?? []
  const free = accounts.filter((a) => a.id !== 'default' && a.signedIn && !a.inUse && a.fiveHourPct !== null && a.fiveHourPct < 80 && (a.weeklyPct ?? 100) < 90)
  free.sort((a, b) => (a.fiveHourPct ?? 100) - (b.fiveHourPct ?? 100))
  const acct = free[0]
  check('1 account', !!acct, `a signed-in account nobody uses (${free.length} of ${accounts.length} qualify)`, acct ? `#${acct.number} 5h ${acct.fiveHourPct}%` : 'none')
  if (!acct) throw new Error('no account to run on')
  await api('POST', '/api/server/shutdown', {})
  await server!.exited

  // A chat this server runs itself (not a CliMayte worker), stored as one from before workers.
  const chatId = randomUUID()
  const chat = {
    id: chatId,
    sessionId: null,
    title: 'Chat hosts e2e',
    cwd: work,
    account: { id: acct.id, label: acct.label, configDir: acct.configDir, number: acct.number },
    accountAuto: false,
    model: MODEL,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: false,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    costUsd: 0,
    contextPct: null,
  }
  writeFileSync(join(home, 'chats.json'), JSON.stringify([chat]))

  // 2. Server A: the turn starts and Claude asks its question.
  const a = await startServer()
  const sent = await api('POST', `/api/chats/${chatId}/messages`, {
    text: [
      'First use the AskUserQuestion tool to ask me one question: "Which color?" with the options Red and Blue.',
      // A Node timer, not sleep: a PreToolUse hook here may refuse a foreground sleep.
      `Once I answer, use the Bash tool to run exactly this command in the foreground (not in the background): node -e "setTimeout(() => console.log('slept-well'), 25000)"`,
      'Then reply with exactly the word DONE and nothing else.',
    ].join('\n'),
  })
  check('2 send', sent.status === 200, 'the message goes to the chat', sent.status)
  await waitFor(async () => (await api<ChatSummary>('GET', `/api/chats/${chatId}`)).body?.status === 'needs_you', TURN_MS, "Claude's question")
  const asked = (await api<TranscriptItem[]>('GET', `/api/chats/${chatId}/items`)).body.find((i) => i.kind === 'question' && i.state === 'pending')
  check('2 asks', asked?.kind === 'question', 'Claude asks its question', asked?.kind === 'question' ? `${asked.questions[0]?.question} ${asked.id}` : 'no question')
  if (asked?.kind !== 'question') throw new Error('no question')

  // 3. The host: outside the server's tree, Claude Code under it, no window.
  const file = JSON.parse(readFileSync(hostFile(chatId), 'utf8')) as { pid: number }
  hostPid = file.pid
  const all = procs()
  const host = all.find((p) => p.pid === hostPid)
  check('3 host', !!host, 'the chat host runs', host ? `${host.name} ${host.pid}` : 'none')
  check('3 outside', !tree(all, a).some((p) => p.pid === hostPid), "the host is not in the server's process tree", `parent ${host?.ppid} (server ${a})`)
  cliPids = tree(all, hostPid).map((p) => p.pid)
  check('3 cli', cliPids.length > 0, 'Claude Code runs under the host', tree(all, hostPid).map((p) => p.name).join(', '))
  check('3 hidden', visibleWindows([hostPid, ...cliPids]).length === 0, 'none of them shows a window', visibleWindows([hostPid, ...cliPids]))

  // 4. A graceful restart while the request waits: the chat goes on, the next server shows the same card.
  const down = await api<{ ok: boolean }>('POST', '/api/server/shutdown', {})
  check('4 shutdown', down.status === 200, 'the server stops when asked', down.body)
  await server!.exited
  check('4 kept', alive(hostPid) && cliPids.some(alive), 'the host and Claude Code outlive the server', { host: alive(hostPid) })
  const b = await startServer()
  const afterB = (await api<ChatSummary>('GET', `/api/chats/${chatId}`)).body
  check('4 adopted', afterB.status === 'needs_you' && afterB.pendingCount === 1, 'the next server shows the chat waiting on the same question', `${afterB.status}, ${afterB.pendingCount} pending`)
  const still = (await api<TranscriptItem[]>('GET', `/api/chats/${chatId}/items`)).body.find((i) => i.id === asked.id)
  check('4 same card', still?.kind === 'question' && still.state === 'pending', 'the question is still open under its id', still && 'state' in still ? still.state : 'gone')

  // 5. Answered on the new server; a hard kill of its whole tree while the command runs. An account whose
  //    settings ask before Bash gets the command approved here first, as Jacob would.
  const ok = await api('POST', `/api/chats/${chatId}/question/${asked.id}`, { answers: { [asked.questions[0]?.question ?? 'Which color?']: 'Blue' } })
  check('5 answer', ok.status === 200, 'the answer reaches Claude Code through the host', ok.status)
  let approved = 0
  /** True while the command runs: its tool is out, and no request holds it. */
  const commandRuns = async (): Promise<boolean> => {
    const chat = (await api<ChatSummary>('GET', `/api/chats/${chatId}`)).body
    const items = (await api<TranscriptItem[]>('GET', `/api/chats/${chatId}/items`)).body
    for (const p of items) {
      if (p.kind !== 'permission' || p.state !== 'pending') continue
      if ((await api('POST', `/api/chats/${chatId}/permission/${p.id}`, { decision: 'allow' })).status === 200) approved++
    }
    return chat.status === 'working' && chat.pendingCount === 0 && items.some((i) => i.kind === 'tool_use' && i.name === 'Bash' && i.status === 'running')
  }
  await waitFor(commandRuns, 90_000, 'the command to run')
  if (approved) info(`approved ${approved} permission request(s) for the command`)
  await Bun.sleep(3000)
  check('5 mid-command', await commandRuns(), 'the command still runs when the server is killed', 'running')
  spawnSync('taskkill', ['/PID', String(b), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await server!.exited
  check('5 survived', alive(hostPid), 'the host outlives a hard kill of the server tree', { host: alive(hostPid) })

  // 6. The third server finishes the turn with everyone: the command's output, the answer, one result.
  await startServer()
  const events: ServerEvent[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)) as ServerEvent)
  await waitFor(async () => (await commandRuns(), (await api<ChatSummary>('GET', `/api/chats/${chatId}`)).body?.status === 'idle'), TURN_MS, 'the turn to end')
  check('6 told', events.some((e) => e.type === 'notify' && e.reason === 'finished'), 'the window hears the turn finish', events.flatMap((e) => (e.type === 'notify' ? [e.reason] : [])))
  const items = (await api<TranscriptItem[]>('GET', `/api/chats/${chatId}/items`)).body
  const bash = items.flatMap((i) => (i.kind === 'tool_use' && i.name === 'Bash' ? [i] : []))
  const slept = bash.find((t) => t.status === 'done' && t.result?.text.includes('slept-well'))
  const text = items.filter((i) => i.kind === 'assistant_text').map((i) => (i.kind === 'assistant_text' ? i.text : '')).join(' ')
  check('6 tool', !!slept, 'the command ran to its end', bash.map((t) => `${t.status}: ${t.result?.text.trim().slice(0, 30) ?? ''}`))
  check('6 answer', /\bDONE\b/.test(text), 'the answer came', text.slice(0, 60))
  check('6 once', items.filter((i) => i.kind === 'result').length === 1 && items.filter((i) => i.kind === 'user').length === 1, 'one send, one result: nothing doubled', { results: items.filter((i) => i.kind === 'result').length, users: items.filter((i) => i.kind === 'user').length })
  const lines = readFileSync(join(home, 'chats', `${chatId}.jsonl`), 'utf8').trim().split('\n').length
  info(`transcript file: ${lines} lines for ${items.length} items`)
  ws.close()

  // 7. Ending the chats ends the host and Claude Code.
  const end = await api<{ chats: boolean }>('POST', '/api/server/shutdown', { chats: true })
  check('7 shutdown', end.status === 200 && end.body.chats === true, 'the server stops with its chats', end.body)
  await server!.exited
  await waitFor(() => !alive(hostPid), 15_000, 'the host to end').catch(() => {})
  check('7 ended', !alive(hostPid) && !cliPids.some(alive), 'the host and Claude Code are gone', { host: alive(hostPid), cli: cliPids.filter(alive) })
  check('7 tidy', !existsSync(hostFile(chatId)), 'the host file is removed', existsSync(hostFile(chatId)))
} catch (err) {
  check('run', false, 'the run finished', err instanceof Error ? err.message : String(err))
} finally {
  if (server && server.exitCode === null) spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  // Every host this run started, whether or not a step got to read its pid.
  const pids = new Set<number>(hostPid ? [hostPid] : [])
  for (const name of existsSync(join(home, 'hosts')) ? readdirSync(join(home, 'hosts')) : []) {
    if (!/^[\w-]+\.json$/.test(name) || name.endsWith('.spec.json') || name === 'server.json') continue
    try {
      pids.add((JSON.parse(readFileSync(join(home, 'hosts', name), 'utf8')) as { pid: number }).pid)
    } catch {}
  }
  for (const pid of pids) if (alive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  if (results.some((r) => !r.ok) && existsSync(serverLog)) console.log(readFileSync(serverLog, 'utf8').slice(-4000))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} PASS, ${failed.length} FAIL`)
if (failed.length) process.exit(1)
