// server/src/core/cli-limit-reset.ts — use a CLI account's limit reset, through the CLI itself.
//
// Owner, 2026-09-30: a button (and an MCP tool) that uses a CLI account's reset. Claude Code offers
// two kinds behind one command, `/limit-reset`: a banked reset grant ("Use your reset?" - refills
// the limits, the grant's count goes down) and a once-a-week session reset ("Reset your session
// limit now ... once a week, still counts toward your weekly limit"). Which one, and whether either
// is offered at all, only the CLI knows: asked directly, the usage endpoint marks both blocks
// `eligible: false, ineligible_reason: "surface"` (cedar_ember and juniper_tide, measured
// 2026-09-30), and answering as another app to get past that is not something this does.
//
// So this runs the real CLI, in a hidden terminal (Bun's PTY, no window), types `/limit-reset`,
// accepts the banked-grant question when one is asked (the person already asked for the reset by
// clicking), and reports the CLI's own words. ⛔ It is never a way to CHECK: the session variant
// resets at once with no question, so running it spends whatever it finds.
//
// Before the first run it marks the account's CLI setup finished and trusts one scratch folder in
// the account's .claude.json, so the CLI opens straight to its prompt instead of a setup screen or
// a "do you trust this folder" question whose default answer exits.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, resolveClaudeExe } from '../config'
import type { CliLimitResetResult } from '../types'
import { killProcessTree } from './process'

type LimitResetOutcome = CliLimitResetResult['outcome']
type LimitResetResult = CliLimitResetResult

const ENV_SCRUB =
  /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_\w+|CLAUDECODE|CLAUDE_CONFIG_DIR)$/
const WORK_DIR = join(DATA_DIR, 'cli-limit-reset')
const TOTAL_MS = 75_000

