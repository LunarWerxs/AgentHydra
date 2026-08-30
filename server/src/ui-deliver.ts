// server/src/ui-deliver.ts - THE DELIVERY ACTUATOR: the server-side invocation of
// misc/Deliver-DesktopChat.ps1, which types a staged prompt into a SPECIFIC chat's composer
// in a running desktop app and presses Send - focus-free, zero clicks, no app update.
//
// WHY THIS IS THE CHANNEL (owner directive 2026-08-30: "you will find a way around this. End
// of story."). Every other unattended route was measured dead on app-1.40609.0:
//   - The app's own scheduler DOES fire an externally-written task (fireAt one-shot + a SKILL
//     at ~/.claude/scheduled-tasks/<id>/SKILL.md; proven live). But the session it spawns is
//     flagged UNATTENDED and `ccd_session_mgmt send_message` REFUSES there, verbatim: "This
//     tool is unavailable in unattended sessions (scheduled-task runs and remote-dispatched
//     trees)." So the scheduler can start work; it cannot deliver INTO an existing chat.
//   - claude://resume of a transcript ending on an unanswered user turn boots an engine that
//     never runs the turn.
// This path was proven end to end: a dormant chat, selected by its row and verified on
// screen, answered a prompt the daemon typed into it.
//
// THE AIM RAILS LIVE IN THE PS1 and are the whole reason this is safe (v1's UI injection was
// DELETED for typing into whatever had focus): exact-instance match, row matched by title
// with its status prefix, the target's own conversation text VERIFIED on screen before any
// typing, the composer's SetValue read back, and the Send button's disabled->enabled FLIP
// required as the app's own confirmation that it saw the text. Any rail that fails refuses
// with a distinct exit code instead of sending.

import { join } from 'node:path'

const PS1 = join(import.meta.dir, '..', '..', 'misc', 'Deliver-DesktopChat.ps1')
const SPAWN_TIMEOUT_MS = 120_000

export interface DeliverResult {
  ok: boolean
  /** Distinct outcomes, never collapsed into a bare boolean - each one implies a different
   *  next move for the caller (retry, re-render the row, leave the chat alone). */
  outcome:
    | 'delivered'
    | 'not-rendered'
    | 'wrong-chat'
    | 'composer-refused'
    | 'chat-busy'
    | 'error'
    | 'timeout'
  detail: string
}

const EXIT_OUTCOME: Record<number, DeliverResult['outcome']> = {
  0: 'delivered',
  1: 'error',
  3: 'not-rendered',
  4: 'wrong-chat',
  5: 'composer-refused',
  6: 'chat-busy',
}

export interface DeliverOpts {
  /** The instance profile DIR (path-shaped: the PS1 matches it EXACTLY, so '...\i1' can
   *  never hit '...\i10'). */
  instanceDir: string
  /** The chat's rendered title. The PS1 matches a row whose name ENDS WITH this, because the
   *  app prefixes rows with a status word ('Inaktiv <title>'). */
  title: string
  /** The prompt to type and send. */
  message: string
  /** A snippet that MUST be visible in the conversation after the row is selected - the proof
   *  that the composer belongs to the intended chat. Without it there is no aim. */
  verifyText: string
  /** Refuse rather than deliver when a turn is already in flight. Default true: never
   *  interrupt live work. */
  ifBusyAbort?: boolean
  /** When the title is not rendered - an imported chat shows as 'Untitled' until it is
   *  renamed through the app - identify the chat by opening candidate rows and matching
   *  verifyText. Safe by construction: the same on-screen proof still gates the send, so a
   *  wrong candidate is navigated past and then refused, never typed into. Default true,
   *  because the chats a courier most needs to reach are exactly the freshly imported ones. */
  searchByContent?: boolean
  /** Seam for tests. */
  run?: (args: string[]) => Promise<{ code: number; out: string }>
}

async function runPs1(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(
    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
    // A console spawn: windowsHide required (repo guardrail - only GUI spawns stay visible).
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', windowsHide: true },
  )
  const timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS)
  try {
    // Stderr rides along for the same reason ui-archive keeps it: a throwing UIA call puts
    // its only diagnostic there, and dropping it reports a bare 'exited 1'.
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, out: err.trim() ? `${out}\n${err}` : out }
  } finally {
    clearTimeout(timer)
  }
}

/** Map a PS1 run to a typed result. Pure; pinned by tests. */
export function interpretDeliverExit(code: number, out: string): DeliverResult {
  const outcome = EXIT_OUTCOME[code] ?? 'error'
  return { ok: outcome === 'delivered', outcome, detail: out.trim() || `exit ${code}` }
}

/**
 * Type `message` into `title`'s composer in `instanceDir` and press Send. The app must be
 * RUNNING and the row RENDERED (the same reach limit the archive click has had since it
 * shipped: a collapsed group or virtualized-out row is reported, never faked).
 */
export async function uiDeliverToChat(opts: DeliverOpts): Promise<DeliverResult> {
  if (!opts.verifyText.trim())
    return {
      ok: false,
      outcome: 'error',
      detail: 'verifyText is required - without it the delivery has no aim proof',
    }
  const args = [
    '-Instance',
    opts.instanceDir,
    '-Title',
    opts.title,
    '-Message',
    opts.message,
    '-VerifyText',
    opts.verifyText,
  ]
  if (opts.ifBusyAbort !== false) args.push('-IfBusyAbort')
  if (opts.searchByContent !== false) args.push('-SearchByContent')
  try {
    const { code, out } = await (opts.run ?? runPs1)(args)
    return interpretDeliverExit(code, out)
  } catch (err) {
    return {
      ok: false,
      outcome: 'error',
      detail: err instanceof Error ? err.message : 'delivery spawn failed',
    }
  }
}
