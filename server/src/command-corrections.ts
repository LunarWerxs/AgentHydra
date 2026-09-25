/**
 * Recurring command mistakes, mined from the transcripts this daemon already reads.
 *
 * WHY: agents make the same wrong-then-right shell mistake over and over (a flag the tool does not
 * have, a path that is one directory off, `pytest` where only `python -m pytest` exists), and each
 * time the fix is sitting in the transcript two commands later. Nobody reads thousands of sessions
 * to notice that the same correction happened forty times. This walks each session's shell calls in
 * order, pairs a failure with the next similar command that succeeded, names the error, and groups
 * the pairs by error kind and base command with counts, so the recurring ones can be copied into a
 * rules file (e.g. .claude/rules/cli-corrections.md) as evidence instead of hunch.
 *
 * Idea from rtk's `rtk learn` (rtk-ai/rtk, Apache-2.0); written fresh for AgentHydra, no code copied.
 *
 * Read-only and on demand: nothing is stored, nothing is written back, and only a failure whose
 * error text matches one of the kinds below counts. A failing test run followed by a passing one is
 * not a command mistake, and reporting it as one would bury the real corrections.
 */
import { readOpenCodeToolParts } from './opencode-sessions'
import { redactSecrets } from './secrets'
import { streamLines } from './session-search'
import { listTranscriptFiles, type TranscriptFile } from './transcript'
import type {
  CommandErrorKind,
  CorrectionExample,
  CorrectionGroup,
  CorrectionReport,
} from './types'

/** One shell call and how it ended. `output` is what classifies a failure; it is never reported. */
export interface CommandRun {
  command: string
  failed: boolean
  output: string
  ts: number | null
}

export interface CorrectionPair {
  kind: CommandErrorKind
  base: string
  wrong: string
  right: string
  error: string
  ts: number | null
}

/**
 * Error text -> kind, checked in order. Not-found and permission come first because their wording
 * ("not found", "denied") also turns up inside the broader patterns below them.
 */
const ERROR_PATTERNS: Array<[CommandErrorKind, RegExp]> = [
  [
    'command-not-found',
    /command not found|is not recognized as (?:an internal or external command|the name of a cmdlet)|executable file not found|no such command|unknown command|is not a [\w-]+ command|: not found\b/i,
  ],
  [
    'permission-denied',
    /permission denied|access (?:is )?denied|\bEACCES\b|\bEPERM\b|operation not permitted/i,
  ],
  [
    'unknown-flag',
    /unknown (?:option|flag|switch|argument)|unrecognized (?:option|arguments?)|invalid (?:option|flag|switch)|illegal option|no such option|unexpected argument|cannot be found that matches parameter name/i,
  ],
  [
    'missing-arg',
    /missing (?:required )?(?:argument|operand|parameter|value)|requires (?:an? )?(?:argument|value|parameter)|the following arguments are required|not enough arguments|expected \d+ arguments?|argument .{1,40} is required/i,
  ],
  [
    'wrong-path',
    /no such file or directory|cannot find (?:the )?(?:path|file)|could not find (?:the )?(?:file|path)|path not found|not a directory|cannot access '|\bENOENT\b|pathspec .{1,200} did not match|does not exist/i,
  ],
]

/** Readable labels, used by the rules file. The UI keeps its own translated copy. */
const KIND_LABEL: Record<CommandErrorKind, string> = {
  'unknown-flag': 'unknown flag',
  'missing-arg': 'missing argument',
  'wrong-path': 'wrong path',
  'command-not-found': 'command not found',
  'permission-denied': 'permission denied',
}

/** Programs whose second word is the command that was actually run: `git log` and `git push`
 *  fail in unrelated ways, so grouping them under `git` would mix mistakes that share nothing. */
const SUBCOMMAND_TOOLS = new Set([
  'git',
  'gh',
  'bun',
  'bunx',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'cargo',
  'go',
  'docker',
  'kubectl',
  'pip',
  'uv',
  'dotnet',
  'az',
  'aws',
  'gcloud',
])

