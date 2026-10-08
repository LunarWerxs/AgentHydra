// Engine end to end (bun run e2e:engine): the real server, the real Agent SDK query, one real Claude
// account, a handful of short turns. Boots createServer on port 0 with HYDRA_DESK_HOME in a fresh temp
// folder, drives a chat over REST, watches /ws, restarts the server and resumes. Prints PASS/FAIL per
// check with what it saw; exits 1 on any FAIL. Never prints an email, a token or the chat env.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query as sdkQuery, type Options, type Query, type SDKUserMessage } from '../server/node_modules/@anthropic-ai/claude-agent-sdk'
import type { AccountInfo, ChatSummary, ServerEvent, TranscriptItem } from '../shared/protocol'
import { createServer, type DeskServer } from '../server/src/index'

/** A cheap, quick model: the proof is about the engine's plumbing, not the answers. */
const MODEL = process.env.E2E_MODEL || 'sonnet'
const TURN_MS = 180_000

// Results

const results: { step: string; ok: boolean; line: string }[] = []
function check(step: string, ok: boolean, what: string, seen: unknown): boolean {
  const line = `${ok ? 'PASS' : 'FAIL'} [${step}] ${what} :: ${typeof seen === 'string' ? seen : JSON.stringify(seen)}`
  results.push({ step, ok, line })
  console.log(line)
  return ok
}
const info = (s: string) => console.log(`     ${s}`)

// Environment: the chat gets this process's env without the nested-session markers of whoever ran us
// (a Claude Code session sets CLAUDECODE) and without any API key, so the account's own login is used.
const STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
const chatEnv: Record<string, string | undefined> = { ...process.env }
for (const k of STRIP) delete chatEnv[k]

// Every query() the engine makes goes through the real SDK; the options are kept for step 6.
const queries: { at: number; options: Options }[] = []
const queryImpl = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
  queries.push({ at: Date.now(), options: params.options ?? {} })
  return sdkQuery(params)
}

// Folders

const root = mkdtempSync(join(tmpdir(), 'hydra-desk-e2e-'))
const home = join(root, 'home')
const work = mkdtempSync(join(root, 'work-'))

// Server + /ws recorder

interface Seen {
  t: number
  ev: ServerEvent
}
let server: DeskServer | null = null
let ws: WebSocket | null = null
let events: Seen[] = []

async function boot(): Promise<void> {
  server = await createServer({ port: 0, home, deps: { queryImpl, env: chatEnv } })
  events = []
  ws = new WebSocket(server.url.replace('http', 'ws') + '/ws')
  ws.onmessage = (m) => events.push({ t: Date.now(), ev: JSON.parse(String(m.data)) as ServerEvent })
  await new Promise<void>((res, rej) => {
    ws!.onopen = () => res()
    ws!.onerror = () => rej(new Error('websocket failed to open'))
  })
  await waitFor(() => events.some((e) => e.ev.type === 'hello'), 5000, 'hello')
}

async function shutdown(): Promise<void> {
  try {
    ws?.close()
  } catch {}
  ws = null
  if (server) await server.stop()
  server = null
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(server!.url + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error ?? JSON.stringify(json)}`)
  return json
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`)
    await Bun.sleep(100)
  }
}

// Event views for one chat, from an index on

const chatUpserts = (id: string, from = 0) =>
  events.slice(from).flatMap((e) => (e.ev.type === 'chat.upsert' && e.ev.chat.id === id ? [{ t: e.t, chat: e.ev.chat }] : []))
const itemUpserts = (id: string, from = 0) =>
  events.slice(from).flatMap((e) => (e.ev.type === 'item.upsert' && e.ev.chatId === id ? [{ t: e.t, item: e.ev.item }] : []))