/** Terminal escape sequences out, so the screen can be matched as text. */
function plain(s: string): string {
  const ESC = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)
  return s
    .replace(new RegExp(`${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`, 'g'), '')
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${ESC}[=>()][0-9A-Za-z]?`, 'g'), '')
}

/**
 * The CLI's answers, first match wins, each with a clean sentence to show. The screen text is
 * matched loosely (`\s*`) because the CLI draws with cursor moves, so spaces go missing and other
 * screen content runs into the line (measured 2026-09-30: "resetisn'tavailablerightnow.◐ medium").
 * Only the date is taken from the screen; the rest of the message is ours.
 */
const ANSWERS: Array<{ re: RegExp; outcome: LimitResetOutcome; say: string }> = [
  { re: /Session\s*limit\s*reset\s*·/i, outcome: 'reset', say: 'Session limit reset.' },
  { re: /Limits\s*reset\s*·/i, outcome: 'reset', say: 'Limits reset.' },
  { re: /Weekly\s*reset\s*used\s*·/i, outcome: 'used', say: "This week's reset is already used." },
  { re: /Reset\s*used\s*·/i, outcome: 'used', say: 'That reset is already used.' },
  {
    re: /reset\s*isn'?t\s*available\s*right\s*now/i,
    outcome: 'unavailable',
    say: "A reset isn't available for this account right now.",
  },
  {
    re: /Couldn'?t\s*(reset|confirm)/i,
    outcome: 'error',
    say: "The CLI couldn't reset the limits right now. Try again in a moment.",
  },
  {
    re: /Unknown\s*(slash\s*)?command/i,
    outcome: 'unavailable',
    say: 'This CLI has no /limit-reset for this account.',
  },
]

/** Which answer the screen shows, if any (first match wins). Exported for its test. */
export function classifyLimitResetScreen(
  screen: string,
): { outcome: LimitResetOutcome; say: string } | null {
  const a = ANSWERS.find((x) => x.re.test(screen))
  return a ? { outcome: a.outcome, say: a.say } : null
}

/** "availableagainOct7,6pm·..." -> "Oct 7, 6pm": the date after "again"/"available", respaced. */
export function dateAfter(screen: string): string | null {
  const m =
    /(?:available\s*again|next\s*reset\s*available)\s*([A-Za-z]{3,9}\s*\d{1,2}(?:\s*,\s*\d{1,2}(?::\d{2})?\s*[ap]m)?)/i.exec(
      screen,
    )
  if (!m?.[1]) return null
  return m[1]
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/,\s*/g, ', ')
    .trim()
}

/** Setup finished and the scratch folder trusted, in this account's own .claude.json. */
function prepareConfig(configDir: string): void {
  mkdirSync(WORK_DIR, { recursive: true })
  const file = join(configDir, '.claude.json')
  const cfg = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8') || '{}') as Record<string, unknown>)
    : {}
  const projects = (cfg.projects ?? {}) as Record<string, Record<string, unknown>>
  const key = WORK_DIR.replaceAll('\\', '/')
  if (cfg.hasCompletedOnboarding === true && projects[key]?.hasTrustDialogAccepted === true) return
  cfg.hasCompletedOnboarding = true
  cfg.theme ??= 'dark'
  projects[key] = { ...(projects[key] ?? {}), hasTrustDialogAccepted: true }
  cfg.projects = projects
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  renameSync(tmp, file)
}

/** Accounts with a run in flight, by config dir: two runs on one account could each reach the
 *  question and spend a grant apiece, whichever caller (button, MCP tool) started them. */
const running = new Set<string>()

/** Run `/limit-reset` for the account whose CLI config lives in `configDir`. Never throws. */
export async function runCliLimitReset(
  configDir: string,
  opts: {
    /** false = CHECK: at the banked reset's "Use your reset?" question, press Escape and report it
     *  as available. The weekly session reset asks nothing, so a check still uses that one. */
    confirm?: boolean
  } = {},
): Promise<LimitResetResult> {
  const key = configDir.replaceAll('\\', '/').toLowerCase()
  if (running.has(key))
    return {
      ok: false,
      outcome: 'error',
      message: 'A reset is already running for this account.',
      nextAvailable: null,
      at: Date.now(),
    }
  running.add(key)
  try {
    return await runOnce(configDir, opts.confirm !== false)
  } finally {
    running.delete(key)
  }
}

async function runOnce(configDir: string, confirm: boolean): Promise<LimitResetResult> {
  const at = Date.now()
  const fail = (message: string): LimitResetResult => ({
    ok: false,
    outcome: 'error',
    message,
    nextAvailable: null,
    at,
  })
  try {
    prepareConfig(configDir)
  } catch (err) {
    return fail(`Could not prepare the CLI settings: ${err instanceof Error ? err.message : err}`)
  }

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !ENV_SCRUB.test(k)) env[k] = v
  env.CLAUDE_CONFIG_DIR = configDir

  let raw = ''
  const decoder = new TextDecoder()
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([resolveClaudeExe()], {
      cwd: WORK_DIR,
      env,
      windowsHide: true,
      terminal: {
        cols: 120,
        rows: 40,
        data(_t: unknown, d: Uint8Array) {
          raw += decoder.decode(d, { stream: true })
        },
      },
    } as unknown as Parameters<typeof Bun.spawn>[1])
  } catch (err) {
    return fail(`Could not start the Claude CLI: ${err instanceof Error ? err.message : err}`)
  }
  const term = (proc as unknown as { terminal?: { write(s: string): void } }).terminal
  const send = (s: string) => {
    try {
      term?.write(s)
    } catch {
      // The CLI already exited; the screen says why.
    }
  }
  // The overall deadline bounds getting TO the command; the answer, once the command is sent, gets
  // its own full wait. Cutting that short after a confirmed reset would report "no answer" for a
  // reset that may already be spent, and invite a second one.
  const deadline = at + TOTAL_MS
  const until = async (test: () => boolean, ms: number, capped = true) => {
    const end = capped ? Math.min(Date.now() + ms, deadline) : Date.now() + ms
    while (Date.now() < end) {
      if (test() || proc.exitCode !== null) return test()
      await Bun.sleep(250)
    }
    return test()
  }
  const screen = () => plain(raw)

  try {
    if (!(await until(() => /Try "/.test(screen()), 30_000))) {
      const s = screen()
      if (/Select login method|Not logged in|\/login/i.test(s))
        return fail('This account is signed out of the CLI. Sign it in again, then retry.')
      return fail('The Claude CLI did not reach its prompt.')
    }
    // Its start screen keeps drawing for a few seconds; keys typed before that are lost.
    await Bun.sleep(6000)
    raw = ''
    for (const ch of '/limit-reset') {
      send(ch)
      await Bun.sleep(50)
    }
    if (!(await until(() => /limit-reset/.test(screen()), 5000)))
      return fail('The Claude CLI did not take the command.')
    await Bun.sleep(700)
    raw = ''
    send('\r')

    let confirmed = false
    let answer: { outcome: LimitResetOutcome; say: string; screen: string } | null = null
    await until(
      () => {
        const s = screen()
        if (!confirmed && /Use your reset\?|Yes,\s*use\s*my\s*reset/i.test(s)) {
          if (!confirm) {
            // Checking only: back out of the question ("No, keep it") and report what it offered.
            send('\x1b')
            const left = /(\d+)\s*left/i.exec(s)?.[1]
            const by = /use\s*by\s*([A-Za-z]{3,9}\s*\d{1,2})/i
              .exec(s)?.[1]
              ?.replace(/([A-Za-z])(\d)/, '$1 $2')
            const detail = [left ? `${left} left` : '', by ? `use by ${by}` : '']
              .filter(Boolean)
              .join(', ')
            answer = {
              outcome: 'available',
              say: `A reset is available${detail ? ` (${detail})` : ''}. It was not used.`,
              screen: s,
            }
            return true
          }
          // The person asked for this reset by clicking; the first choice is "Yes, use my reset".
          confirmed = true
          send('\r')
          return false
        }
        const hit = classifyLimitResetScreen(s)
        if (hit) answer = { ...hit, screen: s }
        return hit !== null
      },
      40_000,
      false,
    )
    if (!answer)
      return fail(
        confirmed
          ? "The reset was confirmed, but the CLI's answer never arrived. It may have been used: check this account's usage before trying again."
          : 'The Claude CLI gave no answer to /limit-reset.',
      )
    const {
      outcome,
      say,
      screen: shown,
    } = answer as {
      outcome: LimitResetOutcome
      say: string
      screen: string
    }
    // Give a date a moment to finish drawing when the answer carries one.
    await Bun.sleep(outcome === 'reset' || outcome === 'used' ? 800 : 0)
    const nextAvailable = dateAfter(screen()) ?? dateAfter(shown)
    return {
      ok: outcome === 'reset',
      outcome,
      message: nextAvailable ? `${say} Next one available ${nextAvailable}.` : say,
      nextAvailable,
      at,
    }
  } finally {
    send('\x03')
    await Bun.sleep(300)
    send('\x03')
    await Bun.sleep(500)
    if (proc.exitCode === null) killProcessTree(proc.pid)
  }
}
