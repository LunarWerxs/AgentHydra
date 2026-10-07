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
// clicking), and reports the CLI's own words.
//
// Checking (`confirm: false`) is safe below the 5-hour limit. The weekly session reset is claimed
// only when the CLI's own rate-limit state is `rejected` with type `five_hour` and a future reset
// time (read from Claude Code 2.1.286, 2026-10-03); below that limit `/limit-reset` only finds
// banked grants, backs out of the question, and answers "A reset isn't available ..." when there is
// none. AT the 5-hour limit a check could still spend the weekly reset, so never check there
// (core/cli-reset-sweep.ts keeps its daily check away from it).
//
// Before the first run it marks the account's CLI setup finished and trusts one scratch folder in
// the account's .claude.json, so the CLI opens straight to its prompt instead of a setup screen or
// a "do you trust this folder" question whose default answer exits.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_PROBE_NO_MCP_ARGS, DATA_DIR, resolveClaudeExe } from '../config'
import type { CliLimitResetResult } from '../types'
import { pinHaikuModel } from './haiku-pin'
import { killProcessTreesAsync } from './process'

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
     *  as available. Spends nothing while the account's 5-hour usage is below its limit; at the
     *  limit the weekly session reset asks nothing and a check could use it. */
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

/** What one `/limit-reset` run keeps while it drives the CLI's terminal. */
interface ResetRun {
  /** When the run started: every result carries it. */
  at: number
  /** The overall deadline. It bounds getting TO the command; the answer has its own wait. */
  deadline: number
  proc: ReturnType<typeof Bun.spawn>
  /** What the terminal has written since it was last cleared. */
  out: { raw: string }
}

const failedAt = (at: number, message: string): LimitResetResult => ({
  ok: false,
  outcome: 'error',
  message,
  nextAvailable: null,
  at,
})

/** This process's environment without what would point the CLI at another account, for `configDir`. */
function resetEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !ENV_SCRUB.test(k)) env[k] = v
  env.CLAUDE_CONFIG_DIR = configDir
  return pinHaikuModel(env) // never Haiku 4.5 behind the alias (haiku-pin.ts)
}

/** Start the CLI on a pseudo-terminal whose output lands in `out`. Throws when it cannot start. */
function spawnResetCli(
  env: Record<string, string>,
  out: { raw: string },
): ReturnType<typeof Bun.spawn> {
  const decoder = new TextDecoder()
  return Bun.spawn([resolveClaudeExe(), ...CLAUDE_PROBE_NO_MCP_ARGS], {
    cwd: WORK_DIR,
    env,
    windowsHide: true,
    terminal: {
      cols: 120,
      rows: 40,
      data(_t: unknown, d: Uint8Array) {
        out.raw += decoder.decode(d, { stream: true })
      },
    },
  } as unknown as Parameters<typeof Bun.spawn>[1])
}

function typeInto(run: ResetRun, s: string): void {
  const term = (run.proc as unknown as { terminal?: { write(s: string): void } }).terminal
  try {
    term?.write(s)
  } catch {
    // The CLI already exited; the screen says why.
  }
}

const screenOf = (run: ResetRun): string => plain(run.out.raw)

/** Poll `test` every quarter second for up to `ms`, bounded by the run's deadline unless
 *  `capped` is false, and stop early when the CLI exits. The test's last word is the answer. */
async function waitUntil(
  run: ResetRun,
  test: () => boolean,
  ms: number,
  capped = true,
): Promise<boolean> {
  const end = capped ? Math.min(Date.now() + ms, run.deadline) : Date.now() + ms
  while (Date.now() < end) {
    if (test() || run.proc.exitCode !== null) return test()
    await Bun.sleep(250)
  }
  return test()
}

