<script setup lang="ts">
// The Tokens cell of the CLI and desktop tables: the signed-in account's figure for the chosen
// span (the sum), the four kinds on hover. Figures come from core/account-tokens.ts.
import type { AccountTokens } from '@agenthydra/server/types'
import { formatTokens } from '@/lib/climayte-status'
import { partsFor, type TokenWindow } from '@/lib/token-window'
import IconTooltip from '@/shell/IconTooltip.vue'

const props = defineProps<{ tokens?: AccountTokens | null; window: TokenWindow }>()
const parts = () => (props.tokens ? partsFor(props.tokens, props.window) : null)
</script>

<template>
  <IconTooltip
    v-if="parts()"
    :label="$t('cliInstances.tokensLabel', { total: parts()!.total.toLocaleString() })"
    :description="
      $t('cliInstances.tokensBreakdown', {
        output: formatTokens(parts()!.output),
        input: formatTokens(parts()!.input),
        cacheRead: formatTokens(parts()!.cacheRead),
        cacheWrite: formatTokens(parts()!.cacheWrite),
      })
    "
    :detail="$t('cliInstances.tokensSource')"
  >
    <span class="font-medium tabular-nums">{{ formatTokens(parts()!.total) }}</span>
  </IconTooltip>
  <span v-else class="text-xs text-muted-foreground">—</span>
</template>
