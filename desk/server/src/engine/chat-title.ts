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

/** Makes the title for a chat's first message; null = keep the first-words title. Never throws. */
export type TitleGenerator = (req: TitleRequest) => Promise<string | null>

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

/**
 * One Sonnet query on the chat's own account, low effort, no tools, one turn (never Haiku 4.5). Chosen over
 * HydraSwarm because it needs no extra service, rides the login the chat already has, and is one call.
 */
export function sdkTitleGenerator(queryImpl: QueryImpl, env: Record<string, string | undefined> | undefined, timeoutMs = TITLE_TIMEOUT_MS): TitleGenerator {
  return async (req) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const childEnv: Record<string, string | undefined> = { ...(env ?? process.env) }
      if (req.configDir) childEnv.CLAUDE_CONFIG_DIR = req.configDir
      else delete childEnv.CLAUDE_CONFIG_DIR
      pinHaikuModel(childEnv)
      const q = queryImpl({
        prompt:
          'Title this chat in 3-6 words, sentence case, no quotes, no trailing period. Answer with the title only.\n\nFirst message:\n' +
          req.prompt.slice(0, TITLE_PROMPT_CHARS),
        options: {
          cwd: req.cwd,
          env: childEnv,
          model: 'sonnet',
          effort: 'low',
          tools: [],
          maxTurns: 1,
          settingSources: [],
          persistSession: false,
          abortController: abort,
        },
      })
      let text = ''
      const run = (async () => {
        for await (const m of q) {
          if (m.type === 'result') {
            // A signed-out account answers 'success' with is_error and the error as the result; that is
            // no title (two chats were named 'Failed to authenticate: OAuth session ex...').
            if (m.subtype === 'success' && !m.is_error) text = m.result
            break
          }
        }
      })()
      const timedOut = new Promise<void>((r) => abort.signal.addEventListener('abort', () => r()))
      await Promise.race([run, timedOut])
      if (abort.signal.aborted) {
        void run.catch(() => {})
        return null
      }
      return cleanTitle(text)
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
