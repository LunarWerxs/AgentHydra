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
/** The transcript the judge reads: the last items, trimmed to about this many characters. */
export const JUDGE_CHARS = 12_000
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
  /** The last transcript items, trimmed to JUDGE_CHARS. */
  recent: string
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

export type JudgeResult = { ok: true; judgment: Judgment; resolved: string | null } | { ok: false; error: string; resolved: string | null }

export const JUDGE_INSTRUCTIONS = `You are the orchestrator of AgentHydra, the owner's manager for their running Claude Code chats. You read ONE chat: what it was asked to do, its latest transcript, how long it has been working, and the rule signals a watcher computed. Decide its next move.

Answer with ONE JSON object and nothing else, no code fence:
{"verdict": "fine" | "nudge" | "continue" | "leave", "message": string, "why": string}

- fine: the work is moving. Send nothing: message "".
- nudge: it is working but going nowhere: repeating a failing step, stuck in a call, drifting from its task. message is one short check-in note to send it, saying what to change.
- continue: its last turn stopped on an error. message tells it to carry on from where it stopped and not redo finished steps.
- leave: only a person can move it: a permission, a plan to approve, a question only the owner answers, a usage limit, or anything you cannot safely move. message "".

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
    'Its latest transcript, oldest first:',
    '"""',
    brief.recent,
    '"""',
    '',
    'Answer with the one JSON object.'
  ].join('\n')
}

/** The judge's answer, read strictly: exactly the three fields, a known verdict, and a message where one must be sent. */
export function parseJudgment(text: string): ParseResult {
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
  if (!(ORCHESTRATOR_VERDICTS as readonly unknown[]).includes(verdict)) return fail(`the judge's verdict is not one of ${ORCHESTRATOR_VERDICTS.join(', ')}`)
  if (typeof message !== 'string' || typeof why !== 'string') return fail("the judge's message and why must be strings")
  if (!why.trim()) return fail("the judge's why is empty")
  if (message.length > MESSAGE_CHARS) return fail(`the judge's message is longer than ${MESSAGE_CHARS} characters`)
  const sends = verdict === 'nudge' || verdict === 'continue'
  if (sends && !message.trim()) return fail(`a ${verdict} needs a message to send`)
  return { ok: true, judgment: { verdict: verdict as OrchestratorVerdict, message: sends ? message.trim() : '', why: why.trim() } }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200)

/** One judgment: asks the model within JUDGE_TIMEOUT_MS (or `timeoutMs`), then reads its answer. Never throws. */
export async function judgeChat(brief: JudgeBrief, model: string, ask: AskModel, timeoutMs = JUDGE_TIMEOUT_MS, configDir: string | null = null): Promise<JudgeResult> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const timedOut = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), { once: true }))
  try {
    const call = await Promise.race([ask({ brief, system: JUDGE_INSTRUCTIONS, prompt: promptOf(brief), model, configDir, signal: abort.signal }), timedOut])
    const parsed = parseJudgment(call.text)
    return parsed.ok ? { ok: true, judgment: parsed.judgment, resolved: call.resolved } : { ok: false, error: parsed.error, resolved: call.resolved }
  } catch (err) {
    return { ok: false, error: errorText(err), resolved: null }
  } finally {
    clearTimeout(timer)
    abort.abort() // a call still running after its answer or its timeout is stopped
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
