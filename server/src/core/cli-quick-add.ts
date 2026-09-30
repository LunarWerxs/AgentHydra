// server/src/core/cli-quick-add.ts — sign a Claude Code CLI account in from just an email
// (docs/CORCH.md "Server: quick add").
//
// Why: Corch spreads work across the owner's CLI accounts, and adding one used to mean naming an
// instance, opening a terminal and typing `/login`. Here the daemon runs `claude auth login --email`
// with the instance's CLAUDE_CONFIG_DIR and shows the sign-in link it prints. The PERSON opens that
// link wherever they can read the account's email (a private window, a phone), signs in there, and
// pastes the code the page ends on into Quick add. The daemon never types or sees a credential: it
// relays that pasted code to the CLI and checks the result with `claude auth status`.
//
// ⛔ NEVER THE PERSON'S OWN BROWSER (owner, 2026-09-30). It is signed in to a different Claude
// account and the new account's email arrives on another device, so the CLI popping it open was
// wrong twice over. The CLI opens whatever `BROWSER` names (else rundll32 url,OpenURL), so BROWSER is
// pointed at a program that does nothing with a URL. Driving the sign-in page ourselves is not an
// option either: claude.ai answers a headless browser with a Cloudflare human check (measured
// 2026-09-30, title "Just a moment..."), and passing that check is not ours to automate.

import { join } from 'node:path'
import { resolveClaudeExe } from '../config'
import {
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  listCliInstances,
  renameCliInstance,
} from './cli-instances'
import { killProcessTree } from './process'

export interface QuickAddFlow {
  id: string
  email: string
  instanceId: string
  num: number | null
  state: 'waiting' | 'signed-in' | 'failed' | 'cancelled'
  url: string | null
  message: string
  account: { email: string | null; plan: string | null } | null
  startedAt: number
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Same scrub as Corch: the login must land in THIS config dir, never ride an inherited key/token.
const ENV_SCRUB =
  /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_(OAUTH_\w+|ENTRYPOINT|SSE_PORT|SESSION\w*)|CLAUDECODE|CLAUDE_CONFIG_DIR)$/
const URL_RE = /If the browser didn't open, visit:\s*(\S+)/
/** A program that takes a URL argument, prints nothing useful and exits: BROWSER for the login. */
const NO_BROWSER =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'where.exe')
    : 'true'
const FLOW_TIMEOUT_MS = 10 * 60_000
const KEEP = 20

interface Live {
  proc: ReturnType<typeof Bun.spawn> | null
  created: boolean
  timer: ReturnType<typeof setTimeout> | null
  lastLine: string
}

// In memory only: a flow is a few minutes of a person at a browser; a daemon restart ends it.
const flows = new Map<string, QuickAddFlow>()
const live = new Map<string, Live>()

function scrubbedEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !ENV_SCRUB.test(k)) env[k] = v
  env.CLAUDE_CONFIG_DIR = configDir
  return env
}

function prune(): void {
  const ids = [...flows.values()].sort((a, b) => b.startedAt - a.startedAt).map((f) => f.id)
  for (const id of ids.slice(KEEP)) {
    if (flows.get(id)?.state === 'waiting') continue
    flows.delete(id)
    live.delete(id)
  }
}

function finish(id: string, state: 'signed-in' | 'failed' | 'cancelled', message: string): void {
  const flow = flows.get(id)
  const l = live.get(id)
  if (flow?.state !== 'waiting') return
  flow.state = state
  flow.message = message
  if (l?.timer) clearTimeout(l.timer)
  if (l?.proc && l.proc.exitCode === null) killProcessTree(l.proc.pid)
  // A NEW instance that never signed in is taken back; a re-sign of an existing one is left alone.
  if (state !== 'signed-in' && l?.created) {
    const rec = getCliInstance(flow.instanceId)
    if (rec && !rec.loggedIn) deleteCliInstance(rec.id, rec.name)
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true })
      const parts = buf.split(/\r?\n/)
      buf = parts.pop() ?? ''
      for (const p of parts) onLine(p)
      // The code prompt has no newline after it; surface it too.
      if (buf.includes('Paste code here')) onLine(buf)
    }
  } catch {
    // stream closed with the process
  }
  if (buf) onLine(buf)
}

