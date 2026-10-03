// web/src/lib/token-window.ts — which span the Tokens column shows, and the figures for it.
import type { AccountTokens, TokenParts } from '@agenthydra/server/types'

export type TokenWindow = '5h' | 'week' | 'total'
export const TOKEN_WINDOWS: readonly TokenWindow[] = ['5h', 'week', 'total']

export function partsFor(tokens: AccountTokens, window: TokenWindow): TokenParts {
  return window === '5h' ? tokens.fiveHour : window === 'week' ? tokens.week : tokens.total
}
