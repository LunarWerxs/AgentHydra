// Claude Code's `haiku` alias pinned to Haiku 5.5 in every Claude Code process Desk starts
// (owner, 2026-10-07: "never use Haiku 4.5"). Claude Code makes its own small-model calls on that
// alias (titles, summaries, the Explore agent), and an older CLI resolves it to Haiku 4.5.
// ANTHROPIC_DEFAULT_HAIKU_MODEL is the CLI's own setting for what the alias runs. The same rule as
// AgentHydra's server/src/core/haiku-pin.ts, which desk2 cannot import.

export const HAIKU_PIN_MODEL = 'claude-haiku-5-5'

/** A Haiku 4.5 or older id (`claude-haiku-4-5-20251001`, `claude-3-5-haiku-20241022`). */
export const OLD_HAIKU = /haiku-[1-4](?!\d)|claude-[1-3](?:-\d)?-haiku/i

/** A chat's model with Haiku 4.5 or older swapped for Haiku 5.5: a client's pick or a chat saved before
 *  2026-10-07 never runs Haiku 4.5. null (the account default) stays null. */
export function withoutOldHaiku(model: string | null): string | null {
  return model && OLD_HAIKU.test(model) ? HAIKU_PIN_MODEL : model
}

/** Sets ANTHROPIC_DEFAULT_HAIKU_MODEL to Haiku 5.5 unless the env already names a newer model there.
 *  One naming Haiku 4.5 or older is replaced. Returns the same object. */
export function pinHaikuModel(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const named = env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim()
  if (!named || OLD_HAIKU.test(named)) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = HAIKU_PIN_MODEL
  return env
}
