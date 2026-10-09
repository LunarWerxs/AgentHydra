// The orchestrator's judge: a frontier model reads ONE chat's brief and says what its next move is. It is asked through
// the Agent SDK on Desk's own login, with no tools, no MCP servers, one turn, no permission prompts, and a timeout
// (owner, 2026-10-09: "essentially a frontier-level AI that is doing the managing, not just some basic heuristic stuff").
// The model's answer is one JSON object; anything else is an error result, never a guess, and an error sends nothing.
// Pure apart from the injected AskModel: plugins/70-orchestrator.ts calls judgeChat, sends the message it returns through
// its own send path, and holds the hard limits (the model cannot override them).

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TranscriptItem } from '@shared/protocol'
import { ORCHESTRATOR_VERDICTS, type OrchestratorVerdict } from '@shared/orchestrator'
import { sdkQuery } from '../host/sdk'
import { pinHaikuModel } from '../engine/haiku-pin'

/** The judge answers within this long, or its call is an error (owner's brief, 2026-10-09). */
export const JUDGE_TIMEOUT_MS = 90_000
/** The transcript the judge reads first: the last items, trimmed to about this many characters. */
export const JUDGE_CHARS = 12_000
/** How much of the transcript each step reads: about 1%, 3%, then 5% of it, each held between a floor (a short chat still
 *  gives enough to judge) and a cap (a huge one stays cheap and fast). A step further only when the judge answers "more"
 *  (owner, 2026-10-09: "the last 1%, then the last 3%, then the last 5% if it needs more context ... for token and speed"). */
export const CONTEXT_STEPS = [
  { share: 0.01, min: JUDGE_CHARS, max: 40_000 },
  { share: 0.03, min: 40_000, max: 120_000 },
  { share: 0.05, min: 120_000, max: 250_000 }
] as const
const ASK_CHARS = 1_500
const ITEM_CHARS = 2_000
/** The longest message the judge may send a chat. */
export const MESSAGE_CHARS = 1_200

/** What the judge reads of one chat. The signals are the rules' findings (foreman.ts, plan.ts), as the judge's inputs. */
export interface JudgeBrief {
  id: string
  title: string
  source: string
  status: string
  /** What the chat was asked to do: its first person message, trimmed. */
  ask: string
  /** The last transcript items, trimmed to this step's budget (CONTEXT_STEPS). */
  recent: string
  /** How much of the transcript `recent` holds, and at which step; `more` when a later step would read more of it. */
  read: { chars: number; of: number; step: number; more: boolean }
  /** Minutes since the person's last message (or the first item), null when there is none. */
  workingMinutes: number | null
  /** Rule findings in words: spinning, hung, stalled, error, the question or NEED line, and minutes since a person wrote. */
  signals: string[]
  notesThisHour: number
  continuesThisHour: number
}

/** One call to the model: what it answered, and the model id the SDK reported for it. */
export interface JudgeCall {
  text: string
  resolved: string | null
}

export interface JudgeRequest {
  brief: JudgeBrief
  system: string
  prompt: string
  /** The `orchestratorModel` setting: an alias or a full id. */
  model: string
  /** The Claude config folder of the account the call signs in with; null is Desk's default ~/.claude login. */
  configDir: string | null
  signal: AbortSignal
}

/** Asks the model. The real one is sdkAskModel; tests inject a fake so that no model is reached. */
export type AskModel = (req: JudgeRequest) => Promise<JudgeCall>

export interface Judgment {
  verdict: OrchestratorVerdict
  message: string
  why: string
}

export type ParseResult = { ok: true; judgment: Judgment } | { ok: false; error: string }

/** How much of the transcript the deciding call read (the last step's brief). */
export type JudgeRead = JudgeBrief['read']

export type JudgeResult =
  | { ok: true; judgment: Judgment; resolved: string | null; read: JudgeRead }
  | { ok: false; error: string; resolved: string | null; read: JudgeRead | null }