/** Words that run the command after them rather than being it. */
const PREFIX_WORDS = new Set(['sudo', 'env', 'time', 'command', 'exec', 'nohup'])

/** How far past a failure the fix may be. Further than this and the two are rarely one attempt. */
const LOOKAHEAD = 6
/** Shared-token share below which the "fix" is a different command, not a corrected one. */
const MIN_SIMILARITY = 0.3
const MAX_OUTPUT_CHARS = 4000
const MAX_COMMAND_CHARS = 300
const MAX_ERROR_CHARS = 160
const MAX_EXAMPLES = 5
const MAX_GROUPS = 100

/** Shell tool names across the stores: Claude's Bash/PowerShell, Codex's shell family, OpenCode's bash. */
const CLAUDE_SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const CODEX_SHELL_TOOLS = new Set(['shell', 'shell_command', 'exec_command', 'local_shell'])
const OPENCODE_SHELL_TOOLS = new Set(['bash', 'shell'])

export function classifyCommandError(output: string): CommandErrorKind | null {
  for (const [kind, re] of ERROR_PATTERNS) if (re.test(output)) return kind
  return null
}

function words(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/**
 * The command a mistake belongs to: the program (basename, lower case, no .exe), plus its
 * subcommand for tools in SUBCOMMAND_TOOLS. A leading `cd <dir> &&`, env assignments and
 * sudo-style prefixes are skipped, since agents wrap almost every command in them.
 */
export function baseCommand(command: string): string {
  let rest = command.trim()
  const cdPrefix = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/
  while (cdPrefix.test(rest)) rest = rest.replace(cdPrefix, '')
  const w = words(rest)
  let i = 0
  while (i < w.length && (PREFIX_WORDS.has(w[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]))) i++
  if (i >= w.length) return ''
  const program = (w[i].split(/[\\/]/).pop() ?? '')
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1)$/, '')
  if (!program) return ''
  const sub = w[i + 1]
  if (SUBCOMMAND_TOOLS.has(program) && sub && /^[a-z][a-z0-9:_-]*$/.test(sub))
    return `${program} ${sub}`
  return program
}

/** Token overlap (Jaccard) of two commands: 1 for the same words, 0 for none in common. */
export function commandSimilarity(a: string, b: string): number {
  const x = new Set(words(a))
  const y = new Set(words(b))
  if (x.size === 0 && y.size === 0) return 1
  let shared = 0
  for (const t of x) if (y.has(t)) shared++
  return shared / (x.size + y.size - shared)
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The line of the output that named the error, falling back to its first meaningful line. */
function errorLine(output: string, kind: CommandErrorKind): string {
  const re = ERROR_PATTERNS.find(([k]) => k === kind)?.[1]
  const lines = output.split(/\r?\n/).map((l) => l.trim())
  const hit =
    (re && lines.find((l) => re.test(l))) ??
    lines.find((l) => l && !/^exit code:? -?\d+$/i.test(l)) ??
    ''
  return hit
}

/**
 * Pair each classified failure with the command that fixed it.
 *
 * The fix is the next command within LOOKAHEAD that has the same base and succeeded with different
 * text. A same-base command that failed again ends the search: that attempt gets its own pairing
 * when the loop reaches it. For command-not-found the base itself was the mistake (`pytest` ->
 * `python -m pytest`), so there the next similar command counts whatever it starts with.
 */
export function findCorrections(runs: CommandRun[]): CorrectionPair[] {
  const out: CorrectionPair[] = []
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    if (!r.failed) continue
    const kind = classifyCommandError(r.output)
    if (!kind) continue
    const base = baseCommand(r.command)
    if (!base) continue
    const wrong = squash(r.command)
    for (let j = i + 1; j < runs.length && j <= i + LOOKAHEAD; j++) {
      const n = runs[j]
      const similarity = commandSimilarity(r.command, n.command)
      const related =
        kind === 'command-not-found'
          ? similarity >= MIN_SIMILARITY
          : baseCommand(n.command) === base
      if (!related) continue
      const right = squash(n.command)
      if (!n.failed && right !== wrong && similarity >= MIN_SIMILARITY)
        out.push({ kind, base, wrong, right, error: errorLine(r.output, kind), ts: n.ts ?? r.ts })
      break
    }
  }
  return out
}