/** Wait for the CLI's prompt. The reason it never came, or null when it is there. */
async function awaitPrompt(run: ResetRun): Promise<string | null> {
  if (await waitUntil(run, () => /Try "/.test(screenOf(run)), 30_000)) return null
  const s = screenOf(run)
  if (/Select login method|Not logged in|\/login/i.test(s))
    return 'This account is signed out of the CLI. Sign it in again, then retry.'
  return 'The Claude CLI did not reach its prompt.'
}

/** Type `/limit-reset` and press Enter. The reason the CLI did not take it, or null. */
async function sendResetCommand(run: ResetRun): Promise<string | null> {
  // Its start screen keeps drawing for a few seconds; keys typed before that are lost.
  await Bun.sleep(6000)
  run.out.raw = ''
  for (const ch of '/limit-reset') {
    typeInto(run, ch)
    await Bun.sleep(50)
  }
  if (!(await waitUntil(run, () => /limit-reset/.test(screenOf(run)), 5000)))
    return 'The Claude CLI did not take the command.'
  await Bun.sleep(700)
  run.out.raw = ''
  typeInto(run, '\r')
  return null
}

interface ResetAnswer {
  outcome: LimitResetOutcome
  say: string
  screen: string
}

/** What reading the CLI's answer has seen so far. */
interface AnswerState {
  /** "Yes, use my reset" was pressed: from here a missing answer may still be a spent reset. */
  confirmed: boolean
  answer: ResetAnswer | null
}

/** Checking only: back out of the question ("No, keep it") and report what it offered. */
function declineOffer(run: ResetRun, s: string): ResetAnswer {
  typeInto(run, '\x1b')
  const left = /(\d+)\s*left/i.exec(s)?.[1]
  const by = /use\s*by\s*([A-Za-z]{3,9}\s*\d{1,2})/i
    .exec(s)?.[1]
    ?.replace(/([A-Za-z])(\d)/, '$1 $2')
  const detail = [left ? `${left} left` : '', by ? `use by ${by}` : ''].filter(Boolean).join(', ')
  return {
    outcome: 'available',
    say: `A reset is available${detail ? ` (${detail})` : ''}. It was not used.`,
    screen: s,
  }
}

/** One look at the screen after the command: answer the banked reset's question (once), or read
 *  the outcome. True when an answer is in. */
function readAnswerStep(run: ResetRun, confirm: boolean, state: AnswerState): boolean {
  const s = screenOf(run)
  if (!state.confirmed && /Use your reset\?|Yes,\s*use\s*my\s*reset/i.test(s)) {
    if (!confirm) {
      state.answer = declineOffer(run, s)
      return true
    }
    // The person asked for this reset by clicking; the first choice is "Yes, use my reset".
    state.confirmed = true
    typeInto(run, '\r')
    return false
  }
  const hit = classifyLimitResetScreen(s)
  if (hit) state.answer = { ...hit, screen: s }
  return hit !== null
}

/** The CLI's answer as a result, with the date it gives for the next reset when it gives one. */
async function resultOf(run: ResetRun, answer: ResetAnswer): Promise<LimitResetResult> {
  const { outcome, say, screen: shown } = answer
  // Give a date a moment to finish drawing when the answer carries one.
  await Bun.sleep(outcome === 'reset' || outcome === 'used' ? 800 : 0)
  const nextAvailable = dateAfter(screenOf(run)) ?? dateAfter(shown)
  return {
    ok: outcome === 'reset',
    outcome,
    message: nextAvailable ? `${say} Next one available ${nextAvailable}.` : say,
    nextAvailable,
    at: run.at,
  }
}

/** Drive the started CLI from its prompt to the answer to `/limit-reset`. */
async function driveReset(run: ResetRun, confirm: boolean): Promise<LimitResetResult> {
  const noPrompt = await awaitPrompt(run)
  if (noPrompt) return failedAt(run.at, noPrompt)
  const notTaken = await sendResetCommand(run)
  if (notTaken) return failedAt(run.at, notTaken)

  const state: AnswerState = { confirmed: false, answer: null }
  await waitUntil(run, () => readAnswerStep(run, confirm, state), 40_000, false)
  if (!state.answer)
    return failedAt(
      run.at,
      state.confirmed
        ? "The reset was confirmed, but the CLI's answer never arrived. It may have been used: check this account's usage before trying again."
        : 'The Claude CLI gave no answer to /limit-reset.',
    )
  return resultOf(run, state.answer)
}

/** Leave the CLI: Ctrl+C twice, then end whatever is still there. */
async function closeResetCli(run: ResetRun): Promise<void> {
  typeInto(run, '\x03')
  await Bun.sleep(300)
  typeInto(run, '\x03')
  await Bun.sleep(500)
  if (run.proc.exitCode === null) await killProcessTreesAsync([run.proc.pid])
}

async function runOnce(configDir: string, confirm: boolean): Promise<LimitResetResult> {
  const at = Date.now()
  try {
    prepareConfig(configDir)
  } catch (err) {
    return failedAt(
      at,
      `Could not prepare the CLI settings: ${err instanceof Error ? err.message : err}`,
    )
  }

  const env = resetEnv(configDir)
  const out = { raw: '' }
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = spawnResetCli(env, out)
  } catch (err) {
    return failedAt(
      at,
      `Could not start the Claude CLI: ${err instanceof Error ? err.message : err}`,
    )
  }
  // The overall deadline bounds getting TO the command; the answer, once the command is sent, gets
  // its own full wait. Cutting that short after a confirmed reset would report "no answer" for a
  // reset that may already be spent, and invite a second one.
  const run: ResetRun = { at, deadline: at + TOTAL_MS, proc, out }
  try {
    return await driveReset(run, confirm)
  } finally {
    await closeResetCli(run)
  }
}