export const JUDGE_INSTRUCTIONS = `You are the orchestrator of AgentHydra, the owner's manager for their running Claude Code chats. You read ONE chat: what it was asked to do, its latest transcript, how long it has been working, and the rule signals a watcher computed. Decide its next move.

Answer with ONE JSON object and nothing else, no code fence:
{"verdict": "fine" | "nudge" | "continue" | "leave" | "more", "message": string, "why": string}

- fine: the work is moving. Send nothing: message "".
- nudge: it is working but going nowhere: repeating a failing step, stuck in a call, drifting from its task. message is one short check-in note to send it, saying what to change.
- continue: its last turn stopped on an error. message tells it to carry on from where it stopped and not redo finished steps.
- leave: only a person can move it: a permission, a plan to approve, a question only the owner answers, a usage limit, or anything you cannot safely move. message "".
- more: only when the brief says a longer slice is available and you cannot tell from this one. message "". You are asked again with more of the transcript.

Rules: never invent the owner's answers or decisions; never send a chat to do more than its own task; keep message plain text under ${MESSAGE_CHARS} characters. why is one sentence for the owner, saying what you saw.`

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** One transcript item as one line for the judge; thinking and anything without words is left out. */
function itemLine(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return `Person: ${cut(item.text, ITEM_CHARS)}`
    case 'note':
      return `Note from ${item.from}: ${cut(item.text, ITEM_CHARS)}`
    case 'assistant_text':
      return `Assistant: ${cut(item.text, ITEM_CHARS)}`
    case 'tool_use':
      return `Tool ${item.name} (${item.status}): ${cut(JSON.stringify(item.input), 600)}${item.result ? ` -> ${cut(item.result.text, 600)}` : ''}`
    case 'question':
      return `Question for the person (${item.state}): ${cut(item.questions.map((q) => q.question).join(' / '), 600)}`
    case 'permission':
      return `Permission asked for ${item.toolName} (${item.state})`
    case 'thinking':
      return ''
    default:
      return item.kind
  }
}

/** The whole transcript's length as the judge would read it, which the steps' shares are taken of. */
export function transcriptChars(items: readonly TranscriptItem[]): number {
  let n = 0
  for (const item of items) {
    const line = itemLine(item)
    if (line) n += line.length + 1
  }
  return n
}

/** Characters step `step` reads of a transcript `total` long: its share, held within its floor and cap. */
export function stepBudget(step: number, total: number): number {
  const s = CONTEXT_STEPS[Math.min(step, CONTEXT_STEPS.length - 1)]!
  return Math.min(s.max, Math.max(s.min, Math.round(total * s.share)))
}

/** The last items as lines, oldest first, within `budget` characters: the newest ones are kept. */
export function recentText(items: readonly TranscriptItem[], budget = JUDGE_CHARS): string {
  const lines: string[] = []
  let used = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const line = itemLine(items[i]!)
    if (!line) continue
    if (used + line.length + 1 > budget) break
    lines.unshift(line)
    used += line.length + 1
  }
  return lines.join('\n') || '(no transcript yet)'
}

/** The first person message: what the chat was asked to do. */
export function askOf(items: readonly TranscriptItem[]): string {
  const first = items.find((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user')
  return first ? cut(first.text.trim(), ASK_CHARS) : '(no message from the person in the transcript)'
}

/** The user message the judge gets: the brief, in plain text. */
export function promptOf(brief: JudgeBrief): string {
  return [
    `Chat "${brief.title}" (id ${brief.id}), run by ${brief.source}, status ${brief.status}.`,
    '',
    'What it was asked to do (its first message):',
    '"""',
    brief.ask,
    '"""',
    '',
    `Working for: ${brief.workingMinutes === null ? 'unknown' : `${brief.workingMinutes} min`}`,
    `Rule signals: ${brief.signals.length ? brief.signals.join('; ') : 'none'}`,
    `Already this hour: ${brief.notesThisHour} check-in note(s) sent to it, ${brief.continuesThisHour} continue(s).`,
    '',
    `You are reading the newest ${brief.read.chars} of its ${brief.read.of} transcript characters (step ${brief.read.step + 1} of ${CONTEXT_STEPS.length}). ${
      brief.read.more ? 'A longer slice is available: answer "more" only if you cannot tell from this one.' : 'No longer slice is available: do not answer "more".'
    }`,
    '',
    'Its latest transcript, oldest first:',
    '"""',
    brief.recent,
    '"""',
    '',
    'Answer with the one JSON object.'
  ].join('\n')
}

/** The judge's answer, read strictly: exactly the three fields, a known verdict, and a message where one must be sent.
 *  "more" (a longer slice, please) is a verdict only while `moreAllowed`; it comes back as `{ more: true }`. */
export function parseJudgment(text: string, moreAllowed = false): ParseResult | { ok: true; more: true } {
  const fail = (error: string): ParseResult => ({ ok: false, error })
  let value: unknown
  try {
    value = JSON.parse(text.trim())
  } catch {
    return fail('the judge answered something that is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('the judge answered something other than one JSON object')
  const fields = Object.keys(value).sort().join(',')
  if (fields !== 'message,verdict,why') return fail(`the judge's object has the wrong fields (${fields || 'none'})`)
  const { verdict, message, why } = value as Record<string, unknown>
  if (verdict === 'more') return moreAllowed ? { ok: true, more: true } : fail('the judge asked for more of a transcript it had read in full')
  if (!(ORCHESTRATOR_VERDICTS as readonly unknown[]).includes(verdict)) return fail(`the judge's verdict is not one of ${ORCHESTRATOR_VERDICTS.join(', ')}`)
  if (typeof message !== 'string' || typeof why !== 'string') return fail("the judge's message and why must be strings")
  if (!why.trim()) return fail("the judge's why is empty")
  if (message.length > MESSAGE_CHARS) return fail(`the judge's message is longer than ${MESSAGE_CHARS} characters`)
  const sends = verdict === 'nudge' || verdict === 'continue'
  if (sends && !message.trim()) return fail(`a ${verdict} needs a message to send`)
  return { ok: true, judgment: { verdict: verdict as OrchestratorVerdict, message: sends ? message.trim() : '', why: why.trim() } }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200)

/** One call: asks the model within `timeoutMs`, and reads its answer. Throws on a failed or late call. */
async function askOnce(brief: JudgeBrief, model: string, ask: AskModel, timeoutMs: number, configDir: string | null): Promise<JudgeCall> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const timedOut = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), { once: true }))
  try {
    return await Promise.race([ask({ brief, system: JUDGE_INSTRUCTIONS, prompt: promptOf(brief), model, configDir, signal: abort.signal }), timedOut])
  } finally {
    clearTimeout(timer)
    abort.abort() // a call still running after its answer or its timeout is stopped
  }
}