const lastChat = (id: string) => chatUpserts(id).at(-1)?.chat
const statusesFrom = (id: string, from: number) => {
  const out: string[] = []
  for (const { chat } of chatUpserts(id, from)) if (out.at(-1) !== chat.status) out.push(chat.status)
  return out
}
/** Latest version of each item, in first-seen order. */
function itemsFrom(id: string, from: number): TranscriptItem[] {
  const map = new Map<string, TranscriptItem>()
  for (const { item } of itemUpserts(id, from)) map.set(item.id, item)
  return [...map.values()]
}
const textOf = (items: TranscriptItem[]) =>
  items.flatMap((i) => (i.kind === 'assistant_text' && !i.parentToolUseId ? [i.text] : [])).join('\n')
function firstTokenAt(id: string, from: number): number | null {
  const e = events.slice(from).find((x) => (x.ev.type === 'item.delta' && x.ev.chatId === id) || (x.ev.type === 'item.upsert' && x.ev.chatId === id && x.ev.item.kind === 'assistant_text'))
  return e?.t ?? null
}
function isSubsequence(want: string[], got: string[]): boolean {
  let i = 0
  for (const s of got) if (s === want[i]) i++
  return i === want.length
}

/**
 * Waits for the chat to settle in one of `done` statuses after `from`. Permission requests for tools the
 * step does not expect are denied (and reported): a stray tool call must not hang the run.
 */
const strays: string[] = []
async function settle(id: string, from: number, done: string[], ms = TURN_MS, keepId?: string): Promise<ChatSummary> {
  const answered = new Set<string>()
  const end = Date.now() + ms
  for (;;) {
    for (const item of itemsFrom(id, from)) {
      if (item.kind !== 'permission' || item.state !== 'pending' || answered.has(item.id)) continue
      if (item.id === keepId) continue
      answered.add(item.id)
      strays.push(item.toolName)
      info(`denied an unexpected permission request for ${item.toolName}`)
      await api('POST', `/api/chats/${id}/permission/${item.id}`, { decision: 'deny', message: 'Not in this test: do not use that tool.' }).catch(() => {})
    }
    const sawWork = statusesFrom(id, from).some((s) => s === 'working' || s === 'starting')
    const c = lastChat(id)
    if (c && sawWork && done.includes(c.status)) return c
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000}s waiting for status ${done.join('/')} (now ${c?.status})`)
    await Bun.sleep(150)
  }
}

const timings: Record<string, number | null> = {}

// The run

async function main(): Promise<void> {
  info(`temp folder ${root}`)
  await boot()
  const acct = await pickAccount()
  if (!acct) return
  const { id, sessionId } = await firstTurn(acct)
  await permissionTurn(id)
  await interruptTurn(id)
  const chat = await restartAndResume(id, sessionId)
  await checkDelegation(chat)
  timings.costUsd = chat.costUsd
  info(`timings ${JSON.stringify(timings)}`)
  await api('DELETE', `/api/chats/${id}`).catch(() => {})
}

async function pickAccount(): Promise<AccountInfo | null> {
  const accounts = await api<AccountInfo[]>('GET', '/api/accounts')
  const pro = accounts.filter((a) => a.id !== 'default' && a.plan === 'Pro' && a.signedIn && !a.inUse && a.fiveHourPct !== null && a.weeklyPct !== null)
  pro.sort((a, b) => a.fiveHourPct! - b.fiveHourPct! || a.weeklyPct! - b.weeklyPct!)
  const acct = pro[0]
  check('1 account', !!acct, `a signed-in Pro account with no live sessions (${pro.length} of ${accounts.length} qualify)`, acct ? `#${acct.number} 5h ${acct.fiveHourPct}% week ${acct.weeklyPct}%` : 'none')
  return acct ?? null
}

