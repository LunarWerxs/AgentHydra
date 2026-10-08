// Hydra Desk 2: the colour a CliMayte account is drawn in, in the sidebar: the account on each task line (owner,
// 2026-10-06: "CLImate options get their own icon with accounts and colors"; the badge's dots went on 2026-10-08). AgentHydra's instance palette (hydra/src/lib/instance-appearance.ts COLOR_VALUES)
// without its blue and indigo, which are HSwarm's alone in the sidebar (owner, 2026-10-05: "Only the HSwarm items
// should have blue"), and without the red, green and gray a task line's mark uses for failed, done and queued. Fixed
// values, the same in either theme, as AgentHydra's are. Pure, so the window and the tests share it.

export const ACCOUNT_TONES = [
  'oklch(0.67 0.17 50)', // orange
  'oklch(0.72 0.15 80)', // amber
  'oklch(0.66 0.11 195)', // teal
  'oklch(0.60 0.20 310)', // violet
  'oklch(0.65 0.21 350)' // pink
] as const

/** A stable non-negative hash of a label (FNV-1a), for an account label that is not a number. */
function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * An account's tone by its label ('#68'): by its number, so neighbouring accounts differ and one account keeps its
 * colour on every row; any other label by a hash of it; null for no account (drawn in the text's own colour).
 */
export function accountTone(label: string | null | undefined): string | null {
  const text = label?.trim()
  if (!text) return null
  const num = /^#?(\d+)$/.exec(text)
  const n = num && Number.isSafeInteger(Number(num[1])) ? Number(num[1]) : hash(text)
  return ACCOUNT_TONES[n % ACCOUNT_TONES.length]!
}
