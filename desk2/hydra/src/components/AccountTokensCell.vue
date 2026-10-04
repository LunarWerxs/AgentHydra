<script setup lang="ts">
// The Tokens cell of the CLI and desktop tables: the signed-in account's figure for the span the
// table's switch has chosen (the sum), the four kinds on hover. Figures come from
// the analytics kit (kit/account-windows.ts); the row model carries the chosen span's parts.
import { formatTokens } from '@/lib/climayte-status'
import type { InstanceRowModel } from '@/lib/instance-table'
import IconTooltip from '@/shell/IconTooltip.vue'

defineProps<{ row: InstanceRowModel }>()
</script>

<template>
  <IconTooltip
    v-if="row.tokens"
    :label="$t('cliInstances.tokensLabel', { total: row.tokens.total.toLocaleString() })"
    :description="
      $t('cliInstances.tokensBreakdown', {
        output: formatTokens(row.tokens.output),
        input: formatTokens(row.tokens.input),
        cacheRead: formatTokens(row.tokens.cacheRead),
        cacheWrite: formatTokens(row.tokens.cacheWrite),
      })
    "
    :detail="$t('cliInstances.tokensSource')"
  >
    <span class="font-medium tabular-nums">{{ formatTokens(row.tokens.total) }}</span>
  </IconTooltip>
  <span v-else class="text-xs text-muted-foreground">—</span>
</template>
