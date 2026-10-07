import type { QueryImpl } from './chat-runtime'
import { pinHaikuModel } from './haiku-pin'

/** What a generated title is made from, and how long the model has (SPEC "Titles"). */
export const TITLE_PROMPT_CHARS = 2000
export const TITLE_TIMEOUT_MS = 20_000

export interface TitleRequest {
  prompt: string
  cwd: string
  /** The account's config folder (null = the default login). */
  configDir: string | null
}

/** Makes the title for a chat's first message; null = keep the first-words title, `failed` then says why. Never throws. */
export type TitleGenerator = (req: TitleRequest, failed?: (why: string) => void) => Promise<string | null>

/** The model's answer as a title: one line, no quotes or trailing period, at most 6 words; null when nothing usable. */
export function cleanTitle(raw: string): string | null {
  const line = raw.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const words = line
    .replace(/^\s*title\s*:\s*/i, '')
    .replace(/["'“”‘’`*#]/g, '')
    .trim()
    .replace(/[.!?:;,\s]+$/, '')
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return null
  const title = words.slice(0, 6).join(' ')
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/** Haiku 5.5 by id, never the `haiku` alias, which an older Claude Code resolves to Haiku 4.5 (owner, 2026-10-07: never use Haiku 4.5). */
export const TITLE_MODEL = 'claude-haiku-5-5'

/**
 * One Haiku 5.5 query on the chat's own account, low effort, no tools, one turn: a one-turn summary is the
 * narrow work Haiku 5.5 is built for, at a fraction of Sonnet's price. Chosen over HydraSwarm because it
 * needs no extra service, rides the login the chat already has, and is one call.
 */
export function sdkTitleGenerator(
  queryImpl: QueryImpl,
  env: Record<string, string | undefined> | undefined,
  timeoutMs = TITLE_TIMEOUT_MS,
  /** Claude Code's binary when Desk has resolved one: a release has no platform package for the SDK to find. */
  binaryPath: () => string | null = () => null,
): TitleGenerator {
  return async (req, failed) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const childEnv: Record<string, string | undefined> = { ...(env ?? process.env) }
      if (req.configDir) childEnv.CLAUDE_CONFIG_DIR = req.configDir
      else delete childEnv.CLAUDE_CONFIG_DIR
      pinHaikuModel(childEnv)
      const binary = binaryPath()
      const q = queryImpl({
        prompt:
          'Title this chat in 3-6 words, sentence case, no quotes, no trailing period. Answer with the title only.\n\nFirst message:\n' +
          req.prompt.slice(0, TITLE_PROMPT_CHARS),
        options: {
          cwd: req.cwd,
          env: childEnv,
          model: TITLE_MODEL,
          effort: 'low',
          tools: [],
          maxTurns: 1,
          settingSources: [],
          persistSession: false,
          abortController: abort,
          ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
        },
      })
      let text = ''
      let error = 'the query ended without a result'
      const run = (async () => {
        for await (const m of q) {
          if (m.type === 'result') {
            // A signed-out account answers 'success' with is_error and the error as the result; that is
            // no title (two chats were named 'Failed to authenticate: OAuth session ex...').
            if (m.subtype === 'success' && !m.is_error) text = m.result
            else error = m.subtype === 'success' ? String(m.result ?? '').slice(0, 200) || 'the model answered with an error' : m.subtype
            break
          }
        }
      })()
      const timedOut = new Promise<void>((r) => abort.signal.addEventListener('abort', () => r()))
      await Promise.race([run, timedOut])
      if (abort.signal.aborted) {
        void run.catch(() => {})
        failed?.(`no answer within ${Math.round(timeoutMs / 1000)}s`)
        return null
      }
      const title = cleanTitle(text)
      if (!title) failed?.(text.trim() ? 'the answer had no usable title' : error)
      return title
    } catch (err) {
      failed?.(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