export function startQuickAdd(email: string): QuickAddFlow | { error: string } {
  const trimmed = (email ?? '').trim()
  if (!EMAIL_RE.test(trimmed)) return { error: 'Enter a valid email address.' }
  for (const f of flows.values())
    if (f.state === 'waiting' && f.email.toLowerCase() === trimmed.toLowerCase())
      return { error: `A sign-in for ${trimmed} is already waiting.` }

  // A signed-in flow renames the instance to "<email> (<plan>)", so match that shape too: adding the
  // same email again re-signs its instance instead of minting a duplicate.
  const lower = trimmed.toLowerCase()
  let rec =
    listCliInstances().find((i) => {
      const n = i.name.toLowerCase()
      return n === lower || n.startsWith(`${lower} (`)
    }) ?? null
  const created = !rec
  if (!rec) {
    const res = createCliInstance(trimmed)
    const newId = (res.data as { id?: string } | undefined)?.id
    if (!res.ok || !newId) return { error: res.message ?? 'Could not create the CLI instance.' }
    rec = getCliInstance(newId)
    if (!rec) return { error: 'The new CLI instance could not be read back.' }
  }

  const id = `qa-${crypto.randomUUID().slice(0, 8)}`
  const flow: QuickAddFlow = {
    id,
    email: trimmed,
    instanceId: rec.id,
    num: rec.num ?? null,
    state: 'waiting',
    url: null,
    message: 'Open the sign-in link where you can read that email.',
    account: null,
    startedAt: Date.now(),
  }
  const l: Live = { proc: null, created, timer: null, lastLine: '' }
  flows.set(id, flow)
  live.set(id, l)
  prune()

  let proc: ReturnType<typeof Bun.spawn>
  try {
    // BROWSER = a no-op, so the CLI never opens the person's own browser (see the header).
    proc = Bun.spawn([resolveClaudeExe(), 'auth', 'login', '--email', trimmed], {
      env: { ...scrubbedEnv(rec.configDir), BROWSER: NO_BROWSER },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
  } catch (err) {
    finish(
      id,
      'failed',
      `Could not start claude: ${err instanceof Error ? err.message : String(err)}`,
    )
    return flow
  }
  l.proc = proc
  l.timer = setTimeout(() => finish(id, 'failed', 'Timed out after 10 minutes.'), FLOW_TIMEOUT_MS)
  l.timer.unref?.()

  const onLine = (line: string) => {
    const t = line.trim()
    if (!t) return
    const m = URL_RE.exec(t)
    if (m) flow.url = m[1] ?? null
    l.lastLine = t.slice(0, 300)
  }
  const configDir = rec.configDir
  void Promise.all([
    readLines(proc.stdout as ReadableStream<Uint8Array>, onLine),
    readLines(proc.stderr as ReadableStream<Uint8Array>, onLine),
    proc.exited,
  ]).then(async () => {
    if (flow.state !== 'waiting') return
    if (proc.exitCode !== 0) {
      finish(id, 'failed', l.lastLine || `claude auth login exited ${proc.exitCode}`)
      return
    }
    const status = await cliAuthStatus(configDir)
    if (flow.state !== 'waiting') return
    if (!status.loggedIn) {
      finish(id, 'failed', l.lastLine || 'Sign-in did not complete.')
      return
    }
    flow.account = { email: status.email, plan: status.plan }
    if (status.plan) renameCliInstance(flow.instanceId, `${trimmed} (${status.plan})`)
    finish(
      id,
      'signed-in',
      `Signed in as ${status.email ?? trimmed}${status.plan ? ` (${status.plan})` : ''}.`,
    )
  })

  return flow
}

export function getQuickAdd(id: string): QuickAddFlow | null {
  return flows.get(id) ?? null
}

export function listQuickAdds(): QuickAddFlow[] {
  return [...flows.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, KEEP)
}

export function submitQuickAddCode(id: string, code: string): { ok: boolean; message: string } {
  const flow = flows.get(id)
  const proc = live.get(id)?.proc
  if (!flow) return { ok: false, message: 'No such sign-in.' }
  if (flow.state !== 'waiting' || !proc || proc.exitCode !== null)
    return { ok: false, message: 'This sign-in is no longer waiting for a code.' }
  const clean = (code ?? '').trim()
  if (!clean || /[\r\n]/.test(clean)) return { ok: false, message: 'Paste the code as one line.' }
  try {
    const stdin = proc.stdin as import('bun').FileSink
    stdin.write(`${clean}\n`)
    stdin.flush()
  } catch (err) {
    return {
      ok: false,
      message: `Could not send the code: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return { ok: true, message: 'Code sent.' }
}

export function cancelQuickAdd(id: string): { ok: boolean; message: string } {
  const flow = flows.get(id)
  if (!flow) return { ok: false, message: 'No such sign-in.' }
  if (flow.state !== 'waiting') return { ok: false, message: `Already ${flow.state}.` }
  finish(id, 'cancelled', 'Cancelled.')
  return { ok: true, message: 'Cancelled.' }
}

/** The real sign-in state: `.credentials.json` existing (isLoggedIn) passes for a hollow or revoked
 *  login, so ask the CLI itself. Never throws; anything unreadable is "not logged in". */
export async function cliAuthStatus(
  configDir: string,
): Promise<{ loggedIn: boolean; email: string | null; plan: string | null }> {
  const none = { loggedIn: false, email: null, plan: null }
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([resolveClaudeExe(), 'auth', 'status', '--json'], {
      env: scrubbedEnv(configDir),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    })
  } catch {
    return none
  }
  const timer = setTimeout(() => killProcessTree(proc.pid), 20_000)
  try {
    const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
    await proc.exited
    const j = JSON.parse(text) as Record<string, unknown>
    const str = (...keys: string[]) => {
      for (const k of keys) if (typeof j[k] === 'string' && j[k]) return j[k] as string
      return null
    }
    return {
      loggedIn: j.loggedIn === true,
      email: str('email', 'emailAddress'),
      plan: str('subscriptionType', 'subscription', 'plan'),
    }
  } catch {
    return none
  } finally {
    clearTimeout(timer)
  }
}