async function firstTurn(acct: AccountInfo): Promise<{ id: string; sessionId: string | null }> {
  let from = events.length
  let t0 = Date.now()
  const created = await api<ChatSummary>('POST', '/api/chats', {
    cwd: work,
    prompt: 'Reply with exactly the word pong. Do not use any tools.',
    accountId: acct.id,
    model: MODEL,
    permissionMode: 'default',
  })
  const id = created.id
  check('2 create', created.account.id === acct.id, 'chat pinned to the picked account (not auto)', `#${created.account.number}`)
  let chat = await settle(id, from, ['idle', 'error', 'limited', 'stopped'])
  const ft = firstTokenAt(id, from)
  timings.firstTokenMs1 = ft ? ft - t0 : null
  timings.turnMs1 = Date.now() - t0
  const st2 = statusesFrom(id, from)
  check('2 status', isSubsequence(['starting', 'working', 'idle'], st2) && chat.status === 'idle', 'statuses starting -> working -> idle', st2.join(' > '))
  let items = itemsFrom(id, from)
  const reply1 = textOf(items)
  check('2 reply', /\bpong\b/i.test(reply1), 'an assistant_text item containing pong', reply1.slice(0, 80))
  const result1 = items.find((i) => i.kind === 'result')
  check('2 result', result1?.kind === 'result' && result1.ok, 'a result item with ok true', result1)
  chat = await waitFor(() => { const c = lastChat(id); return c && c.contextPct !== null && c.costUsd > 0 ? c : null }, 20_000, 'costUsd and contextPct').catch(() => lastChat(id)!)
  check('2 cost/context', chat.costUsd > 0 && chat.contextPct !== null, 'costUsd and contextPct set', { costUsd: chat.costUsd, contextPct: chat.contextPct })
  check('2 no tools', strays.length === 0 && !items.some((i) => i.kind === 'tool_use'), 'no tool was used', { strays, toolUses: items.filter((i) => i.kind === 'tool_use').map((i) => (i as { name: string }).name) })
  info(`first token ${timings.firstTokenMs1} ms, turn ${timings.turnMs1} ms (includes the CLI start)`)
  return { id, sessionId: chat.sessionId }
}

async function permissionTurn(id: string): Promise<void> {
  let from = events.length
  let t0 = Date.now()
  await api('POST', `/api/chats/${id}/messages`, { text: 'Create a file hello.txt in the current folder containing the word hi.' })
  const perm = await waitFor(
    () => itemsFrom(id, from).find((i): i is Extract<TranscriptItem, { kind: 'permission' }> => i.kind === 'permission' && i.state === 'pending' && /^(Write|Edit|Bash|PowerShell)$/.test(i.toolName)),
    TURN_MS,
    'a pending permission item',
  )
  const atPerm = await waitFor(() => { const c = lastChat(id); return c && c.status === 'needs_you' ? c : null }, 5000, 'needs_you').catch(() => lastChat(id)!)
  check('3 permission', perm.state === 'pending', 'a permission item, state pending', { toolName: perm.toolName, state: perm.state })
  check('3 needs_you', atPerm.status === 'needs_you' && atPerm.pendingCount === 1, 'chat status needs_you, pendingCount 1', { status: atPerm.status, pendingCount: atPerm.pendingCount })
  await api('POST', `/api/chats/${id}/permission/${perm.id}`, { decision: 'allow' })
  const chat = await settle(id, from, ['idle', 'error', 'limited', 'stopped'], TURN_MS, perm.id)
  timings.turnMs2 = Date.now() - t0
  const file = join(work, 'hello.txt')
  const content = existsSync(file) ? readFileSync(file, 'utf8') : null
  check('3 file', content !== null && /hi/i.test(content), 'hello.txt on disk containing hi', content === null ? 'missing' : content.trim())
  const permAfter = itemsFrom(id, from).find((i) => i.id === perm.id)
  check('3 idle', chat.status === 'idle' && chat.pendingCount === 0 && (permAfter as { state?: string })?.state === 'allowed', 'status back to idle, the request allowed', { status: chat.status, pendingCount: chat.pendingCount, state: (permAfter as { state?: string })?.state })
}

