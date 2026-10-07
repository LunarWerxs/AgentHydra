// server/src/core/haiku-pin.ts: Claude Code's `haiku` alias pinned to Haiku 5.5 in every CLI
// process AgentHydra starts.
//
// WHY (owner, 2026-10-07: "never use Haiku 4.5"). Claude Code makes its own small-model calls
// (titles, summaries, the Explore agent) on its `haiku` alias, and the CLIs here resolved that to
// Haiku 4.5: 11,884 of 97,974 requests on CliMayte's CLI instances in the 7 days before were
// `claude-haiku-4-5-20251001`. ANTHROPIC_DEFAULT_HAIKU_MODEL is the CLI's own setting for what the
// alias runs.

export const HAIKU_PIN_MODEL = 'claude-haiku-5-5'

/** A Haiku 4.5 or older id (`claude-haiku-4-5-20251001`, `claude-3-5-haiku-20241022`). */
export const OLD_HAIKU = /haiku-[1-4](?!\d)|claude-[1-3](?:-\d)?-haiku/i

/** Sets ANTHROPIC_DEFAULT_HAIKU_MODEL on a child process's env to Haiku 5.5, unless it already
 *  names a newer model there. One naming Haiku 4.5 or older is replaced: that is the model this
 *  is here to keep out. Returns the same object. */
export function pinHaikuModel(env: Record<string, string>): Record<string, string> {
  const named = env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim()
  if (!named || OLD_HAIKU.test(named)) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = HAIKU_PIN_MODEL
  return env
}