/** One judgment: step 0's brief first, and the next step's longer slice each time the model answers "more" while one is
 *  available (CONTEXT_STEPS). Each call has `timeoutMs`. Never throws. */
export async function judgeChat(
  briefAt: (step: number) => JudgeBrief,
  model: string,
  ask: AskModel,
  timeoutMs = JUDGE_TIMEOUT_MS,
  configDir: string | null = null
): Promise<JudgeResult> {
  let resolved: string | null = null
  let read: JudgeRead | null = null
  try {
    for (let step = 0; step < CONTEXT_STEPS.length; step++) {
      const brief = briefAt(step)
      read = brief.read
      const call = await askOnce(brief, model, ask, timeoutMs, configDir)
      resolved = call.resolved ?? resolved
      const parsed = parseJudgment(call.text, brief.read.more && step < CONTEXT_STEPS.length - 1)
      if (!parsed.ok) return { ok: false, error: parsed.error, resolved, read }
      if ('judgment' in parsed) return { ok: true, judgment: parsed.judgment, resolved, read }
    }
    return { ok: false, error: 'the judge asked for more after the last step', resolved, read }
  } catch (err) {
    return { ok: false, error: errorText(err), resolved, read }
  }
}

/** The real judge: one turn of the Agent SDK on Desk's own login, with no tools, no MCP servers and no permission prompts. */
export function sdkAskModel(cwd: string, binary: () => string | null = () => null): AskModel {
  return async (req) => {
    const abort = new AbortController()
    req.signal.addEventListener('abort', () => abort.abort(), { once: true })
    // The account's own login, as a chat's engine runs (chat-runtime.ts): the default ~/.claude one's token expires.
    const env: Record<string, string | undefined> = { ...process.env }
    if (req.configDir) env.CLAUDE_CONFIG_DIR = req.configDir
    else delete env.CLAUDE_CONFIG_DIR
    const options: Options = {
      model: req.model,
      systemPrompt: req.system,
      cwd,
      env: pinHaikuModel(env),
      tools: [],
      allowedTools: [],
      canUseTool: async () => ({ behavior: 'deny', message: 'The orchestrator judge uses no tools.' }),
      mcpServers: {},
      settingSources: [],
      maxTurns: 1,
      permissionMode: 'default',
      persistSession: false,
      abortController: abort,
      ...(binary() ? { pathToClaudeCodeExecutable: binary()! } : {})
    }
    let text: string | null = null
    let resolved: string | null = null
    let error = 'the judge gave no answer'
    for await (const m of sdkQuery({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
      if (m.type === 'system' && m.subtype === 'init') resolved = m.model
      if (m.type !== 'result') continue
      if (m.subtype === 'success' && !m.is_error) text = m.result
      else error = m.subtype === 'success' ? String(m.result).slice(0, 200) || 'the judge answered with an error' : m.subtype
    }
    if (text === null) throw new Error(error)
    return { text, resolved }
  }
}