async function interruptTurn(id: string): Promise<void> {
  let from = events.length
  await api('POST', `/api/chats/${id}/messages`, { text: 'Run the shell command: sleep 60, then say done' })
  const tool = await waitFor(() => itemsFrom(id, from).find((i) => i.kind === 'tool_use'), TURN_MS, 'the first tool_use')
  const tInt = Date.now()
  await api('POST', `/api/chats/${id}/interrupt`)
  let chat = await waitFor(() => { const c = lastChat(id); return c && c.status === 'stopped' ? c : null }, 10_000, 'stopped').catch(() => lastChat(id)!)
  timings.interruptMs = Date.now() - tInt
  await Bun.sleep(5000) // whatever the SDK sends after the interrupt must not turn it into an error
  chat = lastChat(id)!
  const errs = itemsFrom(id, from).filter((i) => i.kind === 'system' && i.level === 'error')
  check('4 interrupt', chat.status === 'stopped' && chat.lastError === null && errs.length === 0, 'status stopped, no error', { tool: (tool as { name: string }).name, status: chat.status, lastError: chat.lastError, errorItems: errs.length, ms: timings.interruptMs })
}

async function restartAndResume(id: string, sessionId1: string | null): Promise<ChatSummary> {
  const before = await api<TranscriptItem[]>('GET', `/api/chats/${id}/items`)
  await shutdown()
  const nQueries = queries.length
  await boot()
  const back = await api<ChatSummary>('GET', `/api/chats/${id}`)
  const kept = await api<TranscriptItem[]>('GET', `/api/chats/${id}/items`)
  check('5 reload', back.status === 'closed' && kept.length === before.length && kept.length > 0, 'the chat comes back closed with its items', { status: back.status, items: kept.length, before: before.length })
  let from = events.length
  let t0 = Date.now()
  await api('POST', `/api/chats/${id}/messages`, { text: 'What single word did you reply with first?' })
  const chat = await settle(id, from, ['idle', 'error', 'limited', 'stopped'])
  timings.turnMs3 = Date.now() - t0
  const ft3 = firstTokenAt(id, from)
  timings.firstTokenMs3 = ft3 ? ft3 - t0 : null
  const resumed = queries.slice(nQueries)[0]?.options.resume
  check('5 resume', !!sessionId1 && resumed === sessionId1, 'the new runtime resumes the stored sessionId', { stored: sessionId1, resume: resumed ?? null })
  const reply3 = textOf(itemsFrom(id, from))
  check('5 answer', chat.status === 'idle' && /pong/i.test(reply3), 'the answer contains pong', { status: chat.status, reply: reply3.slice(0, 80) })
  return chat
}

async function checkDelegation(chat: ChatSummary): Promise<void> {
  const settings = await api<{ delegateToCliMayte: boolean }>('GET', '/api/settings')
  const opts = queries[0]?.options
  const sp = opts?.systemPrompt
  const append = sp && typeof sp === 'object' && 'append' in sp ? String(sp.append ?? '') : ''
  check(
    '6 delegate',
    settings.delegateToCliMayte && chat.delegateToCliMayte && !!opts?.disallowedTools?.includes('Agent') && !!opts?.disallowedTools?.includes('Task') && append.includes('climayte_run'),
    'delegateToCliMayte default on: Agent and Task disallowed, append names climayte_run',
    { setting: settings.delegateToCliMayte, chat: chat.delegateToCliMayte, disallowedTools: opts?.disallowedTools, appendMentionsClimayteRun: append.includes('climayte_run') },
  )
}

let crashed: unknown = null
try {
  await main()
} catch (err) {
  crashed = err
  check('run', false, 'the run finished', err instanceof Error ? err.message : String(err))
} finally {
  // Close every chat (the runtimes end with the server), then remove the temp folder.
  if (server) {
    const chats = await api<ChatSummary[]>('GET', '/api/chats?archived=1').catch(() => [] as ChatSummary[])
    for (const c of chats) await api('DELETE', `/api/chats/${c.id}`).catch(() => {})
  }
  await shutdown().catch(() => {})
  // A process the chat started can hold the work folder open for a while after the server stopped
  // (FINDINGS.md: the interrupted `sleep 60`), so keep trying for up to 90 s and say how long it took.
  const tRm = Date.now()
  for (let i = 0; i < 90 && existsSync(root); i++) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      await Bun.sleep(1000)
    }
  }
  info(`temp folder removal took ${Date.now() - tRm} ms`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${existsSync(root) ? ` (temp folder left: ${root})` : ''}`)
process.exit(failed.length || crashed ? 1 : 0)