function clip(text: string, max: number): string {
  const clean = redactSecrets(squash(text)).text
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** Group pairs by (kind, base), most frequent first, each with its most frequent distinct pairs. */
export function groupCorrections(
  pairs: Array<CorrectionPair & { sessionId: string }>,
): CorrectionGroup[] {
  type Acc = {
    group: CorrectionGroup
    sessions: Set<string>
    examples: Map<string, { ex: CorrectionExample; sessions: Set<string> }>
  }
  const groups = new Map<string, Acc>()
  for (const p of pairs) {
    const key = `${p.kind}\u0000${p.base}`
    let acc = groups.get(key)
    if (!acc) {
      acc = {
        group: { kind: p.kind, base: p.base, count: 0, sessions: 0, lastTs: null, examples: [] },
        sessions: new Set(),
        examples: new Map(),
      }
      groups.set(key, acc)
    }
    acc.group.count++
    acc.sessions.add(p.sessionId)
    if (p.ts !== null && (acc.group.lastTs === null || p.ts > acc.group.lastTs))
      acc.group.lastTs = p.ts
    const exKey = `${p.wrong}\u0000${p.right}`
    let ex = acc.examples.get(exKey)
    if (!ex) {
      ex = {
        ex: {
          wrong: clip(p.wrong, MAX_COMMAND_CHARS),
          right: clip(p.right, MAX_COMMAND_CHARS),
          error: clip(p.error, MAX_ERROR_CHARS),
          count: 0,
          sessions: 0,
          lastTs: null,
        },
        sessions: new Set(),
      }
      acc.examples.set(exKey, ex)
    }
    ex.ex.count++
    ex.sessions.add(p.sessionId)
    if (p.ts !== null && (ex.ex.lastTs === null || p.ts > ex.ex.lastTs)) ex.ex.lastTs = p.ts
  }
  const out: CorrectionGroup[] = []
  for (const acc of groups.values()) {
    acc.group.sessions = acc.sessions.size
    acc.group.examples = [...acc.examples.values()]
      .map(({ ex, sessions }) => ({ ...ex, sessions: sessions.size }))
      .sort((a, b) => b.count - a.count || (b.lastTs ?? 0) - (a.lastTs ?? 0))
      .slice(0, MAX_EXAMPLES)
    out.push(acc.group)
  }
  return out
    .sort((a, b) => b.count - a.count || (b.lastTs ?? 0) - (a.lastTs ?? 0))
    .slice(0, MAX_GROUPS)
}

/** Inline code that survives a backtick inside the command. */
function code(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
}

/** The groups as a rules file an agent reads on start, most frequent mistake first. */
export function renderCorrectionRules(groups: CorrectionGroup[]): string {
  const lines = [
    '# CLI corrections',
    '',
    'Commands that failed and were then fixed, mined by AgentHydra from local transcripts. Most frequent first.',
  ]
  for (const g of groups) {
    const times = g.count === 1 ? '1 time' : `${g.count} times`
    const sessions = g.sessions === 1 ? '1 session' : `${g.sessions} sessions`
    lines.push('', `## ${code(g.base)}: ${KIND_LABEL[g.kind]} (${times}, ${sessions})`, '')
    for (const ex of g.examples) {
      const error = ex.error ? ` - error: ${ex.error}` : ''
      lines.push(`- Not ${code(ex.wrong)}, use ${code(ex.right)}${error}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function parseTs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
}

/**
 * Claude Code transcript lines -> shell runs. The call and its result are separate records joined
 * by tool_use_id; a call whose result never arrived is dropped, since its outcome is unknown.
 */
export class ClaudeCommandReader {
  private runs: Array<CommandRun & { done: boolean }> = []
  private byId = new Map<string, CommandRun & { done: boolean }>()

  push(line: string): void {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return
    let ev: { timestamp?: unknown; message?: { content?: unknown } }
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    const content = ev.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_use' && CLAUDE_SHELL_TOOLS.has(block.name)) {
        const command = block.input?.command
        if (typeof command !== 'string' || typeof block.id !== 'string') continue
        const run = { command, failed: false, output: '', ts: parseTs(ev.timestamp), done: false }
        this.runs.push(run)
        this.byId.set(block.id, run)
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const run = this.byId.get(block.tool_use_id)
        if (!run) continue
        run.failed = block.is_error === true
        run.output = resultText(block.content).slice(0, MAX_OUTPUT_CHARS)
        run.done = true
      }
    }
  }

  result(): CommandRun[] {
    return this.runs.filter((r) => r.done).map(({ done: _done, ...r }) => r)
  }
}

/** A Codex shell call's command line: argv joined, with a `bash -lc` / `pwsh -Command` wrapper unwrapped. */
function codexCommand(args: unknown): string | null {
  let a = args
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch {
      return null
    }
  }
  if (!a || typeof a !== 'object') return null
  const raw =
    (a as { cmd?: unknown; command?: unknown }).cmd ?? (a as { command?: unknown }).command
  if (typeof raw === 'string') return raw
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string')) return null
  const shell = (raw[0] ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (
    raw.length >= 3 &&
    /^(?:ba|z)?sh$|^pwsh|^powershell/.test(shell) &&
    /^-(?:l?c|command)$/i.test(raw[1])
  )
    return raw.slice(2).join(' ')
  return raw.join(' ')
}

/** A Codex tool output's exit code and text. Older rollouts wrap it as JSON with metadata; newer
 *  ones write plain text with an "Exit code" / "Process exited with code" line. */
function codexOutcome(output: unknown): { exit: number | null; text: string } {
  let text = typeof output === 'string' ? output : resultText(output)
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      const exit = parsed.metadata?.exit_code
      if (typeof parsed.output === 'string') text = parsed.output
      if (typeof exit === 'number') return { exit, text }
    }
  } catch {
    // plain text output
  }
  const m = /(?:process exited with code|exit code:?)\s*(-?\d+)/i.exec(text)
  return { exit: m ? Number(m[1]) : null, text }
}

/** Codex rollout lines -> shell runs, joined by call_id. An output with no exit code is dropped. */
export class CodexCommandReader {
  private runs: Array<CommandRun & { done: boolean }> = []
  private byId = new Map<string, CommandRun & { done: boolean }>()

  push(line: string): void {
    if (!line.includes('"function_call')) return
    let ev: { type?: string; timestamp?: unknown; payload?: Record<string, any> }
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    const p = ev.payload
    if (ev.type !== 'response_item' || !p || typeof p.call_id !== 'string') return
    if (p.type === 'function_call' && CODEX_SHELL_TOOLS.has(p.name)) {
      const command = codexCommand(p.arguments)
      if (!command) return
      const run = { command, failed: false, output: '', ts: parseTs(ev.timestamp), done: false }
      this.runs.push(run)
      this.byId.set(p.call_id, run)
    } else if (p.type === 'function_call_output') {
      const run = this.byId.get(p.call_id)
      if (!run) return
      const { exit, text } = codexOutcome(p.output)
      if (exit === null) return
      run.failed = exit !== 0
      run.output = text.slice(0, MAX_OUTPUT_CHARS)
      run.done = true
    }
  }

  result(): CommandRun[] {
    return this.runs.filter((r) => r.done).map(({ done: _done, ...r }) => r)
  }
}

/** OpenCode tool parts -> shell runs. A part still running has no outcome and is skipped. */
export function openCodeCommandRuns(parts: Array<Record<string, any>>): CommandRun[] {
  const out: CommandRun[] = []
  for (const part of parts) {
    if (!OPENCODE_SHELL_TOOLS.has(part.tool)) continue
    const state = part.state && typeof part.state === 'object' ? part.state : {}
    const command = state.input?.command
    if (typeof command !== 'string') continue
    const exit = state.metadata?.exit
    let failed: boolean
    if (state.status === 'error') failed = true
    else if (state.status === 'completed') failed = typeof exit === 'number' && exit !== 0
    else continue
    const output = [state.error, state.output, state.metadata?.output]
      .filter((v) => typeof v === 'string')
      .join('\n')
    const ts = typeof state.time?.start === 'number' ? state.time.start : null
    out.push({ command, failed, output: output.slice(0, MAX_OUTPUT_CHARS), ts })
  }
  return out
}

async function readRuns(
  path: string,
  reader: ClaudeCommandReader | CodexCommandReader,
): Promise<CommandRun[]> {
  for await (const line of streamLines(path)) reader.push(line)
  return reader.result()
}

/**
 * One session's shell runs, one list per file. Claude's subagent transcripts are separate lists:
 * each is its own sequence of attempts, and pairing across them would match unrelated commands.
 * Codex's sibling paths are copies of the same rollout mid-move (see TranscriptFile.siblingPaths),
 * so only the main one is read.
 */
async function sessionRuns(tf: TranscriptFile): Promise<CommandRun[][]> {
  if (tf.source === 'claude') {
    const out: CommandRun[][] = []
    // A sibling with the main file's own name is a copy of this transcript in another folder, not a
    // subagent: reading it too would count every one of its corrections twice.
    const name = (p: string) => p.split(/[\\/]/).pop()
    const main = name(tf.path)
    const paths = [tf.path, ...(tf.siblingPaths ?? []).filter((p) => name(p) !== main)]
    for (const path of paths) {
      try {
        out.push(await readRuns(path, new ClaudeCommandReader()))
      } catch {
        // a subagent file pruned between the index build and now
      }
    }
    return out
  }
  if (tf.source === 'codex') return [await readRuns(tf.path, new CodexCommandReader())]
  if (tf.source === 'opencode')
    return [openCodeCommandRuns(readOpenCodeToolParts(tf.session_id, tf.path))]
  return []
}

const MINED_SOURCES = new Set(['claude', 'codex', 'opencode'])

/**
 * Mine the newest `limit` Claude, Codex and OpenCode sessions under a wall-clock budget.
 *
 * Newest first and bounded for the same reason the analytics warm is: transcripts reach hundreds
 * of megabytes, and a click must not wedge a daemon that is also serving the UI. The report says
 * how much of the store it read.
 */
export async function mineCommandCorrections(
  opts: { limit?: number; budgetMs?: number; files?: TranscriptFile[] } = {},
): Promise<CorrectionReport> {
  const deadline = Date.now() + (opts.budgetMs ?? 15_000)
  const candidates = (opts.files ?? listTranscriptFiles()).filter((f) =>
    MINED_SOURCES.has(f.source),
  )
  const queue = [...candidates]
    .sort((a, b) => b.mtime_ms - a.mtime_ms)
    .slice(0, Math.max(1, opts.limit ?? 200))
  const pairs: Array<CorrectionPair & { sessionId: string }> = []
  let scanned = 0
  let budgetExhausted = false
  for (const tf of queue) {
    if (Date.now() > deadline) {
      budgetExhausted = true
      break
    }
    try {
      for (const runs of await sessionRuns(tf))
        for (const p of findCorrections(runs)) pairs.push({ ...p, sessionId: tf.session_id })
      scanned++
    } catch {
      // A transcript that vanished mid-read costs one session, not the report.
    }
  }
  const groups = groupCorrections(pairs)
  return {
    groups,
    markdown: renderCorrectionRules(groups),
    scanned,
    total: candidates.length,
    budgetExhausted,
  }
}
