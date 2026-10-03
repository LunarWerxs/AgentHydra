// web/src/lib/token-window.ts — which span the Tokens column shows, and the figures for it.
import type { AccountTokens, TokenParts } from '@agenthydra/server/types'

export type TokenWindow = '5h' | 'week' | 'total'
export const TOKEN_WINDOWS: readonly TokenWindow[] = ['5h', 'week', 'total']

export function partsFor(tokens: AccountTokens, window: TokenWindow): TokenParts {
  return window === '5h' ? tokens.fiveHour : window === 'week' ? tokens.week : tokens.total
}

/** The figures for one span, or null when the account's tokens are not known (yet). */
export function tokenPartsFor(
  tokens: AccountTokens | null | undefined,
  window: TokenWindow,
): TokenParts | null {
  return tokens ? partsFor(tokens, window) : null
}
