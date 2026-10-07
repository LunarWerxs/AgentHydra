// The model menu (SPEC REST `GET /api/models`) and the slash command fallback. A live runtime's
// supportedModels() / supportedCommands() win; these static lists answer while no chat is running.
// The model order is the real Claude Desktop menu (docs/reference/real/DESIGN.md "Model").

import type { ModelInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { ModelChoice, SlashCommandInfo } from '@shared/protocol'
import { HAIKU_PIN_MODEL, OLD_HAIKU } from './haiku-pin'

/** The value that means "the account's default model" (ChatSummary.model null). */
export const ACCOUNT_DEFAULT_MODEL = 'default'

export const STATIC_MODELS: ModelChoice[] = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { value: ACCOUNT_DEFAULT_MODEL, label: 'Account default' },
]

/** Claude Code's built-in commands that work in an SDK session, for the `/` menu of a closed chat. */
export const STATIC_COMMANDS: SlashCommandInfo[] = [
  { name: 'compact', description: 'Clear the conversation history but keep a summary in context', argumentHint: '<optional instructions>' },
  { name: 'context', description: 'Show the current context usage' },
  { name: 'cost', description: 'Show the total cost and duration of this session' },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
  { name: 'review', description: 'Review a pull request' },
  { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch' },
  { name: 'pr-comments', description: 'Get comments from a GitHub pull request' },
  { name: 'release-notes', description: 'View release notes' },
  { name: 'todos', description: 'List the current todo items' },
]

/** ChatSummary.model from what a client sent: '' and 'default' mean the account default (null). */
export function normalizeModel(model: string | null | undefined): string | null {
  if (model == null) return null
  const m = model.trim()
  return m === '' || m === ACCOUNT_DEFAULT_MODEL ? null : m
}

/** A live runtime's model menu, without Haiku 4.5 or older (owner, 2026-10-07: never Haiku 4.5), and with
 *  Haiku 5.5 by id when the runtime does not offer it. The bare `haiku` alias goes too: its label names
 *  whatever the CLI build ships, which can read Haiku 4.5 though the pinned alias runs Haiku 5.5. */
export function modelChoicesFrom(models: ModelInfo[]): ModelChoice[] {
  const choices = models
    .filter((m) => m && typeof m.value === 'string' && m.value.toLowerCase() !== 'haiku' && !OLD_HAIKU.test(m.value))
    .map((m) => ({ value: m.value, label: m.displayName || m.value }))
  if (!choices.some((c) => /haiku-[5-9]/i.test(c.value))) choices.push({ value: HAIKU_PIN_MODEL, label: 'Haiku 5.5' })
  return choices
}

export function commandInfosFrom(commands: SlashCommand[]): SlashCommandInfo[] {
  return commands
    .filter((c) => c && typeof c.name === 'string')
    .map((c) => {
      const info: SlashCommandInfo = { name: c.name.replace(/^\//, ''), description: c.description ?? '' }
      if (c.argumentHint) info.argumentHint = c.argumentHint
      return info
    })
}
